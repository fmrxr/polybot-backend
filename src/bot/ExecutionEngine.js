/**
 * ExecutionEngine — Smart order execution
 *
 * Principles:
 * 1. LIMIT ORDERS ONLY (never market orders)
 * 2. Ladder entries (split order into 2–3 tranches)
 * 3. Anti-churn: Minimum hold times, controlled flips
 * 4. Track slippage and execution quality
 *
 * This replaces naive market order execution with quality-focused approach
 */

class ExecutionEngine {
  constructor(settings = {}) {
    this.settings = settings;
    this.pendingOrders = new Map(); // orderId -> {state, price, size, createdAt}
    this.executedTrades = [];        // History for slippage tracking
    this.holdTimes = new Map();      // tradeId -> {enteredAt, exitedAt}
    this.flips = [];                 // Recent flip attempts
    this.minHoldTimeMs = 10000;      // Minimum 10s hold
    this.maxHoldTimeMs = 300000;     // Max 5 min (one window)
    this.orderTimeoutMs = 3000;      // Cancel unfilled after 3s
  }

  /**
   * Ladder entry: Split order into multiple limit orders
   *
   * For a $100 order:
   * - L1: $30 at ask+0.5bp (aggressive, likely fill)
   * - L2: $40 at ask+1.0bp (moderate)
   * - L3: $30 at ask+2.0bp (conservative, fallback)
   *
   * @param {object} params
   *   - direction: 'UP' or 'DOWN'
   *   - totalSize: Total size in dollars
   *   - midPrice: Mid price (for limit calc)
   *   - spread: Current bid/ask spread
   *
   * @returns {array} Array of limit orders: {price, size, label}
   */
  ladderEntry({ direction, totalSize, midPrice, spread }) {
    const basisPoints = spread * 10000; // Convert to bp

    const orders = [];

    if (direction === 'UP') {
      // Buying YES (want to buy as low as possible)
      // But we're price takers, so we'll pay a bit above midPrice
      const levels = [
        { size: 0.30 * totalSize, bp: 5, label: 'L1-aggressive' },
        { size: 0.40 * totalSize, bp: 10, label: 'L2-moderate' },
        { size: 0.30 * totalSize, bp: 20, label: 'L3-conservative' }
      ];

      for (const { size, bp, label } of levels) {
        const price = midPrice + (bp / 10000) * midPrice; // midPrice + X bps
        orders.push({
          price: parseFloat(price.toFixed(4)),
          size: parseFloat(size.toFixed(2)),
          label
        });
      }
    } else {
      // Selling YES (want to sell as high as possible)
      const levels = [
        { size: 0.30 * totalSize, bp: -5, label: 'L1-aggressive' },
        { size: 0.40 * totalSize, bp: -10, label: 'L2-moderate' },
        { size: 0.30 * totalSize, bp: -20, label: 'L3-conservative' }
      ];

      for (const { size, bp, label } of levels) {
        const price = midPrice + (bp / 10000) * midPrice;
        orders.push({
          price: parseFloat(price.toFixed(4)),
          size: parseFloat(size.toFixed(2)),
          label
        });
      }
    }

    return orders;
  }

  /**
   * Submit an order (limit order to exchange)
   *
   * @param {object} params
   *   - orderId: Unique order ID
   *   - price: Limit price
   *   - size: Size in dollars
   *   - side: 'BUY' or 'SELL'
   *   - tokenId: Token ID
   *   - timeoutMs: Cancel if unfilled after (ms)
   *
   * @returns {object} Order receipt
   */
  submitOrder({
    orderId,
    price,
    size,
    side,
    tokenId,
    timeoutMs = this.orderTimeoutMs
  }) {
    const now = Date.now();
    this.pendingOrders.set(orderId, {
      state: 'PENDING',
      price,
      size,
      side,
      tokenId,
      createdAt: now,
      timeoutAt: now + timeoutMs
    });

    return {
      order_id: orderId,
      status: 'SUBMITTED',
      price: parseFloat(price.toFixed(4)),
      size: parseFloat(size.toFixed(2)),
      timeout_ms: timeoutMs,
      submitted_at: new Date(now).toISOString()
    };
  }

  /**
   * Confirm partial or full fill
   *
   * @param {object} params
   *   - orderId: Which order filled
   *   - fillSize: How much filled
   *   - fillPrice: At what price
   *   - tradeId: ID of resulting trade
   *
   * @returns {object} Fill details
   */
  confirmFill({
    orderId,
    fillSize,
    fillPrice,
    tradeId
  }) {
    const order = this.pendingOrders.get(orderId);
    if (!order) return { error: 'Order not found' };

    const slippage = Math.abs(fillPrice - order.price);
    const slippagePercent = (slippage / order.price) * 100;

    // Record execution
    const fill = {
      order_id: orderId,
      trade_id: tradeId,
      filled_size: fillSize,
      filled_price: fillPrice,
      expected_price: order.price,
      slippage: parseFloat(slippage.toFixed(4)),
      slippage_percent: parseFloat(slippagePercent.toFixed(2)),
      filled_at: Date.now()
    };

    this.executedTrades.push(fill);

    // Track hold time
    this.holdTimes.set(tradeId, {
      enteredAt: Date.now(),
      entryPrice: fillPrice,
      exitedAt: null,
      exitPrice: null,
      direction: order.side
    });

    // Update order state
    if (fillSize >= order.size) {
      order.state = 'FILLED';
    } else {
      order.state = 'PARTIAL';
      order.size -= fillSize;
    }

    return {
      ...fill,
      order_state: order.state
    };
  }

