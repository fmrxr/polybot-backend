const { GBMSignalEngine } = require('./GBMSignalEngine');
const { BinanceFeed } = require('./BinanceFeed');
const { PolymarketFeed } = require('./PolymarketFeed');
const { decrypt } = require('../services/encryption');
const { pool } = require('../models/db');

const EVAL_INTERVAL_MS = 10000; // Evaluate every 10 seconds
const MARKET_REFRESH_MS = 60000; // Refresh active markets every minute
const RESOLUTION_CHECK_MS = 30000; // Check open trades for resolution every 30s

class BotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    this.binance = new BinanceFeed();
    this.polymarket = null;
    this.engine = null;
    this.evalTimer = null;
    this.marketRefreshTimer = null;
    this.resolutionTimer = null;
    this.isRunning = false;
    this.openTrades = new Map(); // tradeId -> { conditionId, direction, tokenId }
    this.lastTradeTime = 0;
    this.MIN_TRADE_INTERVAL_MS = 30000; // No two trades within 30s
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

    await this.binance.connect();
    await this.polymarket.fetchActiveBTCMarkets();

    this.isRunning = true;
    this._log('INFO', `Bot started for user ${this.userId}`);

    this.evalTimer = setInterval(() => this._evaluate(), EVAL_INTERVAL_MS);
    this.marketRefreshTimer = setInterval(() => this.polymarket.fetchActiveBTCMarkets(), MARKET_REFRESH_MS);
    this.resolutionTimer = setInterval(() => this._checkResolutions(), RESOLUTION_CHECK_MS);
  }

  async _evaluate() {
    if (!this.isRunning) return;

    try {
      // Check daily loss limit
      const dailyResult = await pool.query(`
        SELECT COALESCE(SUM(pnl), 0) as daily_pnl FROM trades
        WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
      `, [this.userId]);
      const dailyPnl = parseFloat(dailyResult.rows[0].daily_pnl);
      if (dailyPnl <= -this.settings.max_daily_loss) {
        this._log('WARN', `Daily loss limit reached ($${this.settings.max_daily_loss}). Bot paused.`);
        await this.stop();
        return;
      }

      // One trade at a time guard + time guard
      if (this.openTrades.size > 0) return;
      if (Date.now() - this.lastTradeTime < this.MIN_TRADE_INTERVAL_MS) return;

      const btcData = this.binance.getMarketData();
      if (!btcData.price || !btcData.volatility) return;

      const markets = this.polymarket.activeMarkets;
      if (!markets.length) return;

      // Find the closest upcoming 5-min market
      const now = Date.now();
      let bestMarket = null;
      let minTimeToRes = Infinity;

      for (const market of markets) {
        const resTime = new Date(market.endDateIso || market.end_date_iso).getTime();
        const timeToRes = (resTime - now) / 1000;
        if (timeToRes > 60 && timeToRes < 240 && timeToRes < minTimeToRes) {
          minTimeToRes = timeToRes;
          bestMarket = market;
        }
      }

      if (!bestMarket) return;

      // Get order books for UP and DOWN tokens
      const tokens = bestMarket.tokens || bestMarket.clobTokenIds || [];
      if (tokens.length < 2) return;

      const [upTokenId, downTokenId] = tokens;
      const [upBook, downBook] = await Promise.all([
        this.polymarket.getOrderBook(upTokenId),
        this.polymarket.getOrderBook(downTokenId)
      ]);

      if (!upBook || !downBook) return;

      // Get beat price from Chainlink or estimate from market question
      const chainlinkPrice = await this.polymarket.getChainlinkPrice();
      const beatPrice = chainlinkPrice || btcData.price;
      const distanceToBeat = Math.abs(btcData.price - beatPrice);

      // Evaluate signal
      const signal = this.engine.evaluate({
        currentPrice: btcData.price,
        beatPrice,
        marketProbUp: upBook.bestAsk,
        entryPriceUp: upBook.bestAsk,
        entryPriceDown: downBook.bestAsk,
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

      // Execute trade
      await this._executeTrade(signal, bestMarket, signal.direction === 'UP' ? upTokenId : downTokenId);

    } catch (err) {
      this._log('ERROR', `Evaluation error: ${err.message}`);
    }
  }

  async _executeTrade(signal, market, tokenId) {
    try {
      this._log('INFO',
        `Signal: ${signal.direction} | Entry: ${signal.entry_price.toFixed(3)} | EV: ${(signal.expected_value * 100).toFixed(1)}% | Size: $${signal.size.toFixed(2)}`
      );

      const orderResult = await this.polymarket.placeOrder({
        tokenId,
        side: 'BUY',
        price: signal.entry_price,
        size: signal.size,
        conditionId: market.conditionId
      });

      // Record trade in DB
      const tradeResult = await pool.query(`
        INSERT INTO trades (user_id, condition_id, direction, entry_price, size, model_prob, market_prob, expected_value, fee, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING id
      `, [
        this.userId,
        market.conditionId,
        signal.direction,
        signal.entry_price,
        signal.size,
        signal.anchored_prob,
        signal.market_prob,
        signal.expected_value,
        signal.fee
      ]);

      const tradeId = tradeResult.rows[0].id;
      this.openTrades.set(tradeId, {
        conditionId: market.conditionId,
        direction: signal.direction,
        tokenId,
        entryPrice: signal.entry_price,
        size: signal.size
      });

      this.lastTradeTime = Date.now();
      this._log('INFO', `Trade placed: ID ${tradeId}, ${signal.direction} $${signal.size.toFixed(2)} @ ${signal.entry_price.toFixed(3)}`);

    } catch (err) {
      this._log('ERROR', `Trade execution failed: ${err.message}`);
    }
  }

  async _checkResolutions() {
    for (const [tradeId, trade] of this.openTrades.entries()) {
      try {
        const resolution = await this.polymarket.checkResolution(trade.conditionId);
        if (!resolution.resolved) continue;

        // Determine win/loss
        const outcomes = resolution.outcome || [];
        const upWon = parseFloat(outcomes[0]) === 1;
        const win = (trade.direction === 'UP' && upWon) || (trade.direction === 'DOWN' && !upWon);

        let pnl;
        if (win) {
          // Payout = size / entry_price * (1 - fee_pct)
          const feePct = trade.entryPrice * 0.25 * Math.pow(trade.entryPrice * (1 - trade.entryPrice), 2);
          pnl = (trade.size / trade.entryPrice - trade.size) * (1 - feePct);
        } else {
          pnl = -trade.size;
        }

        await pool.query(
          'UPDATE trades SET result = $1, pnl = $2, resolved_at = NOW() WHERE id = $3',
          [win ? 'WIN' : 'LOSS', pnl, tradeId]
        );

        this._log('INFO', `Trade ${tradeId} resolved: ${win ? 'WIN' : 'LOSS'} | P&L: $${pnl.toFixed(2)}`);
        this.openTrades.delete(tradeId);

      } catch (err) {
        this._log('ERROR', `Resolution check failed for trade ${tradeId}: ${err.message}`);
      }
    }
  }

  async _log(level, message) {
    console.log(`[Bot:${this.userId}][${level}] ${message}`);
    try {
      await pool.query(
        'INSERT INTO bot_logs (user_id, level, message) VALUES ($1, $2, $3)',
        [this.userId, level, message]
      );
      // Keep only last 1000 logs per user
      await pool.query(
        'DELETE FROM bot_logs WHERE user_id = $1 AND id NOT IN (SELECT id FROM bot_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000)',
        [this.userId]
      );
    } catch (e) {}
  }

  getStatus() {
    return {
      is_running: this.isRunning,
      open_trades: this.openTrades.size,
      last_trade_time: this.lastTradeTime
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
