/**
 * Signal Engine — based on lessons from PolymarketBot.md
 * 
 * Key insight: Window delta is KING at 5-min scale.
 * "Is BTC up or down vs window open price?" directly answers the market question.
 * Weight it 5-7x everything else.
 * 
 * 7 indicators, composite weighted score:
 * 1. Window Delta     (weight 5-7) — THE dominant signal
 * 2. Micro Momentum   (weight 2)   — Last 2 candles direction
 * 3. Acceleration     (weight 1.5) — Momentum building or fading
 * 4. EMA 9/21         (weight 1)   — Short-term trend
 * 5. RSI 14           (weight 1-2) — Overbought/oversold extremes
 * 6. Volume Surge     (weight 1)   — Volume confirms direction
 * 7. Tick Trend       (weight 2)   — Real-time micro-trend from 2s polling
 */

class GBMSignalEngine {
  constructor(settings) {
    this.settings = settings;
    this.onDecision = null;
    // Tick accumulator for real-time micro-trend (updated every 10s eval cycle)
    this.recentTicks = [];
    this.windowOpenPrice = null;
    this.windowTs = null;
  }

  /**
   * Update window open price when a new 5-min window starts
   */
  updateWindowOpen(currentPrice) {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    if (windowTs !== this.windowTs) {
      this.windowTs = windowTs;
      this.windowOpenPrice = currentPrice;
      this.recentTicks = [];
    }
    // Accumulate ticks for micro-trend
    this.recentTicks.push(currentPrice);
    if (this.recentTicks.length > 30) this.recentTicks.shift(); // Keep last ~5 min of ticks
  }

