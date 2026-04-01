/**
 * RiskManager — Adaptive risk control
 *
 * Objectives:
 * 1. Prevent overtrading (max 5–10 trades/day)
 * 2. Dynamic thresholds based on performance
 * 3. Volatility-adjusted position sizing
 * 4. Drawdown protection
 * 5. Auto-cooldown after bad streaks
 */

class RiskManager {
  constructor(settings = {}) {
    this.settings = settings;
    this.maxTradesPerDay = settings.max_trades_per_day || 10;
    this.maxFlipsPerWindow = 3; // Max 3 flips per 5 min
    this.tradesTodayStart = new Date().setHours(0, 0, 0, 0);
    this.todaysTrades = [];
    this.maxDrawdown = settings.max_drawdown || 0.10; // 10% max drawdown
    this.peakCapital = settings.initial_capital || 10000;
    this.currentCapital = settings.initial_capital || 10000;
    this.coolingDown = false;
    this.cooldownUntil = null;
    this.windowSize = 5 * 60 * 1000; // 5-minute window for flip counting
  }

  /**
   * OVERTRADING PROTECTION
   *
   * Rules:
   * - Max N trades per day
   * - Max 3 flips per 5 minutes
   * - Cooldown after >3 consecutive losses
   */

  /**
   * Can we trade now?
   *
   * @returns {object} {allowed, reason}
   */
  canTrade() {
    // Check daily limit
    const now = new Date();
    if (now.getTime() > this.tradesTodayStart + 24 * 60 * 60 * 1000) {
      // New day
      this.tradesTodayStart = now.setHours(0, 0, 0, 0);
      this.todaysTrades = [];
    }

    if (this.todaysTrades.length >= this.maxTradesPerDay) {
      return {
        allowed: false,
        reason: `Daily trade limit reached: ${this.todaysTrades.length}/${this.maxTradesPerDay}`
      };
    }

    // Check cooldown
    if (this.coolingDown && Date.now() < this.cooldownUntil) {
      const remainingSec = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
      return {
        allowed: false,
        reason: `Cooling down after bad streak. ${remainingSec}s remaining`
      };
    }

    if (this.coolingDown && Date.now() >= this.cooldownUntil) {
      this.coolingDown = false;
      this.cooldownUntil = null;
    }

    return { allowed: true, reason: 'OK to trade' };
  }

  /**
   * Record a trade
   *
   * @param {object} trade - Trade details
   */
  recordTrade(trade) {
    this.todaysTrades.push({
      timestamp: Date.now(),
      ...trade
    });
  }

