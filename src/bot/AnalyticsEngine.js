/**
 * AnalyticsEngine — Comprehensive logging + Claude feedback loop
 *
 * GOAL: Every trade generates rich data for analysis
 * Every 50–100 trades: Ask Claude for patterns and suggested improvements
 *
 * Tracks:
 * - Features (price, vol, spread, etc)
 * - EV metrics (EV_raw, EV_adj, threshold)
 * - Signal confidence
 * - Execution quality (slippage, fill rate)
 * - P&L vs predicted
 * - Market conditions at entry/exit
 */

class AnalyticsEngine {
  constructor(settings = {}) {
    this.settings = settings;
    this.trades = []; // All trades for analysis
    this.decisions = []; // TRADE/SKIP/FLIP decisions
    this.maxTrades = 500; // Keep last 500 for memory
  }

  /**
   * Log a trade decision (before execution)
   *
   * @param {object} params - All decision parameters
   */
  logDecision({
    timestamp,
    decision, // 'TRADE' | 'SKIP' | 'FLIP' | 'EARLY_EXIT'
    direction,
    // EV data
    ev_raw,
    ev_adjusted,
    ev_threshold,
    // Signals
    microstructure_signal,
    microstructure_confidence,
    momentum,
    volatility,
    // Market data
    btc_price,
    poly_price,
    spread,
    bid_depth,
    ask_depth,
    // Risk
    size,
    kelly_fraction,
    // Reasoning
    reason,
    // Raw scores for analysis
    window_delta_score,
    total_score,
    confidence
  }) {
    const log = {
      timestamp: timestamp || Date.now(),
      decision,
      direction,
      ev_raw: parseFloat(ev_raw?.toFixed(4) || 0),
      ev_adjusted: parseFloat(ev_adjusted?.toFixed(4) || 0),
      ev_threshold: parseFloat(ev_threshold?.toFixed(4) || 0),
      microstructure_signal: parseFloat(microstructure_signal?.toFixed(2) || 0),
      microstructure_confidence: parseFloat(microstructure_confidence?.toFixed(2) || 0),
      momentum: parseFloat(momentum?.toFixed(4) || 0),
      volatility: parseFloat(volatility?.toFixed(4) || 0),
      btc_price: parseFloat(btc_price?.toFixed(2) || 0),
      poly_price: parseFloat(poly_price?.toFixed(4) || 0),
      spread: parseFloat(spread?.toFixed(4) || 0),
      bid_depth: parseFloat(bid_depth?.toFixed(2) || 0),
      ask_depth: parseFloat(ask_depth?.toFixed(2) || 0),
      size: parseFloat(size?.toFixed(2) || 0),
      kelly_fraction: parseFloat(kelly_fraction?.toFixed(3) || 0),
      reason,
      window_delta_score: parseFloat(window_delta_score?.toFixed(2) || 0),
      total_score: parseFloat(total_score?.toFixed(2) || 0),
      confidence: parseFloat(confidence?.toFixed(2) || 0)
    };

    this.decisions.push(log);
    return log;
  }

  /**
   * Log a trade execution
   *
   * @param {object} params - Trade + execution details
   */
  logTrade({
    decision_id,
    trade_id,
    execution_timestamp,
    filled_price,
    filled_size,
    slippage,
    slippage_percent,
    order_count, // How many ladder orders
    filled_orders, // Which orders filled
    // Later filled when trade exits
    exit_timestamp,
    exit_price,
    exit_reason,
    pnl,
    pnl_percent,
    hold_time_ms
  }) {
    const trade = {
      trade_id,
      decision_id,
      execution_timestamp: execution_timestamp || Date.now(),
      filled_price: parseFloat(filled_price?.toFixed(4) || 0),
      filled_size: parseFloat(filled_size?.toFixed(2) || 0),
      slippage: parseFloat(slippage?.toFixed(4) || 0),
      slippage_percent: parseFloat(slippage_percent?.toFixed(2) || 0),
      order_count: order_count || 0,
      filled_orders: filled_orders || [],
      exit_timestamp: exit_timestamp || null,
      exit_price: exit_price ? parseFloat(exit_price.toFixed(4)) : null,
      exit_reason: exit_reason || null,
      pnl: pnl !== undefined ? parseFloat(pnl.toFixed(2)) : null,
      pnl_percent: pnl_percent !== undefined ? parseFloat(pnl_percent.toFixed(2)) : null,
      hold_time_ms: hold_time_ms || null,
      is_closed: !!(exit_timestamp && pnl !== undefined)
    };

    this.trades.push(trade);

    // Keep memory bounded
    if (this.trades.length > this.maxTrades) {
      this.trades.shift();
    }

    return trade;
  }

  /**
   * Update trade with exit data
   */
  updateTradeExit({
    trade_id,
    exit_timestamp,
    exit_price,
    exit_reason,
    pnl,
    pnl_percent,
    hold_time_ms
  }) {
    const trade = this.trades.find(t => t.trade_id === trade_id);
    if (!trade) return { error: 'Trade not found' };

    trade.exit_timestamp = exit_timestamp;
    trade.exit_price = parseFloat(exit_price?.toFixed(4) || 0);
    trade.exit_reason = exit_reason;
    trade.pnl = parseFloat(pnl?.toFixed(2) || 0);
    trade.pnl_percent = parseFloat(pnl_percent?.toFixed(2) || 0);
    trade.hold_time_ms = hold_time_ms;
    trade.is_closed = true;

    return trade;
  }