  /**
   * Main signal evaluation — composite weighted score
   */
  evaluate({ currentPrice, priceHistory, volumeHistory, timeToResolutionSec }) {
    const { direction_filter, max_trade_size, kelly_cap } = this.settings;

    if (!currentPrice || priceHistory.length < 5) return null;

    // Update window open tracking
    this.updateWindowOpen(currentPrice);

    const log = { timestamp: new Date().toISOString(), btc_price: currentPrice.toFixed(2), time_to_res: Math.round(timeToResolutionSec) + 's' };

    let score = 0;

    // ── 1. WINDOW DELTA (weight 5-7) — THE dominant signal ─────────────────
    let windowDeltaScore = 0;
    if (this.windowOpenPrice) {
      const windowPct = (currentPrice - this.windowOpenPrice) / this.windowOpenPrice * 100;
      if (Math.abs(windowPct) > 0.10) windowDeltaScore = Math.sign(windowPct) * 7;
      else if (Math.abs(windowPct) > 0.02) windowDeltaScore = Math.sign(windowPct) * 5;
      else if (Math.abs(windowPct) > 0.005) windowDeltaScore = Math.sign(windowPct) * 3;
      else if (Math.abs(windowPct) > 0.001) windowDeltaScore = Math.sign(windowPct) * 1;
      log.window_open = this.windowOpenPrice.toFixed(2);
      log.window_pct = windowPct.toFixed(4) + '%';
      log.window_delta_score = windowDeltaScore;
    }
    score += windowDeltaScore;

    // ── 2. MICRO MOMENTUM (weight 2) — Last 2 candles ──────────────────────
    let momentumScore = 0;
    if (priceHistory.length >= 3) {
      const last = priceHistory[priceHistory.length - 1];
      const prev = priceHistory[priceHistory.length - 2];
      const prev2 = priceHistory[priceHistory.length - 3];
      if (last > prev && prev > prev2) momentumScore = 2;
      else if (last < prev && prev < prev2) momentumScore = -2;
      else momentumScore = last > prev ? 0.5 : last < prev ? -0.5 : 0;
    }
    score += momentumScore;
    log.momentum_score = momentumScore;

    // ── 3. ACCELERATION (weight 1.5) — Is momentum building or fading? ─────
    let accelScore = 0;
    if (priceHistory.length >= 4) {
      const move1 = priceHistory[priceHistory.length - 1] - priceHistory[priceHistory.length - 2];
      const move2 = priceHistory[priceHistory.length - 2] - priceHistory[priceHistory.length - 3];
      if (Math.sign(move1) === Math.sign(move2) && Math.abs(move1) > Math.abs(move2)) {
        accelScore = Math.sign(move1) * 1.5; // Accelerating
      } else if (Math.sign(move1) === Math.sign(move2) && Math.abs(move1) < Math.abs(move2)) {
        accelScore = Math.sign(move1) * 0.5; // Decelerating
      }
    }
    score += accelScore;
    log.accel_score = accelScore;

    // ── 4. EMA 9/21 CROSSOVER (weight 1) ────────────────────────────────────
    let emaScore = 0;
    if (priceHistory.length >= 21) {
      const ema9 = this._ema(priceHistory.slice(-9), 9);
      const ema21 = this._ema(priceHistory.slice(-21), 21);
      emaScore = ema9 > ema21 ? 1 : -1;
    }
    score += emaScore;
    log.ema_score = emaScore;

    // ── 5. RSI 14 (weight 1-2) — Only extremes ──────────────────────────────
    let rsiScore = 0;
    if (priceHistory.length >= 15) {
      const rsi = this._rsi(priceHistory.slice(-15), 14);
      if (rsi > 75) rsiScore = -2; // Overbought — likely to reverse
      else if (rsi < 25) rsiScore = 2; // Oversold — likely to bounce
      // Neutral zone: 0 weight
      log.rsi = rsi.toFixed(1);
    }
    score += rsiScore;
    log.rsi_score = rsiScore;

    // ── 6. VOLUME SURGE (weight 1) ───────────────────────────────────────────
    let volScore = 0;
    if (volumeHistory.length >= 6) {
      const recentAvg = volumeHistory.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const priorAvg = volumeHistory.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
      if (priorAvg > 0 && recentAvg > priorAvg * 1.5) {
        // Volume surge confirms current direction
        volScore = Math.sign(momentumScore) * 1;
      }
    }
    score += volScore;
    log.vol_score = volScore;

    // ── 7. TICK TREND (weight 2) — Real-time micro-trend ────────────────────
    let tickScore = 0;
    if (this.recentTicks.length >= 5) {
      const ticks = this.recentTicks.slice(-10);
      let ups = 0, downs = 0;
      for (let i = 1; i < ticks.length; i++) {
        if (ticks[i] > ticks[i-1]) ups++;
        else if (ticks[i] < ticks[i-1]) downs++;
      }
      const total = ups + downs;
      const tickMove = ticks[ticks.length-1] - ticks[0];
      const tickPct = Math.abs(tickMove) / ticks[0] * 100;
      if (total > 0 && tickPct > 0.005) {
        const consistency = Math.max(ups, downs) / total;
        if (consistency >= 0.6) {
          tickScore = ups > downs ? 2 : -2;
        }
      }
    }
    score += tickScore;
    log.tick_score = tickScore;

    // ── COMPOSITE SCORE → CONFIDENCE ────────────────────────────────────────
    // Divide by 7 (not 10) — at 5-min scale, long-term indicators less relevant
    const confidence = Math.min(Math.abs(score) / 7.0, 1.0);
    const direction = score > 0 ? 'UP' : 'DOWN';

    log.total_score = score.toFixed(2);
    log.confidence = (confidence * 100).toFixed(1) + '%';
    log.direction = direction;

    const minConfidence = parseFloat(this.settings.min_ev_threshold) || 0.30;

    if (confidence < minConfidence) {
      log.verdict = 'SKIP';
      log.reason = `Confidence ${(confidence*100).toFixed(1)}% below threshold ${(minConfidence*100).toFixed(0)}%`;
      this._emit(log);
      return null;
    }

    // Kelly sizing based on confidence
    const prob = 0.5 + confidence * 0.35; // Map confidence to win probability estimate
    const entryPrice = this._estimateTokenPrice(Math.abs(score));
    const b = (1 / entryPrice) - 1;
    const kellyFraction = Math.max(0, (prob * b - (1 - prob)) / b);
    const size = Math.min(kellyFraction * kelly_cap * max_trade_size, max_trade_size);

    if (size < 0.50) {
      log.verdict = 'SKIP';
      log.reason = `Size $${size.toFixed(2)} too small`;
      this._emit(log);
      return null;
    }

    const ev = prob * (1 / entryPrice - 1) - (1 - prob);
    log.verdict = 'TRADE';
    log.entry_price = entryPrice.toFixed(3);
    log.size = '$' + size.toFixed(2);
    log.reason = `Score ${score.toFixed(1)} | Conf ${(confidence*100).toFixed(0)}% | ${direction} @ $${entryPrice.toFixed(3)} | Size $${size.toFixed(2)}`;
    this._emit(log);

    return {
      direction,
      entry_price: entryPrice,
      model_prob: prob,
      market_prob: entryPrice,
      anchored_prob: prob,
      expected_value: ev,
      size,
      fee: entryPrice * 0.25 * Math.pow(entryPrice * (1 - entryPrice), 2) * size,
      confidence,
      score
    };
  }

  /**
   * Estimate token price based on signal strength (from PolymarketBot.md pricing model)
   * delta < 0.005% → $0.50, delta ~ 0.15%+ → $0.92-0.97
   */
  _estimateTokenPrice(absScore) {
    if (absScore >= 7) return 0.92;
    if (absScore >= 5) return 0.80;
    if (absScore >= 3) return 0.65;
    if (absScore >= 1) return 0.55;
    return 0.50;
  }

  _ema(prices, period) {
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
  }

  _rsi(prices, period) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = prices[i] - prices[i-1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  _emit(log) {
    if (this.onDecision) this.onDecision(log);
  }
}

module.exports = { GBMSignalEngine };
