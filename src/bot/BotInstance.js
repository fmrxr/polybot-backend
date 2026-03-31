/**
 * BotInstance — Clock-based snipe timing from PolymarketBot.md
 *
 * Key timing insight:
 * - Each 5-min window has a deterministic close time (Unix epoch % 300 == 0)
 * - Bot sleeps until T-10s before window close, then enters polling loop
 * - At T-10s, BTC direction is largely locked in — minimal reversal risk
 * - Loop polls every 2s, fires on confidence OR at T-5s hard deadline
 */

const { GBMSignalEngine } = require('./GBMSignalEngine');
const { BinanceFeed } = require('./BinanceFeed');
const { PolymarketFeed } = require('./PolymarketFeed');
const { ChainlinkFeed } = require('./ChainlinkFeed');
const { decrypt } = require('../services/encryption');
const { pool } = require('../models/db');

const SNIPE_BEFORE_CLOSE_SEC = 10;  // Enter snipe loop T-10s before close
const HARD_DEADLINE_SEC = 5;         // Always trade by T-5s
const POLL_INTERVAL_MS = 2000;       // Poll every 2s in snipe window
const MARKET_REFRESH_MS = 30000;     // Refresh market list every 30s
const RESOLUTION_CHECK_MS = 30000;   // Check resolutions every 30s

class BotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    this.paperTrading = settings.paper_trading !== false;
    this.binance = new BinanceFeed();
    this.chainlink = new ChainlinkFeed();
    this.polymarket = null;
    this.engine = null;
    this.mainTimer = null;
    this.marketRefreshTimer = null;
    this.resolutionTimer = null;
    this.isRunning = false;
    this.openTrades = new Map();
    this.lastWindowTs = null;
    this.lastMarketData = null;
    this.lastMarketRefreshAt = 0;
    this.inSnipeLoop = false;
  }

  async start() {
    // Decrypt private key with explicit error handling
    let privateKey;
    try {
      privateKey = decrypt(this.settings.encrypted_private_key);
    } catch(e) {
      throw new Error(`Failed to decrypt private key — check ENCRYPTION_KEY env var: ${e.message}`);
    }

    this.polymarket = new PolymarketFeed(privateKey);
    this.engine = new GBMSignalEngine({
      kelly_cap: parseFloat(this.settings.kelly_cap),
      max_trade_size: parseFloat(this.settings.max_trade_size),
      min_ev_threshold: parseFloat(this.settings.min_ev_threshold),
      min_prob_diff: parseFloat(this.settings.min_prob_diff),
      direction_filter: this.settings.direction_filter,
      market_prob_min: parseFloat(this.settings.market_prob_min),
      market_prob_max: parseFloat(this.settings.market_prob_max)
    });
    this.engine.onDecision = (d) => this._recordDecision(d);

    await this.binance.connect();

    // Chainlink is non-critical — failures are tolerated
    try {
      await this.chainlink.init();
    } catch(e) {
      this._log('WARN', `Chainlink feed unavailable: ${e.message} — window delta will use Binance price`);
    }

    await this.polymarket.fetchActiveBTCMarkets();

    this.isRunning = true;
    const mode = this.paperTrading ? '📄 PAPER TRADING' : '💰 LIVE TRADING';
    this._log('INFO', `Bot started [${mode}] for user ${this.userId}`);

    // Main loop: check timing every second
    this.mainTimer = setInterval(() => this._tick(), 1000);
    this.marketRefreshTimer = setInterval(() => {
      this.polymarket.fetchActiveBTCMarkets()
        .catch(e => this._log('WARN', `Market refresh failed: ${e.message}`));
    }, MARKET_REFRESH_MS);
    this.resolutionTimer = setInterval(() => this._checkResolutions(), RESOLUTION_CHECK_MS);
  }

  async _tick() {
    if (!this.isRunning || this.inSnipeLoop) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    const windowClose = windowTs + 300;
    const secsToClose = windowClose - nowSec;

    // Update market data snapshot — include Chainlink data for frontend display
    const btcData = this.binance.getMarketData();
    const chainlinkData = this.chainlink.getPriceData();
    if (btcData.price) {
      this.lastMarketData = {
        price: btcData.price,
        vwap: btcData.vwap,
        volatility: btcData.volatility,
        momentum: btcData.momentum,
        ob_imbalance: btcData.obImbalance,
        chainlink_price: chainlinkData?.price || null,
        chainlink_age: chainlinkData?.ageSeconds || null,
        updated_at: new Date().toISOString()
      };
    }

    // Log countdown every 30s so user can see bot is alive
    if (secsToClose % 30 === 0) {
      this._log('INFO', `Window closes in ${secsToClose}s | BTC: $${btcData.price?.toFixed(0) || '?'} | Markets: ${this.polymarket.activeMarkets.length}`);
    }

    if (this.polymarket.activeMarkets.length === 0 && secsToClose <= 60 && nowSec - this.lastMarketRefreshAt >= 10) {
      this.lastMarketRefreshAt = nowSec;
      this.polymarket.fetchActiveBTCMarkets()
        .catch(e => this._log('WARN', `Urgent market refresh failed: ${e.message}`));
    }

    // Enter snipe loop at T-10s
    if (secsToClose <= SNIPE_BEFORE_CLOSE_SEC && windowTs !== this.lastWindowTs) {
      await this._snipeWindow(windowTs, windowClose, btcData);
    }
  }

  async _snipeWindow(windowTs, windowClose, initialBtcData) {
    this.inSnipeLoop = true;

    try {
      // Daily loss limit check
      const dailyResult = await pool.query(
        `SELECT COALESCE(SUM(pnl), 0) as daily_pnl FROM trades WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [this.userId]
      );
      if (parseFloat(dailyResult.rows[0].daily_pnl) <= -Math.abs(this.settings.max_daily_loss)) {
        this._log('WARN', `Daily loss limit reached. Skipping window.`);
        this.lastWindowTs = windowTs;
        return;
      }

      if (!this.polymarket.activeMarkets.length) {
        await this.polymarket.fetchActiveBTCMarkets();
      }

      this.polymarket.activeMarkets.sort((a, b) => (a.windowTs || Infinity) - (b.windowTs || Infinity));

      const getMarketWindowTs = (m) => {
        if (typeof m.windowTs === 'number') return m.windowTs;
        const end = m.endDate || m.endDateIso;
        if (!end) return null;
        const marketClose = Math.floor(new Date(end).getTime() / 1000);
        return marketClose - 300;
      };

      const findWindowMarket = () => this.polymarket.activeMarkets.find(m => {
        const marketWindowTs = getMarketWindowTs(m);
        return marketWindowTs !== null && Math.abs(marketWindowTs - windowTs) <= 5;
      });

      let market = findWindowMarket() || this.polymarket.activeMarkets[0];
      let marketRetryCount = 0;

      while (!market) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secsLeft = windowClose - nowSec;
        if (secsLeft <= 0) break;

        if (marketRetryCount === 0 || marketRetryCount % 2 === 0) {
          this._log('WARN', `No market found yet for window ${windowTs}. Retrying...`);
        }

        await this.polymarket.fetchActiveBTCMarkets();
        market = findWindowMarket() || this.polymarket.activeMarkets[0];
        marketRetryCount += 1;

        if (!market) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!market) {
        this._log('WARN', `T-${SNIPE_BEFORE_CLOSE_SEC}s: No market found for window ${windowTs}`);
        this.lastWindowTs = windowTs;
        return;
      }

      let tokens = [];
      if (Array.isArray(market.tokens)) {
        tokens = market.tokens;
      } else if (market.tokens && typeof market.tokens === 'object') {
        tokens = Object.values(market.tokens).filter(Boolean);
      }

      if (tokens.length === 0 && market.clobTokenIds && typeof this.polymarket._extractClobTokenIds === 'function') {
        const tokenIds = this.polymarket._extractClobTokenIds(market.clobTokenIds);
        tokens = tokenIds.map((id, i) => ({ token_id: id, outcome: i === 0 ? 'Yes' : 'No' }));
      }

      if (tokens.length < 2) {
        this._log('WARN', `Market has no tokens: ${market.question}`);
        this.lastWindowTs = windowTs;
        return;
      }

      this._log('INFO', `🎯 Entering snipe loop | Market: "${(market.question||'?').substring(0,50)}"`);

      // ── SNIPE LOOP: poll every 2s until T-5s hard deadline ──────────────
      let bestSignal = null;
      let bestScore = 0;

      while (true) {
        const nowSec = Math.floor(Date.now() / 1000);
        const secsLeft = windowClose - nowSec;

        if (secsLeft <= 0) break;

        const btcData = this.binance.getMarketData();
        if (!btcData.price) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        // Pass both Binance and Chainlink prices to the signal engine
        const chainlinkData = this.chainlink.getPriceData();
        const signal = this.engine.evaluate({
          currentPrice: btcData.price,
          binancePrice: btcData.price,
          chainlinkPrice: chainlinkData?.price || null,
          priceHistory: btcData.priceHistory || [],
          volumeHistory: btcData.volumeHistory || [],
          timeToResolutionSec: secsLeft
        });

        if (signal) {
          if (Math.abs(signal.score) > Math.abs(bestScore)) {
            bestSignal = signal;
            bestScore = signal.score;
          }

          this._log('INFO', `Snipe check | Score: ${signal.score.toFixed(1)} | Conf: ${(signal.confidence*100).toFixed(0)}% | ${signal.direction} | ${secsLeft}s left`);
          await this._executeTrade(signal, market, tokens, windowTs);
          this.lastWindowTs = windowTs;
          return;
        }

        // Hard deadline: T-5s — use best signal we've seen, or fallback
        if (secsLeft <= HARD_DEADLINE_SEC) {
          const fallback = bestSignal || this._fallbackSignal(btcData);
          if (fallback) {
            this._log('INFO', `⏰ T-5s hard deadline — using best signal: ${fallback.direction} (score: ${fallback.score?.toFixed(1) || '?'})`);
            await this._executeTrade(fallback, market, tokens, windowTs);
          }
          this.lastWindowTs = windowTs;
          return;
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      this.lastWindowTs = windowTs;

    } catch(err) {
      this._log('ERROR', `Snipe loop error: ${err.message}`);
      this.lastWindowTs = windowTs;
    } finally {
      this.inSnipeLoop = false;
    }
  }

  _fallbackSignal(btcData) {
    if (!this.engine.windowOpenPrice || !btcData.price) return null;
    const direction = btcData.price >= this.engine.windowOpenPrice ? 'UP' : 'DOWN';
    const size = Math.min(parseFloat(this.settings.max_trade_size) * 0.25, parseFloat(this.settings.max_trade_size));
    return {
      direction,
      entry_price: 0.50,
      model_prob: 0.5,
      market_prob: 0.5,
      anchored_prob: 0.5,
      expected_value: 0,
      size,
      fee: 0,
      confidence: 0.1,
      score: direction === 'UP' ? 0.1 : -0.1
    };
  }

  async _executeTrade(signal, market, tokens, windowTs) {
    const mode = this.paperTrading ? '[PAPER]' : '[LIVE]';
    const [upToken, downToken] = tokens;
    const tokenId = signal.direction === 'UP'
      ? (upToken?.token_id || upToken)
      : (downToken?.token_id || downToken);

    if (!tokenId) {
      this._log('ERROR', `No token ID for ${signal.direction}. Tokens: ${JSON.stringify(tokens).substring(0,100)}`);
      return;
    }

    this._log('INFO',
      `${mode} 🔥 TRADE | ${signal.direction} | Entry: ~$${signal.entry_price.toFixed(3)} | Conf: ${(signal.confidence*100).toFixed(0)}% | Size: $${signal.size.toFixed(2)}`
    );

    if (this.paperTrading) {
      try {
        const result = await pool.query(
          `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, paper, order_status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'SIMULATED',NOW()) RETURNING id`,
          [this.userId, market.conditionId, signal.direction, signal.entry_price, signal.size,
           signal.model_prob, signal.market_prob, signal.expected_value, signal.fee]
        );
        const tradeId = result.rows[0].id;
        this.openTrades.set(tradeId, {
          conditionId: market.conditionId, direction: signal.direction,
          tokenId, entryPrice: signal.entry_price, size: signal.size,
          paper: true, windowTs
        });
        this._log('INFO', `[PAPER] ✅ Trade #${tradeId} recorded`);
      } catch(e) {
        this._log('ERROR', `[PAPER] Failed to record trade: ${e.message}`);
      }
      return;
    }

    // Live trading
    try {
      const orderResult = await this.polymarket.placeOrder({
        tokenId, side: 'BUY',
        price: signal.entry_price, size: signal.size,
        conditionId: market.conditionId
      });
      const orderId = orderResult?.orderID || orderResult?.id || null;
      this._log('INFO', `[LIVE] Order submitted: ${orderId || 'no-id'}`);

      await new Promise(r => setTimeout(r, 5000));

      let orderStatus = 'UNVERIFIED', confirmedSize = signal.size;
      if (orderId) {
        try {
          const verified = await this.polymarket.getOrderStatus(orderId);
          orderStatus = verified.status;
          confirmedSize = parseFloat(verified.size_matched) || signal.size;
          if (orderStatus === 'CANCELLED' || orderStatus === 'UNMATCHED') {
            this._log('WARN', `[LIVE] Order NOT filled (${orderStatus})`);
            return;
          }
        } catch(e) { this._log('WARN', `Could not verify order: ${e.message}`); }
      }

      const result = await pool.query(
        `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, paper, order_id, order_status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,NOW()) RETURNING id`,
        [this.userId, market.conditionId, signal.direction, signal.entry_price, confirmedSize,
         signal.model_prob, signal.market_prob, signal.expected_value, signal.fee, orderId, orderStatus]
      );
      const tradeId = result.rows[0].id;
      this.openTrades.set(tradeId, {
        conditionId: market.conditionId, direction: signal.direction,
        tokenId, entryPrice: signal.entry_price, size: confirmedSize,
        paper: false, orderId, windowTs
      });
      this._log('INFO', `[LIVE] ✅ Trade #${tradeId} | ${signal.direction} $${confirmedSize.toFixed(2)} | ${orderStatus}`);
    } catch(err) {
      this._log('ERROR', `[LIVE] Trade failed: ${err.message}`);
    }
  }

  async _checkResolutions() {
    for (const [tradeId, trade] of this.openTrades.entries()) {
      try {
        const windowClose = (trade.windowTs || 0) + 300;
        const nowSec = Math.floor(Date.now() / 1000);

        if (nowSec < windowClose + 10) continue; // Wait at least 10s after close

        const resolution = await this.polymarket.checkResolution(trade.conditionId);
        if (!resolution.resolved) continue;

        const upWon = parseFloat((resolution.outcome || [])[0]) === 1;
        const win = (trade.direction === 'UP' && upWon) || (trade.direction === 'DOWN' && !upWon);

        // Correct P&L: shares = size / entryPrice, profit = shares - size (when win, each share pays $1)
        // Polymarket fee: ~2% on winnings
        const FEE_RATE = 0.02;
        const shares = trade.size / trade.entryPrice;
        const pnl = win ? (shares - trade.size) * (1 - FEE_RATE) : -trade.size;

        await pool.query('UPDATE trades SET result=$1, pnl=$2, resolved_at=NOW() WHERE id=$3',
          [win ? 'WIN' : 'LOSS', pnl, tradeId]);

        const mode = trade.paper ? '[PAPER]' : '[LIVE]';
        this._log('INFO', `${mode} Trade #${tradeId} → ${win ? '✅ WIN' : '❌ LOSS'} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        this.openTrades.delete(tradeId);
      } catch(err) {
        this._log('ERROR', `Resolution check failed trade #${tradeId}: ${err.message}`);
      }
    }
  }

  async _recordDecision(decision) {
    try {
      await pool.query(
        `INSERT INTO bot_decisions (user_id, verdict, direction, reason, data) VALUES ($1,$2,$3,$4,$5)`,
        [this.userId, decision.verdict, decision.direction || null, decision.reason, JSON.stringify(decision)]
      );
      await pool.query(
        `DELETE FROM bot_decisions WHERE user_id=$1 AND id NOT IN (SELECT id FROM bot_decisions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200)`,
        [this.userId]
      );
    } catch(e) {
      console.error(`[Bot:${this.userId}] Decision record failed:`, e.message);
    }
  }

  async _log(level, message) {
    console.log(`[Bot:${this.userId}][${level}] ${message}`);
    try {
      await pool.query('INSERT INTO bot_logs (user_id, level, message) VALUES ($1,$2,$3)', [this.userId, level, message]);
      await pool.query(`DELETE FROM bot_logs WHERE user_id=$1 AND id NOT IN (SELECT id FROM bot_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1000)`, [this.userId]);
    } catch(e) {}
  }

  getStatus() {
    return {
      is_running: this.isRunning,
      paper_trading: this.paperTrading,
      open_trades: this.openTrades.size,
      in_snipe_loop: this.inSnipeLoop,
      last_window_ts: this.lastWindowTs,
      market_data: this.lastMarketData
    };
  }

  async stop() {
    this.isRunning = false;
    clearInterval(this.mainTimer);
    clearInterval(this.marketRefreshTimer);
    clearInterval(this.resolutionTimer);
    this.binance.disconnect();
    this.chainlink.stop();
    if (this.polymarket) this.polymarket.disconnect();
    this._log('INFO', 'Bot stopped');
  }
}

module.exports = { BotInstance };
