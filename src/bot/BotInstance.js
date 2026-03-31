const { GBMSignalEngine } = require('./GBMSignalEngine');
const { BinanceFeed } = require('./BinanceFeed');
const { PolymarketFeed } = require('./PolymarketFeed');
const { decrypt } = require('../services/encryption');
const { pool } = require('../models/db');

const EVAL_INTERVAL_MS = 10000;
const MARKET_REFRESH_MS = 60000;
const RESOLUTION_CHECK_MS = 30000;
const ORDER_VERIFY_DELAY_MS = 5000;
const MAX_DECISIONS_STORED = 200; // per user

class BotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    this.paperTrading = settings.paper_trading !== false;
    this.binance = new BinanceFeed();
    this.polymarket = null;
    this.engine = null;
    this.evalTimer = null;
    this.marketRefreshTimer = null;
    this.resolutionTimer = null;
    this.isRunning = false;
    this.openTrades = new Map();
    this.lastTradeTime = 0;
    this.MIN_TRADE_INTERVAL_MS = 30000;
    // In-memory last market data snapshot for status display
    this.lastMarketData = null;
  }

  async start() {
    const privateKey = decrypt(this.settings.encrypted_private_key);
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

    // Wire decision callback
    this.engine.onDecision = (decision) => this._recordDecision(decision);

    await this.binance.connect();
    await this.polymarket.fetchActiveBTCMarkets();

    this.isRunning = true;
    const mode = this.paperTrading ? '📄 PAPER TRADING' : '💰 LIVE TRADING';
    this._log('INFO', `Bot started [${mode}] for user ${this.userId}`);

    this.evalTimer = setInterval(() => this._evaluate(), EVAL_INTERVAL_MS);
    this.marketRefreshTimer = setInterval(() => this.polymarket.fetchActiveBTCMarkets(), MARKET_REFRESH_MS);
    this.resolutionTimer = setInterval(() => this._checkResolutions(), RESOLUTION_CHECK_MS);
  }

  async _evaluate() {
    if (!this.isRunning) return;
    try {
      // Daily loss limit
      const dailyResult = await pool.query(
        `SELECT COALESCE(SUM(pnl), 0) as daily_pnl FROM trades WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
        [this.userId]
      );
      const dailyPnl = parseFloat(dailyResult.rows[0].daily_pnl);
      if (dailyPnl <= -this.settings.max_daily_loss) {
        this._log('WARN', `Daily loss limit reached ($${this.settings.max_daily_loss}). Bot paused.`);
        await this.stop(); return;
      }

      if (this.openTrades.size > 0) return;
      if (Date.now() - this.lastTradeTime < this.MIN_TRADE_INTERVAL_MS) return;

      const btcData = this.binance.getMarketData();
      if (!btcData.price || !btcData.volatility) {
        this._log('INFO', `Warming up... BTC: $${btcData.price || '?'} | Collecting price history for volatility calc`);
        return;
      }

      // Save market snapshot for status display
      this.lastMarketData = {
        price: btcData.price,
        vwap: btcData.vwap,
        volatility: btcData.volatility,
        momentum: btcData.momentum,
        ob_imbalance: btcData.obImbalance,
        updated_at: new Date().toISOString()
      };

      const markets = this.polymarket.activeMarkets;
      if (!markets.length) {
        this._log('INFO', 'No active BTC 5-min markets found — scanning...');
        return;
      }

      // Find best market (1–4 min to resolution)
      const now = Date.now();
      let bestMarket = null;
      let minTimeToRes = Infinity;
      for (const market of markets) {
        const resTime = new Date(market.endDateIso || market.end_date_iso).getTime();
        const timeToRes = (resTime - now) / 1000;
        if (timeToRes > 60 && timeToRes < 240 && timeToRes < minTimeToRes) {
          minTimeToRes = timeToRes; bestMarket = market;
        }
      }

      if (!bestMarket) {
        this._log('INFO', `${markets.length} markets found but none in 1–4 min window — waiting`);
        return;
      }

      const tokens = bestMarket.tokens || bestMarket.clobTokenIds || [];
      if (tokens.length < 2) return;

      const [upTokenId, downTokenId] = tokens;
      const [upBook, downBook] = await Promise.all([
        this.polymarket.getOrderBook(upTokenId),
        this.polymarket.getOrderBook(downTokenId)
      ]);
      if (!upBook || !downBook) return;

      const chainlinkPrice = await this.polymarket.getChainlinkPrice();
      const beatPrice = chainlinkPrice || btcData.price;
      const distanceToBeat = Math.abs(btcData.price - beatPrice);

      this._log('INFO',
        `Evaluating | BTC: $${btcData.price.toFixed(0)} | Beat: $${beatPrice.toFixed(0)} | Dist: $${distanceToBeat.toFixed(0)} | UP: ${(upBook.bestAsk*100).toFixed(1)}¢ | DOWN: ${(downBook.bestAsk*100).toFixed(1)}¢ | Spread: ${Math.max(upBook.spread, downBook.spread).toFixed(3)} | ${Math.round(minTimeToRes)}s to resolution`
      );

      const signal = this.engine.evaluate({
        currentPrice: btcData.price, beatPrice,
        marketProbUp: upBook.bestAsk,
        entryPriceUp: upBook.bestAsk, entryPriceDown: downBook.bestAsk,
        spread: Math.max(upBook.spread, downBook.spread),
        volatility: btcData.volatility || 0.02,
        drift: btcData.drift || 0,
        momentum: btcData.momentum || 0,
        obImbalance: btcData.obImbalance || 0,
        vwap: btcData.vwap || btcData.price,
        timeToResolutionSec: minTimeToRes,
        distanceToBeat
      });

      if (!signal) return;
      await this._executeTrade(signal, bestMarket, signal.direction === 'UP' ? upTokenId : downTokenId);

    } catch (err) {
      this._log('ERROR', `Evaluation error: ${err.message}`);
    }
  }

  async _recordDecision(decision) {
    try {
      await pool.query(
        `INSERT INTO bot_decisions (user_id, verdict, direction, reason, data) VALUES ($1, $2, $3, $4, $5)`,
        [this.userId, decision.verdict, decision.direction || null, decision.reason, JSON.stringify(decision)]
      );
      // Keep only last 200 decisions
      await pool.query(
        `DELETE FROM bot_decisions WHERE user_id = $1 AND id NOT IN (SELECT id FROM bot_decisions WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${MAX_DECISIONS_STORED})`,
        [this.userId]
      );
    } catch(e) {}
  }

  async _executeTrade(signal, market, tokenId) {
    const mode = this.paperTrading ? '[PAPER]' : '[LIVE]';
    this._log('INFO',
      `🎯 ${mode} TRADE SIGNAL | ${signal.direction} | Entry: ${signal.entry_price.toFixed(3)} | EV: ${(signal.expected_value*100).toFixed(1)}% | Prob: ${(signal.anchored_prob*100).toFixed(1)}% | Size: $${signal.size.toFixed(2)}`
    );

    if (this.paperTrading) {
      const tradeResult = await pool.query(
        `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, paper, order_status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'SIMULATED',NOW()) RETURNING id`,
        [this.userId, market.conditionId, signal.direction, signal.entry_price, signal.size,
         signal.anchored_prob, signal.market_prob, signal.expected_value, signal.fee]
      );
      const tradeId = tradeResult.rows[0].id;
      this.openTrades.set(tradeId, { conditionId: market.conditionId, direction: signal.direction, tokenId, entryPrice: signal.entry_price, size: signal.size, paper: true });
      this.lastTradeTime = Date.now();
      this._log('INFO', `[PAPER] ✅ Trade #${tradeId} recorded — waiting for resolution`);
      return;
    }

    try {
      const orderResult = await this.polymarket.placeOrder({ tokenId, side: 'BUY', price: signal.entry_price, size: signal.size, conditionId: market.conditionId });
      const orderId = orderResult?.orderID || orderResult?.id || null;
      this._log('INFO', `[LIVE] Order submitted: ${orderId || 'no-id'}`);

      await new Promise(r => setTimeout(r, ORDER_VERIFY_DELAY_MS));

      let orderStatus = 'UNKNOWN', confirmedSize = signal.size;
      if (orderId) {
        try {
          const verified = await this.polymarket.getOrderStatus(orderId);
          orderStatus = verified.status;
          confirmedSize = parseFloat(verified.size_matched) || signal.size;
          if (orderStatus === 'CANCELLED' || orderStatus === 'UNMATCHED') {
            this._log('WARN', `[LIVE] ❌ Order NOT filled (${orderStatus}) — trade cancelled`);
            return;
          }
        } catch(e) {
          this._log('WARN', `[LIVE] Could not verify order: ${e.message}`);
          orderStatus = 'UNVERIFIED';
        }
      }

      const tradeResult = await pool.query(
        `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, paper, order_id, order_status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10,$11,NOW()) RETURNING id`,
        [this.userId, market.conditionId, signal.direction, signal.entry_price, confirmedSize,
         signal.anchored_prob, signal.market_prob, signal.expected_value, signal.fee, orderId, orderStatus]
      );
      const tradeId = tradeResult.rows[0].id;
      this.openTrades.set(tradeId, { conditionId: market.conditionId, direction: signal.direction, tokenId, entryPrice: signal.entry_price, size: confirmedSize, paper: false, orderId });
      this.lastTradeTime = Date.now();
      this._log('INFO', `[LIVE] ✅ Trade #${tradeId} confirmed — ${signal.direction} $${confirmedSize.toFixed(2)} @ ${signal.entry_price.toFixed(3)} | ${orderStatus}`);
    } catch (err) {
      this._log('ERROR', `[LIVE] Trade failed: ${err.message}`);
    }
  }

  async _checkResolutions() {
    for (const [tradeId, trade] of this.openTrades.entries()) {
      try {
        const resolution = await this.polymarket.checkResolution(trade.conditionId);
        if (!resolution.resolved) continue;
        const upWon = parseFloat((resolution.outcome || [])[0]) === 1;
        const win = (trade.direction === 'UP' && upWon) || (trade.direction === 'DOWN' && !upWon);
        let pnl;
        if (win) {
          const feePct = trade.entryPrice * 0.25 * Math.pow(trade.entryPrice * (1 - trade.entryPrice), 2);
          pnl = (trade.size / trade.entryPrice - trade.size) * (1 - feePct);
        } else {
          pnl = -trade.size;
        }
        await pool.query('UPDATE trades SET result=$1, pnl=$2, resolved_at=NOW() WHERE id=$3', [win ? 'WIN' : 'LOSS', pnl, tradeId]);
        const mode = trade.paper ? '[PAPER]' : '[LIVE]';
        this._log('INFO', `${mode} Trade #${tradeId} → ${win ? '✅ WIN' : '❌ LOSS'} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        this.openTrades.delete(tradeId);
      } catch (err) {
        this._log('ERROR', `Resolution check failed trade #${tradeId}: ${err.message}`);
      }
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
      last_trade_time: this.lastTradeTime,
      market_data: this.lastMarketData
    };
  }

  async stop() {
    this.isRunning = false;
    clearInterval(this.evalTimer);
    clearInterval(this.marketRefreshTimer);
    clearInterval(this.resolutionTimer);
    this.binance.disconnect();
    if (this.polymarket) this.polymarket.disconnect();
    this._log('INFO', 'Bot stopped');
  }
}

module.exports = { BotInstance };
