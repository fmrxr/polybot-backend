const axios = require('axios');
const { PolymarketFeed } = require('./PolymarketFeed');
const { decrypt } = require('../services/encryption');
const { pool } = require('../models/db');

const POLL_INTERVAL_MS = 5000; // Poll every 5s (was 30s)
const CLOB_API = 'https://clob.polymarket.com';
const MAX_SLIPPAGE = 0.05; // 5% max price deviation
const DELAY_FILTER_MS = 60000; // Don't copy trades older than 60s
const MAX_PRICE_STALENESS_PCT = 0.10; // 10% max price drift since whale trade

class CopyBotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    this.polymarket = null;
    this.pollTimer = null;
    this.isRunning = false;
    this.isPolling = false;
    this.targetStates = new Map(); // Map<address, lastTradeTs>
    this.marketCache = new Map(); // Cache of conditionId -> market info
    this.pendingTrades = new Map(); // Map<tokenId:direction, {count, firstSeenAt, trades[]}>
  }

  async start() {
    try {
      // Decrypt private key
      const privateKey = decrypt(this.settings.encrypted_private_key);

      // Decrypt user's Polymarket API key if provided
      let userApiKey = null;
      if (this.settings.encrypted_polymarket_api_key) {
        try {
          userApiKey = decrypt(this.settings.encrypted_polymarket_api_key);
        } catch(e) {
          this._log('WARN', `Failed to decrypt user's Polymarket API key: ${e.message}`);
        }
      }

      const funderAddress = this.settings.polymarket_wallet_address;
      if (!funderAddress) {
        this._log('WARN', 'No Polymarket wallet address configured — copy trades may fail');
      }

      this.polymarket = new PolymarketFeed(privateKey, userApiKey, funderAddress);
      await this.polymarket.init();

      // Load copy targets and their last-seen timestamps
      await this._loadTargets();

      this.isRunning = true;
      const mode = this.settings.paper_trading !== false ? '📄 PAPER' : '💰 LIVE';
      this._log('INFO', `Copy bot started [${mode}] | ${this.targetStates.size} target(s)`);

      // Start polling
      this.pollTimer = setInterval(() => {
        if (this.isPolling) return; // Skip if already running
        this.isPolling = true;
        this._pollTargets()
          .catch(e => this._log('ERROR', `Poll failed: ${e.message}`))
          .finally(() => { this.isPolling = false; });
      }, POLL_INTERVAL_MS);

      // Do one poll immediately
      await this._pollTargets();
    } catch(e) {
      this._log('ERROR', `Failed to start: ${e.message}`);
      this.isRunning = false;
      throw e;
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.isRunning = false;
    this._log('INFO', 'Copy bot stopped');
  }

  async _loadTargets() {
    try {
      const result = await pool.query(
        `SELECT target_address, label, multiplier, max_trade_size
         FROM copy_targets WHERE user_id=$1 AND is_active=true`,
        [this.userId]
      );

      const stateResult = await pool.query('SELECT target_address, last_trade_ts FROM copy_target_state');
      const stateMap = new Map();
      for (const row of stateResult.rows) {
        stateMap.set(row.target_address, row.last_trade_ts);
      }

      this.targets = result.rows;
      for (const target of this.targets) {
        this.targetStates.set(target.target_address, stateMap.get(target.target_address) || new Date(0));
      }
    } catch(e) {
      this._log('ERROR', `Failed to load targets: ${e.message}`);
      this.targets = [];
    }
  }

  async _pollTargets() {
    if (!this.isRunning || !this.targets) return;

    for (const target of this.targets) {
      try {
        const lastTs = this.targetStates.get(target.target_address);
        const trades = await this._fetchTargetTrades(target.target_address, lastTs);

        for (const trade of trades) {
          await this._mirrorTradeWithConfirmation(trade, target);
        }

        // Update state
        if (trades.length > 0) {
          const newestTs = new Date(Math.max(...trades.map(t => new Date(t.timestamp).getTime())));
          this.targetStates.set(target.target_address, newestTs);
          await pool.query(
            `INSERT INTO copy_target_state (target_address, last_trade_ts, last_checked_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT(target_address) DO UPDATE SET last_trade_ts=$2, last_checked_at=NOW()`,
            [target.target_address, newestTs]
          );
        }
      } catch(e) {
        this._log('WARN', `Poll failed for ${target.target_address}: ${e.message}`);
      }
    }
  }

  async _fetchTargetTrades(address, sinceTs) {
    try {
      // Build query params
      let params = `?maker_address=${address}&limit=100`;
      if (sinceTs && sinceTs > 0) {
        params += `&min_timestamp=${sinceTs.getTime()}`;
      }

      const response = await axios.get(`${CLOB_API}/data/trades${params}`, { timeout: 10000 });
      return response.data || [];
    } catch(e) {
      this._log('WARN', `Failed to fetch trades for ${address}: ${e.message}`);
      return [];
    }
  }

  async _mirrorTrade(sourceTrade, target) {
    try {
      // Derive direction from outcome token
      const market = await this._getMarket(sourceTrade.condition_id);
      if (!market) {
        this._log('WARN', `Market not found for ${sourceTrade.condition_id}`);
        return;
      }

      // Determine if source was UP or DOWN
      const upTokenId = market.tokens[0]?.token_id || market.tokens[0];
      const direction = sourceTrade.asset_id === upTokenId ? 'UP' : 'DOWN';

      // Fetch live price
      const livePrice = await this._fetchLivePrice(sourceTrade.asset_id);
      if (!livePrice) {
        this._log('WARN', `Could not fetch live price for token ${sourceTrade.asset_id}`);
        return;
      }

      // Slippage check
      const sourcePrice = parseFloat(sourceTrade.price) || 0.5;
      if (livePrice > sourcePrice * (1 + MAX_SLIPPAGE)) {
        this._log('WARN', `Slippage too high for ${direction}: live $${livePrice.toFixed(3)} vs source $${sourcePrice.toFixed(3)}`);
        return;
      }

      // Delay filter: reject if whale's trade is too old
      const tradeAge = Date.now() - new Date(sourceTrade.timestamp || 0).getTime();
      if (tradeAge > DELAY_FILTER_MS) {
        this._log('WARN', `Delay filter: trade is ${(tradeAge/1000).toFixed(0)}s old — skipping`);
        return;
      }

      // Price staleness: check total price drift since whale traded
      const priceDriftPct = Math.abs(livePrice - sourcePrice) / sourcePrice;
      if (priceDriftPct > MAX_PRICE_STALENESS_PCT) {
        this._log('WARN', `Price drift ${(priceDriftPct*100).toFixed(1)}% exceeds ${(MAX_PRICE_STALENESS_PCT*100).toFixed(0)}% max — stale copy`);
        return;
      }

      // Calculate size
      const sourceSize = parseFloat(sourceTrade.size) || 0;
      const rawSize = target.multiplier * sourceSize;

      // Whale score multiplier — favor proven whales
      const whaleScore = await this._getWhaleScore(target.target_address);
      const scoredSize = rawSize * (0.5 + whaleScore * 0.5); // 50%-100% of size depending on score
      const size = Math.min(scoredSize, parseFloat(target.max_trade_size));

      // Enforce minimum shares
      const MIN_SHARES = 5;
      const shares = size / livePrice;
      if (shares < MIN_SHARES) {
        this._log('WARN', `Size $${size.toFixed(2)} = ${shares.toFixed(1)} shares below minimum 5 — skipping copy`);
        return;
      }

      // Execute trade
      const mode = this.settings.paper_trading !== false ? '[PAPER]' : '[LIVE]';
      this._log('INFO', `${mode} 🔄 COPY ${direction} | From: ${target.label || sourceTrade.maker.slice(0,6)}... | Size: $${size.toFixed(2)} | Price: $${livePrice.toFixed(3)}`);

      if (this.settings.paper_trading !== false) {
        // Paper trade: just record in DB
        const result = await pool.query(
          `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, market_prob, paper, order_status, trade_type, copy_source, window_ts, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, true, 'SIMULATED', 'copy', $7, $8, NOW()) RETURNING id`,
          [this.userId, sourceTrade.condition_id, direction, livePrice, size, livePrice, target.target_address, Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % 300)]
        );
        // Update whale performance
        await pool.query(`
          INSERT INTO whale_performance (target_address, total_trades, last_updated)
          VALUES ($1, 1, NOW())
          ON CONFLICT(target_address) DO UPDATE SET
            total_trades = whale_performance.total_trades + 1,
            last_updated = NOW()
        `, [target.target_address]);
        this._log('INFO', `[PAPER] ✅ Copy trade #${result.rows[0].id} recorded`);
      } else {
        // Live trade
        try {
          const tokenId = sourceTrade.asset_id;
          const orderResult = await this.polymarket.placeOrder({
            tokenId,
            side: 'BUY',
            price: livePrice,
            size: size,
            conditionId: sourceTrade.condition_id
          });

          const orderId = orderResult?.orderID || orderResult?.id;
          this._log('INFO', `[LIVE] Order submitted: ${orderId || 'pending'}`);

          // Wait for order verification
          await new Promise(r => setTimeout(r, 5000));

          let orderStatus = 'UNVERIFIED';
          if (orderId) {
            const verified = await this.polymarket.getOrderStatus(orderId);
            orderStatus = verified.status;
            if (orderStatus === 'CANCELLED' || orderStatus === 'UNMATCHED') {
              this._log('WARN', `[LIVE] Copy order NOT filled (${orderStatus})`);
              return;
            }
          }

          const result = await pool.query(
            `INSERT INTO trades (user_id, condition_id, direction, entry_price, size, market_prob, paper, order_id, order_status, trade_type, copy_source, window_ts, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, 'copy', $9, $10, NOW()) RETURNING id`,
            [this.userId, sourceTrade.condition_id, direction, livePrice, size, livePrice, orderId, orderStatus, target.target_address, Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % 300)]
          );
          // Update whale performance
          await pool.query(`
            INSERT INTO whale_performance (target_address, total_trades, last_updated)
            VALUES ($1, 1, NOW())
            ON CONFLICT(target_address) DO UPDATE SET
              total_trades = whale_performance.total_trades + 1,
              last_updated = NOW()
          `, [target.target_address]);
          this._log('INFO', `[LIVE] ✅ Copy trade #${result.rows[0].id} | ${direction} $${size.toFixed(2)}`);
        } catch(e) {
          this._log('ERROR', `[LIVE] Copy trade failed: ${e.message}`);
        }
      }
    } catch(e) {
      this._log('ERROR', `Failed to mirror trade: ${e.message}`);
    }
  }

  async _getMarket(conditionId) {
    // Check cache first
    if (this.marketCache.has(conditionId)) {
      return this.marketCache.get(conditionId);
    }

    try {
      const response = await axios.get(`https://gamma-api.polymarket.com/markets/${conditionId}`, { timeout: 5000 });
      const market = response.data;

      // Normalize tokens
      if (market.tokens && typeof market.tokens[0] === 'string') {
        market.tokens = [
          { token_id: market.tokens[0], outcome: 'YES' },
          { token_id: market.tokens[1], outcome: 'NO' }
        ];
      }

      this.marketCache.set(conditionId, market);
      return market;
    } catch(e) {
      this._log('WARN', `Failed to fetch market ${conditionId}: ${e.message}`);
      return null;
    }
  }

  async _fetchLivePrice(tokenId) {
    try {
      const response = await axios.get(`${CLOB_API}/price?token_id=${tokenId}&side=BUY`, { timeout: 5000 });
      return parseFloat(response.data.mid_price || response.data.price);
    } catch(e) {
      this._log('WARN', `Failed to fetch price for ${tokenId}: ${e.message}`);
      return null;
    }
  }

  async _getWhaleScore(address) {
    try {
      const result = await pool.query(
        `SELECT total_trades, win_trades, total_pnl, avg_latency_ms
         FROM whale_performance WHERE target_address=$1`,
        [address]
      );
      if (!result.rows[0] || result.rows[0].total_trades < 5) {
        return 0.5; // Default score for unproven whales
      }
      const row = result.rows[0];
      const winRate = row.win_trades / row.total_trades;
      const avgPnl = parseFloat(row.total_pnl) / row.total_trades;
      const latencyPenalty = Math.min(row.avg_latency_ms / 10000, 0.2); // Penalize slow whales

      // Composite score: 0-1
      // win rate (40%) + positive pnl (40%) + speed (20%)
      const pnlScore = Math.min(Math.max(avgPnl / 10, 0), 1); // Normalize $0-$10 avg PnL
      return Math.min(winRate * 0.4 + pnlScore * 0.4 + (1 - latencyPenalty) * 0.2, 1.0);
    } catch(e) {
      return 0.5;
    }
  }

  async _mirrorTradeWithConfirmation(sourceTrade, target) {
    const minConf = target.min_confirmations || 1;
    if (minConf <= 1) {
      return this._mirrorTrade(sourceTrade, target);
    }

    // Multi-whale: accumulate
    const key = `${sourceTrade.asset_id}:BUY`;
    const existing = this.pendingTrades.get(key) || { count: 0, firstSeenAt: Date.now(), trades: [] };
    existing.count += 1;
    existing.trades.push({ sourceTrade, target });
    this.pendingTrades.set(key, existing);

    // Expire pending entries older than 2 minutes
    if (Date.now() - existing.firstSeenAt > 120000) {
      this.pendingTrades.delete(key);
      return;
    }

    if (existing.count >= minConf) {
      this._log('INFO', `Multi-whale confirmed: ${existing.count}/${minConf} whales agree on ${key}`);
      this.pendingTrades.delete(key);
      // Use the trade from the target with highest whale score
      return this._mirrorTrade(sourceTrade, target);
    }

    this._log('INFO', `Waiting for multi-whale confirmation: ${existing.count}/${minConf} so far for ${key}`);
  }

  getStatus() {
    return {
      is_running: this.isRunning,
      targets_count: this.targets ? this.targets.length : 0,
      last_poll_at: this.lastPollAt || null
    };
  }

  _log(level, msg) {
    console.log(`[CopyBot ${this.userId}] [${level}] ${msg}`);
    // Optionally insert into bot_logs table
    pool.query('INSERT INTO bot_logs (user_id, level, message) VALUES ($1, $2, $3)', [this.userId, level, msg]).catch(e => {
      console.error('Log insert failed:', e.message);
    });
  }
}

module.exports = { CopyBotInstance };