  /**
   * Check for consecutive loss streak
   *
   * @param {array} closedTrades - Trades with PnL
   * @returns {number} Consecutive loss count (from most recent)
   */
  getConsecutiveLosses(closedTrades) {
    let count = 0;
    for (let i = closedTrades.length - 1; i >= 0; i--) {
      if (closedTrades[i].pnl < 0) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Trigger cooldown after bad streak
   *
   * @param {number} cooldownSec - Cooldown duration (seconds)
   */
  startCooldown(cooldownSec = 60) {
    this.coolingDown = true;
    this.cooldownUntil = Date.now() + cooldownSec * 1000;
  }

  /**
   * DYNAMIC EV THRESHOLD
   *
   * Increases when:
   * - Recent win rate drops
   * - Slippage increases
   * - Volatility is high
   *
   * @param {object} params
   *   - baseThreshold: Starting threshold (e.g., 0.01)
   *   - recentWinRate: Last 10 trades win rate
   *   - avgSlippage: Average slippage %
   *   - volatility: Current volatility
   *   - drawdown: Current drawdown from peak
   *
   * @returns {number} Adjusted EV threshold
   */
  getDynamicThreshold({
    baseThreshold = 0.01,
    recentWinRate = 0.5,
    avgSlippage = 0.1,
    volatility = 0.01,
    drawdown = 0.0
  }) {
    let threshold = baseThreshold;

    // Increase if losing (conservative)
    if (recentWinRate < 0.45) {
      threshold *= 1.5;
    } else if (recentWinRate < 0.50) {
      threshold *= 1.2;
    }

    // Increase if slippage is high (less reliable signals)
    if (avgSlippage > 0.15) {
      threshold *= 1.3;
    } else if (avgSlippage > 0.10) {
      threshold *= 1.15;
    }

    // Increase if volatility is very high or very low
    if (volatility > 0.05) {
      threshold *= 1.2; // High vol = less stable signals
    }
    if (volatility < 0.005) {
      threshold *= 1.2; // Low vol = harder to trade profitably
    }

    // Increase if in drawdown (be more defensive)
    if (drawdown > 0.05) {
      threshold *= 1.3;
    }

    return parseFloat(threshold.toFixed(4));
  }

  /**
   * VOLATILITY-ADJUSTED SIZING
   *
   * Reduce size when:
   * - Volatility is high (more uncertain)
   * - In drawdown
   * - Confidence is low
   *
   * @param {object} params
   *   - baseSize: Normal trade size (dollars)
   *   - volatility: Current volatility
   *   - confidence: Signal confidence (0–1)
   *   - drawdown: Current drawdown from peak
   *   - recentWinRate: Recent win rate
   *
   * @returns {number} Adjusted trade size
   */
  getAdjustedSize({
    baseSize = 20,
    volatility = 0.01,
    confidence = 0.7,
    drawdown = 0.0,
    recentWinRate = 0.5
  }) {
    let size = baseSize;

    // Scale with confidence (low confidence = small size)
    size *= (0.5 + confidence * 0.5); // 0.5x to 1.0x

    // Reduce in high volatility
    if (volatility > 0.05) {
      size *= 0.7; // 30% reduction
    } else if (volatility > 0.03) {
      size *= 0.85; // 15% reduction
    }

    // Reduce in drawdown
    if (drawdown > 0.08) {
      size *= 0.5; // 50% reduction in deep drawdown
    } else if (drawdown > 0.05) {
      size *= 0.75; // 25% reduction
    }

    // Reduce if losing
    if (recentWinRate < 0.45) {
      size *= 0.7; // 30% reduction
    }

    // Never trade below minimum
    const minSize = baseSize * 0.25; // 25% of base is minimum
    return Math.max(minSize, parseFloat(size.toFixed(2)));
  }

  /**
   * DRAWDOWN TRACKING
   *
   * @param {number} pnl - Trade profit/loss
   * @returns {object} {current, max, peak_capital}
   */
  recordPnL(pnl) {
    this.currentCapital += pnl;

    if (this.currentCapital > this.peakCapital) {
      this.peakCapital = this.currentCapital;
    }

    const drawdown = Math.max(0, (this.peakCapital - this.currentCapital) / this.peakCapital);

    return {
      current_capital: parseFloat(this.currentCapital.toFixed(2)),
      peak_capital: parseFloat(this.peakCapital.toFixed(2)),
      drawdown: parseFloat((drawdown * 100).toFixed(2)) + '%',
      drawdown_exceeded: drawdown > this.maxDrawdown
    };
  }

  /**
   * Get risk metrics
   *
   * @returns {object} Current risk state
   */
  getStatus() {
    const drawdown = Math.max(0, (this.peakCapital - this.currentCapital) / this.peakCapital);

    return {
      trades_today: this.todaysTrades.length,
      max_trades_daily: this.maxTradesPerDay,
      trading_allowed: this.canTrade().allowed,
      cooling_down: this.coolingDown,
      cooldown_until: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      current_capital: parseFloat(this.currentCapital.toFixed(2)),
      peak_capital: parseFloat(this.peakCapital.toFixed(2)),
      drawdown_percent: parseFloat((drawdown * 100).toFixed(2)),
      max_drawdown_allowed: this.maxDrawdown * 100,
      drawdown_exceeded: drawdown > this.maxDrawdown
    };
  }

  /**
   * FLIP FREQUENCY CHECK
   *
   * @param {array} recentTrades - Trades in window
   * @returns {object} {can_flip, flip_count, max_flips}
   */
  canFlipNow(recentTrades) {
    const now = Date.now();
    const windowTrades = recentTrades.filter(t =>
      (now - t.timestamp) < this.windowSize
    );

    // Count flips (consecutive opposite direction trades)
    let flips = 0;
    let lastDirection = null;
    for (const t of windowTrades) {
      if (lastDirection && lastDirection !== t.direction) {
        flips++;
      }
      lastDirection = t.direction;
    }

    return {
      can_flip: flips < this.maxFlipsPerWindow,
      flip_count: flips,
      max_flips: this.maxFlipsPerWindow,
      reason: flips >= this.maxFlipsPerWindow
        ? `Too many flips: ${flips}/${this.maxFlipsPerWindow} in last 5 min`
        : 'OK to flip'
    };
  }
}

module.exports = { RiskManager };