  /**
   * Check for expired orders and cancel
   *
   * @returns {array} Cancelled orders
   */
  cancelExpiredOrders() {
    const now = Date.now();
    const cancelled = [];

    for (const [orderId, order] of this.pendingOrders) {
      if (order.state === 'PENDING' && now > order.timeoutAt) {
        order.state = 'CANCELLED';
        cancelled.push({
          order_id: orderId,
          age_ms: now - order.createdAt,
          cancelled_at: new Date(now).toISOString()
        });
      }
    }

    return cancelled;
  }

  /**
   * ANTI-CHURN FLIP LOGIC
   *
   * Only allow flip if:
   * 1. Current position held > minHoldTime (10s)
   * 2. Opposite direction has EV_adj > current_EV_adj + 1.5% (cost buffer)
   * 3. < 3 flips in last 5 minutes
   *
   * @param {object} params
   *   - tradeId: Current trade
   *   - currentEVadj: Current EV_adj
   *   - oppositeEVadj: EV_adj if we flip
   *   - recentFlips: Flips in last 5 min
   *
   * @returns {object}
   *   - allowed: boolean
   *   - reason: Why allowed or blocked
   */
  canFlip({
    tradeId,
    currentEVadj,
    oppositeEVadj,
    recentFlips = []
  }) {
    const trade = this.holdTimes.get(tradeId);
    if (!trade) return { allowed: false, reason: 'Trade not found' };

    // Check hold time
    const holdMs = Date.now() - trade.enteredAt;
    if (holdMs < this.minHoldTimeMs) {
      return {
        allowed: false,
        reason: `Held only ${holdMs}ms, minimum ${this.minHoldTimeMs}ms`
      };
    }

    // Check EV improvement (need 1.5% advantage to justify costs)
    const costBuffer = 0.015; // 1.5%
    if (oppositeEVadj <= currentEVadj + costBuffer) {
      return {
        allowed: false,
        reason: `Opposite EV ${oppositeEVadj.toFixed(3)} <= current ${currentEVadj.toFixed(3)} + buffer ${costBuffer.toFixed(3)}`
      };
    }

    // Check flip frequency (max 3 per 5 min)
    const recentFlipCount = recentFlips.filter(f =>
      Date.now() - f.timestamp < 300000
    ).length;

    if (recentFlipCount >= 3) {
      return {
        allowed: false,
        reason: `Too many recent flips: ${recentFlipCount} in last 5 min`
      };
    }

    return {
      allowed: true,
      reason: `Held ${holdMs}ms > min, opposite EV advantage ${(oppositeEVadj - currentEVadj).toFixed(3)}, ${recentFlipCount} recent flips`
    };
  }

  /**
   * Record trade exit
   *
   * @param {object} params
   *   - tradeId: Trade being exited
   *   - exitPrice: Exit price
   *   - reason: 'tp' | 'sl' | 'flip' | 'expired'
   *
   * @returns {object} Exit details + PnL
   */
  recordExit({
    tradeId,
    exitPrice,
    reason
  }) {
    const trade = this.holdTimes.get(tradeId);
    if (!trade) return { error: 'Trade not found' };

    trade.exitedAt = Date.now();
    trade.exitPrice = exitPrice;
    trade.holdTime = trade.exitedAt - trade.enteredAt;

    // Simple PnL (not accounting for shares, just $ P&L)
    const pnl = trade.direction === 'BUY'
      ? (exitPrice - trade.entryPrice) * 100 // Placeholder: assume 100 shares
      : (trade.entryPrice - exitPrice) * 100;

    return {
      trade_id: tradeId,
      hold_time_ms: trade.holdTime,
      entry_price: trade.entryPrice,
      exit_price: exitPrice,
      exit_reason: reason,
      pnl_estimate: parseFloat(pnl.toFixed(2))
    };
  }

  /**
   * Get execution statistics
   *
   * @returns {object} Slippage, win rate, hold times, etc.
   */
  getStats() {
    if (this.executedTrades.length === 0) {
      return {
        trades: 0,
        avg_slippage: 0,
        max_slippage: 0,
        avg_slippage_percent: 0,
        filled_orders: 0,
        pending_orders: this.pendingOrders.size
      };
    }

    const slippages = this.executedTrades.map(t => t.slippage);
    const slippagePercents = this.executedTrades.map(t => t.slippage_percent);

    return {
      trades: this.executedTrades.length,
      avg_slippage: parseFloat((slippages.reduce((a, b) => a + b, 0) / slippages.length).toFixed(4)),
      max_slippage: parseFloat(Math.max(...slippages).toFixed(4)),
      min_slippage: parseFloat(Math.min(...slippages).toFixed(4)),
      avg_slippage_percent: parseFloat((slippagePercents.reduce((a, b) => a + b, 0) / slippagePercents.length).toFixed(2)),
      filled_orders: this.executedTrades.length,
      pending_orders: Array.from(this.pendingOrders.values()).filter(o => o.state === 'PENDING').length,
      cancelled_orders: Array.from(this.pendingOrders.values()).filter(o => o.state === 'CANCELLED').length
    };
  }
}

module.exports = { ExecutionEngine };