  /**
   * Get summary statistics
   *
   * @returns {object} Metrics for dashboard/feedback
   */
  getSummary() {
    const closed = this.trades.filter(t => t.is_closed);
    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl < 0);

    if (closed.length === 0) {
      return {
        total_trades: 0,
        closed_trades: 0,
        win_rate: 0,
        avg_pnl: 0,
        total_pnl: 0,
        avg_hold_time_ms: 0,
        avg_slippage: 0,
        avg_slippage_percent: 0,
        decisions_total: this.decisions.length,
        decision_breakdown: {
          TRADE: 0,
          SKIP: 0,
          FLIP: 0,
          EARLY_EXIT: 0
        }
      };
    }

    const pnls = closed.map(t => t.pnl);
    const slippages = this.trades.map(t => t.slippage);
    const holdTimes = closed.map(t => t.hold_time_ms).filter(x => x);

    const breakdown = {};
    for (const d of this.decisions) {
      breakdown[d.decision] = (breakdown[d.decision] || 0) + 1;
    }

    return {
      total_trades: this.trades.length,
      closed_trades: closed.length,
      win_rate: parseFloat((wins.length / closed.length * 100).toFixed(1)),
      wins: wins.length,
      losses: losses.length,
      avg_pnl: parseFloat((pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)),
      total_pnl: parseFloat(pnls.reduce((a, b) => a + b, 0).toFixed(2)),
      best_trade: parseFloat(Math.max(...pnls).toFixed(2)),
      worst_trade: parseFloat(Math.min(...pnls).toFixed(2)),
      avg_hold_time_ms: holdTimes.length > 0
        ? Math.round(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length)
        : 0,
      avg_slippage: parseFloat((slippages.reduce((a, b) => a + b, 0) / slippages.length).toFixed(4)),
      avg_slippage_percent: parseFloat((this.trades.map(t => t.slippage_percent)
        .reduce((a, b) => a + b, 0) / this.trades.length).toFixed(2)),
      decisions_total: this.decisions.length,
      decision_breakdown: breakdown
    };
  }

  /**
   * Format trade history for Claude analysis
   *
   * Returns structured data for feedback loop
   *
   * @param {number} limit - Last N trades to analyze
   * @returns {object} Formatted data for Claude
   */
  formatForAnalysis(limit = 50) {
    const recentTrades = this.trades.slice(-limit);
    const recentDecisions = this.decisions.slice(-limit);

    // Find losing trades
    const losers = recentTrades
      .filter(t => t.is_closed && t.pnl < 0)
      .map(t => ({
        trade_id: t.trade_id,
        pnl: t.pnl,
        pnl_percent: t.pnl_percent,
        hold_time_ms: t.hold_time_ms,
        exit_reason: t.exit_reason,
        slippage_percent: t.slippage_percent,
        decision: recentDecisions.find(d => d.decision_id === t.decision_id) || {}
      }))
      .slice(-10);

    // Find skipped opportunities (high EV_adj but SKIP decision)
    const skippedOps = recentDecisions
      .filter(d => d.decision === 'SKIP' && d.ev_adjusted > 0.02)
      .slice(-10);

    // Win rate trend (last 10 trades)
    const recent10 = recentTrades.filter(t => t.is_closed).slice(-10);
    const winRate10 = recent10.length > 0
      ? recent10.filter(t => t.pnl > 0).length / recent10.length
      : 0;

    return {
      summary: this.getSummary(),
      losing_trades: losers,
      skipped_opportunities: skippedOps,
      recent_10_win_rate: parseFloat((winRate10 * 100).toFixed(1)),
      avg_ev_adj: parseFloat((recentDecisions.map(d => d.ev_adjusted)
        .reduce((a, b) => a + b, 0) / recentDecisions.length).toFixed(3)),
      microstructure_confidence: parseFloat((recentDecisions.map(d => d.microstructure_confidence)
        .reduce((a, b) => a + b, 0) / recentDecisions.length).toFixed(2)),
      sample_size: limit
    };
  }

  /**
   * Get ready-for-Claude prompt
   *
   * Call this after ~50–100 trades to ask Claude for pattern analysis
   *
   * @returns {string} Formatted prompt for Claude
   */
  promptForClaudeAnalysis(limit = 100) {
    const data = this.formatForAnalysis(limit);

    return `
## Trading System Analysis Request

I've executed ${data.summary.total_trades} trades. Here's the recent performance:

**Summary:**
- Win Rate: ${data.summary.win_rate}%
- Avg PnL: $${data.summary.avg_pnl}
- Total PnL: $${data.summary.total_pnl}
- Avg Slippage: ${data.summary.avg_slippage_percent}%
- Avg EV_adj: ${data.avg_ev_adj}
- Microstructure confidence: ${data.microstructure_confidence}

**Recent 10 Win Rate:** ${data.recent_10_win_rate}%

### Losing Trades (Last 10):
${JSON.stringify(data.losing_trades, null, 2)}

### Skipped Opportunities (high EV_adj but SKIP):
${JSON.stringify(data.skipped_opportunities, null, 2)}

### Questions:
1. What patterns do you see in the losing trades?
2. Why are we skipping high EV_adj opportunities?
3. What new filters would improve the win rate?
4. Should we adjust EV threshold, microstructure requirements, or execution?
5. Any signals we're missing or overweighting?

Please provide specific, actionable recommendations.
    `;
  }
}

module.exports = { AnalyticsEngine };
