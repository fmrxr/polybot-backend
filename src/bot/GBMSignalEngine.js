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
  updateWindowOpen(currentPrice, chainlinkPrice) {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowTs = nowSec - (nowSec % 300);
    if (windowTs !== this.windowTs) {
      this.windowTs = windowTs;
      // Prefer Chainlink as window open price — it's what Polymarket uses for resolution
      this.windowOpenPrice = chainlinkPrice || currentPrice;
      this.chainlinkOpenPrice = chainlinkPrice;
      this.recentTicks = [];
    }
    // Accumulate ticks for micro-trend
    this.recentTicks.push(currentPrice);
    if (this.recentTicks.length > 30) this.recentTicks.shift(); // Keep last ~5 min of ticks
  }

  /**
   * Main signal evaluation — composite weighted score
   */
  evaluate({ currentPrice, binancePrice, chainlinkPrice, priceHistory, volumeHistory, timeToResolutionSec, obImbalance = 0, drift = 0, volatility = 0 }) {
    const { direction_filter, max_trade_size, kelly_cap } = this.settings;

    if (!currentPrice || priceHistory.length < 5) return null;

    // Don't evaluate in first 60 seconds of window — delta is not meaningful yet
    if (timeToResolutionSec > 240) {
      const log = { timestamp: new Date().toISOString(), verdict: 'WAIT', reason: `Too early in window (${(300-timeToResolutionSec).toFixed(0)}s elapsed) — waiting for delta to form` };
      this._emit(log);
      return null;
    }

    // Update window open tracking — use Chainlink as ground truth when available
    this.updateWindowOpen(currentPrice, chainlinkPrice);

    const log = { timestamp: new Date().toISOString(), btc_price: currentPrice.toFixed(2), binance_price: binancePrice?.toFixed(2), chainlink_price: chainlinkPrice?.toFixed(2), time_to_res: Math.round(timeToResolutionSec) + 's' };

    let score = 0;

    // ── 1. WINDOW DELTA (weight 5-7) — THE dominant signal ─────────────────
    let windowDeltaScore = 0;
    if (this.windowOpenPrice) {
      // Use Chainlink price for window delta if available — same oracle as resolution
      const deltaPrice = chainlinkPrice || currentPrice;
      const windowPct = (deltaPrice - this.windowOpenPrice) / this.windowOpenPrice * 100;
      if (Math.abs(windowPct) > 0.10) windowDeltaScore = Math.sign(windowPct) * 7;
      else if (Math.abs(windowPct) > 0.02) windowDeltaScore = Math.sign(windowPct) * 5;
      else if (Math.abs(windowPct) > 0.005) windowDeltaScore = Math.sign(windowPct) * 3;
      else if (Math.abs(windowPct) > 0.001) windowDeltaScore = Math.sign(windowPct) * 1;
      log.window_open = this.windowOpenPrice.toFixed(2);
      log.window_pct = windowPct.toFixed(4) + '%';
      log.window_delta_score = windowDeltaScore;
    }
    score += windowDeltaScore;

    // ── HYBRID MODE DETECTION ────────────────────────────────────────────────
    // Large window delta (>0.10%) = MOMENTUM mode — ride the trend
    // Small window delta (<0.02%) = MEAN REVERSION mode — fade extremes
    let windowPctAbs = 0;
    if (this.windowOpenPrice) {
      const deltaPrice = chainlinkPrice || currentPrice;
      windowPctAbs = Math.abs((deltaPrice - this.windowOpenPrice) / this.windowOpenPrice * 100);
    }
    const mode = windowPctAbs > 0.10 ? 'MOMENTUM' : windowPctAbs < 0.02 ? 'MEAN_REVERSION' : 'NEUTRAL';
    log.strategy_mode = mode;

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

    // ── 4. VELOCITY-WEIGHTED EMA (weight 1-2) ──────────────────────────────
    let emaScore = 0;
    if (priceHistory.length >= 21) {
      const ema9 = this._ema(priceHistory.slice(-9), 9);
      const ema21 = this._ema(priceHistory.slice(-21), 21);
      const ema9Prev = priceHistory.length >= 12 ? this._ema(priceHistory.slice(-12, -3), 9) : ema9;
      const emaVelocity = Math.abs((ema9 - ema9Prev) / ema9Prev);
      if (ema9 > ema21) {
        emaScore = emaVelocity > 0.001 ? 2 : 1;
      } else {
        emaScore = emaVelocity > 0.001 ? -2 : -1;
      }
    }
    score += emaScore;
    log.ema_score = emaScore;

    // ── 5. MOMENTUM RSI (weight 1-3) — Confirm momentum, not just extremes ──
    let rsiScore = 0;
    if (priceHistory.length >= 15) {
      const rsi = this._rsi(priceHistory.slice(-15), 14);
      log.rsi = rsi.toFixed(1);
      if (rsi > 75) rsiScore = -2;        // Overbought reversal signal
      else if (rsi < 25) rsiScore = 2;    // Oversold bounce signal
      else if (rsi > 60 && rsi <= 75) rsiScore = 1;   // Strong upward momentum
      else if (rsi < 40 && rsi >= 25) rsiScore = -1;  // Strong downward momentum
      // 40-60 neutral: 0 weight

      // Hybrid mode: mean-reversion doubles RSI weight, momentum suppresses contradictory RSI
      if (mode === 'MEAN_REVERSION') {
        rsiScore *= 2;
        log.rsi_mode = 'MEAN_REV_2x';
      } else if (mode === 'MOMENTUM' && Math.sign(rsiScore) !== Math.sign(windowDeltaScore)) {
        rsiScore = 0;
        log.rsi_mode = 'SUPPRESSED';
      }
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

    // ── 8. ORDER BOOK IMBALANCE (weight 1.5) ────────────────────────────────
    let obScore = 0;
    if (Math.abs(obImbalance) > 0.15) {
      obScore = obImbalance > 0 ? 1.5 : -1.5;
    } else if (Math.abs(obImbalance) > 0.05) {
      obScore = obImbalance > 0 ? 0.5 : -0.5;
    }
    score += obScore;
    log.ob_score = obScore;
    log.ob_imbalance = typeof obImbalance === 'number' ? obImbalance.toFixed(3) : obImbalance;

    // ── 9. GBM DIVERGENCE (weight 2) — Model prob vs market price ───────────
    let divergenceScore = 0;
    if (this.windowOpenPrice && timeToResolutionSec > 0 && volatility) {
      const gbmProb = this._gbmProb(currentPrice, this.windowOpenPrice, drift, volatility, timeToResolutionSec);
      const estimatedMarketProb = this._estimateTokenPrice(Math.abs(score));
      const divergence = gbmProb - estimatedMarketProb;
      log.gbm_prob = (gbmProb * 100).toFixed(1) + '%';
      log.gbm_divergence = (divergence * 100).toFixed(1) + '%';
      if (Math.abs(divergence) > 0.10) divergenceScore = Math.sign(divergence) * 2;
      else if (Math.abs(divergence) > 0.05) divergenceScore = Math.sign(divergence) * 1;
      // Only apply if direction agrees with main signal direction
      if (Math.sign(divergenceScore) !== Math.sign(score)) divergenceScore = 0;
    }
    score += divergenceScore;
    log.divergence_score = divergenceScore;

    // ── COMPOSITE SCORE → CONFIDENCE ────────────────────────────────────────
    // Divide by 10 — accounts for 9 indicators: delta, momentum, accel, ema, rsi, vol, tick, ob, divergence
    const confidence = Math.min(Math.abs(score) / 10.0, 1.0);
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

    // Gate on absolute score — only trade with clear directional signal
    const minAbsScore = 3.0;
    if (Math.abs(score) < minAbsScore) {
      log.verdict = 'SKIP';
      log.reason = `Score |${score.toFixed(1)}| below minimum |${minAbsScore}| — weak signal`;
      this._emit(log);
      return null;
    }

    // Kelly sizing using TRUE edge: modelProb vs marketProb
    const entryPrice = this._estimateTokenPrice(Math.abs(score));
    const marketProb = entryPrice;
    // modelProb derived from signal strength: 50% + (confidence * 40%)
    // Ranges from 0.50 (no signal) to 0.90 (maximum confidence)
    const modelProb = 0.5 + (confidence * 0.4);
    // Edge = how much better we think the outcome is vs what market prices in
    const edge = modelProb - marketProb;
    // NO TRADE ZONE (Improvement 11): skip if edge is non-positive
    const minEdge = parseFloat(this.settings.min_edge) || 0.05;
    if (edge <= minEdge) {
      log.verdict = 'SKIP';
      log.reason = `Edge ${(edge*100).toFixed(1)}% below minEdge ${(minEdge*100).toFixed(1)}% — no trade zone`;
      this._emit(log);
      return null;
    }

    // b = payout ratio per dollar risked (net odds)
    const b = (1 / marketProb) - 1;
    const kellyFraction = (modelProb * b - (1 - modelProb)) / b;
    const size = Math.min(Math.max(0, kellyFraction) * kelly_cap * max_trade_size, max_trade_size);

    if (size < 0.50) {
      log.verdict = 'SKIP';
      log.reason = `Size $${size.toFixed(2)} too small`;
      this._emit(log);
      return null;
    }

    const ev = modelProb * (1 / marketProb - 1) - (1 - modelProb);
    log.verdict = 'TRADE';
    log.entry_price = entryPrice.toFixed(3);
    log.size = '$' + size.toFixed(2);
    log.model_prob = (modelProb*100).toFixed(1) + '%';
    log.market_prob = (marketProb*100).toFixed(1) + '%';
    log.edge = (edge*100).toFixed(1) + '%';
    log.reason = `Score ${score.toFixed(1)} | Conf ${(confidence*100).toFixed(0)}% | Edge ${(edge*100).toFixed(1)}% | ${direction} @ $${entryPrice.toFixed(3)} | Size $${size.toFixed(2)}`;
    this._emit(log);

    return {
      direction,
      entry_price: entryPrice,
      model_prob: modelProb,
      market_prob: marketProb,
      edge,
      expected_value: ev,
      size,
      fee: marketProb * 0.25 * Math.pow(marketProb * (1 - marketProb), 2) * size,
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

  _normalCDF(x) {
    // Abramowitz and Stegun approximation
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * x);
    const y = 1 - ((((a[4]*t+a[3])*t+a[2])*t+a[1])*t+a[0])*t*Math.exp(-x*x);
    return 0.5 * (1 + sign * y);
  }

  _gbmProb(currentPrice, windowOpenPrice, drift, volatility, T) {
    // P(S_T > S_0) using GBM formula
    // drift and volatility are per-second (from BinanceFeed)
    T = Math.max(T, 1);
    const vol = Math.max(volatility, 0.0001);
    const d = (Math.log(currentPrice/windowOpenPrice) + (drift - 0.5*vol*vol)*T) / (vol*Math.sqrt(T));
    return this._normalCDF(d);
  }

  _emit(log) {
    if (this.onDecision) this.onDecision(log);
  }
}

module.exports = { GBMSignalEngine };
