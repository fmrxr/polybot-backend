/**
 * Signal Engine — Phase A: Three-Gate Cost-Aware Decision Logic
 *
 * GATE SEQUENCE (unbreakable order):
 * 1. Microstructure Edge (BTC/Poly latency) → confidence >= 0.45
 * 2. EV Cost Adjustment (fees + spread + slippage) → recommend() == 'TRADE'
 * 3. Signal Confirmation (weak RSI/EMA only) → direction match
 *
 * Then execute with dynamic position sizing.
 *
 * Historical scoring still active as fallback confirmation.
 */

const { EVEngine } = require('./EVEngine');
const { MicrostructureEngine } = require('./MicrostructureEngine');

class GBMSignalEngine {
  constructor(settings) {
    this.settings = settings;
    this.onDecision = null;

    // Phase A engines
    this.evEngine = new EVEngine();
    this.microEngine = new MicrostructureEngine();
    this.USE_NEW_STRATEGY = true; // Feature flag: toggle on/off instantly

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
   * Main signal evaluation — Phase A: Three-Gate Decision Logic
   *
   * GATE SEQUENCE:
   * 1. Microstructure Edge Detection (requires latency + depth signal)
   * 2. EV Cost Adjustment (fees + spread + slippage)
   * 3. Signal Confirmation (weak RSI/EMA)
   */
  evaluate({ currentPrice, binancePrice, chainlinkPrice, priceHistory, volumeHistory, timeToResolutionSec, obImbalance = 0, drift = 0, volatility = 0, bid = null, ask = null, bidDepth = null, askDepth = null, totalDepth = null }) {
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

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE A: THREE-GATE DECISION LOGIC (Feature-flagged, safe fallback)
    // ═══════════════════════════════════════════════════════════════════════════

    if (this.USE_NEW_STRATEGY) {
      try {
        // 🔴 GATE 1: MICROSTRUCTURE EDGE DETECTION
        // Requires: BTC moves fast AND Polymarket lags (latency + order imbalance)
        const micro = this.microEngine.composite({
          btcPrice: currentPrice,
          polyPrice: chainlinkPrice || currentPrice,
          bidSize: bidDepth || 100,
          askSize: askDepth || 100,
          largestBid: bid || (currentPrice * 0.995),
          largestAsk: ask || (currentPrice * 1.005),
          totalDepth: totalDepth || 1000,
          avgOrderSize: totalDepth ? totalDepth / 50 : 20,
          volatility: volatility
        });

        if (!micro || micro.confidence < 0.45) {
          const reason = `Gate 1 FAILED: Microstructure confidence ${micro ? (micro.confidence*100).toFixed(1) : '0'}% < 45% threshold (no latency edge)`;
          log.verdict = 'SKIP';
          log.reason = reason;
          log.micro_confidence = micro ? (micro.confidence*100).toFixed(1) + '%' : 'N/A';
          log.micro_threshold = '45%';
          log.gate_failed = 1;
          this._emit(log);
          return null;
        }

        // ⚠️ CRITICAL: Add market lag condition (not just confidence)
        // Without this → still trading fake signals
        if (!micro.hasMarketLag) {
          const reason = `Gate 1.5 FAILED: No market lag detected (confidence ${(micro.confidence*100).toFixed(1)}% alone is not enough)`;
          log.verdict = 'SKIP';
          log.reason = reason;
          log.micro_confidence = (micro.confidence*100).toFixed(1) + '%';
          log.micro_has_lag = false;
          log.gate_failed = 1.5;
          this._emit(log);
          return null;
        }

        // ✅ Gate 1 passed — we have REAL microstructure edge (confidence + market lag)

        // 🟡 GATE 2: EV COST ADJUSTMENT
        // Calculate: EV_raw - (spread + slippage) >= 3% minimum
        // Use modelProb tied directly to latency edge strength
        const modelProb = 0.5 + (micro.confidence - 0.5) * 0.6; // Key fix: ties to edge strength
        const marketProb = chainlinkPrice || currentPrice; // Market price is entry price

        const ev = this.evEngine.recommend({
          priceYes: chainlinkPrice || currentPrice,
          bid: bid || (currentPrice * 0.995),
          ask: ask || (currentPrice * 1.005),
          modelProb,
          direction: obImbalance > 0 ? 'UP' : 'DOWN',
          orderSize: 20,
          marketDepth: totalDepth || 1000,
          volatility: volatility,
          btcDelta: this.windowOpenPrice ? (currentPrice - this.windowOpenPrice) / this.windowOpenPrice : 0,
          hasMarketLag: true, // Gate 1 confirmed this
          recentWinRate: 0.5,
          avgSlippage: 0.1
        });

        if (ev.recommended !== 'TRADE') {
          const reason = `Gate 2 FAILED: ${ev.reason}`;
          log.verdict = 'SKIP';
          log.reason = reason;
          log.ev_adjusted = (ev.ev_adjusted*100).toFixed(2) + '%';
          log.ev_threshold = (ev.threshold*100).toFixed(2) + '%';
          log.total_cost = (ev.total_cost*100).toFixed(2) + '%';
          log.gate_failed = 2;
          this._emit(log);
          return null;
        }

        // ⚠️ CRITICAL: Hard floor on EV_adj (even if recommend() says TRADE)
        // Protects against borderline noise trades at the margin
        if (ev.ev_adjusted < 0.03) {
          const reason = `Gate 2.5 FAILED: EV_adj ${(ev.ev_adjusted*100).toFixed(2)}% below hard floor 3% (recommend says TRADE but signal is marginal)`;
          log.verdict = 'SKIP';
          log.reason = reason;
          log.ev_adjusted = (ev.ev_adjusted*100).toFixed(2) + '%';
          log.ev_hard_floor = '3%';
          log.gate_failed = 2.5;
          this._emit(log);
          return null;
        }

        // ✅ Gate 2 passed — EV is solid positive after costs (≥3%)

        // 🟢 GATE 3: SIGNAL CONFIRMATION (WEAK)
        // Compute old signal for directional confirmation only
        // Use reduced weight: score / 10.0 instead of 7.0
        // Only confirm if direction aligns with macro signal

      } catch (gateError) {
        console.error('[Phase A] Gate system error:', gateError.message, gateError.stack);
        // Safe fallback: if new system fails, skip trade
        const log_error = { timestamp: new Date().toISOString(), verdict: 'SKIP', reason: `Gate system error: ${gateError.message}`, error: true };
        this._emit(log_error);
        return null;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONFIRMATION: Historical signal scoring (reduced weight, confirmation only)
    // ═══════════════════════════════════════════════════════════════════════════


    let score = 0;
    let microData = null;
    let evData = null;

    // If gates passed (new strategy), reuse gate data for sizing
    if (this.USE_NEW_STRATEGY && log.gate_failed === undefined) {
      // Gates passed — derive direction from microstructure signal
      microData = {
        confidence: micro?.confidence || 0,
        signal: micro?.signal || 0
      };
      evData = ev;
      // Direction confirmed by gates
      const gateDirection = obImbalance > 0 ? 'UP' : 'DOWN';
      log.gates_passed = true;
      log.gate_direction = gateDirection;
    }

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

    // ⚠️ GATE 3: ASYMMETRIC CONFIRMATION (forces directional alignment)
    // After gates 1-2 pass, require EMA to actually align with direction
    // No neutral signals allowed — only aligned pressure
    if (this.USE_NEW_STRATEGY && log.gates_passed) {
      const gateDir = log.gate_direction; // Set by gates 1-2
      const isBullishEMA = emaScore > 0;
      const isBearishEMA = emaScore < 0;

      if (gateDir === 'UP' && !isBullishEMA) {
        log.verdict = 'SKIP';
        log.reason = `Gate 3 FAILED: Direction UP but EMA_score ${emaScore} is not bullish (no aligned pressure)`;
        log.ema_confirmation = 'MISALIGNED';
        log.gate_failed = 3;
        this._emit(log);
        return null;
      }

      if (gateDir === 'DOWN' && !isBearishEMA) {
        log.verdict = 'SKIP';
        log.reason = `Gate 3 FAILED: Direction DOWN but EMA_score ${emaScore} is not bearish (no aligned pressure)`;
        log.ema_confirmation = 'MISALIGNED';
        log.gate_failed = 3;
        this._emit(log);
        return null;
      }

      log.ema_confirmation = 'ALIGNED';
    }

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

    // Adaptive thresholds based on volatility
    const baseMinConfidence = parseFloat(this.settings.min_ev_threshold) || 0.05;
    const typicalVolatility = 0.02; // ~2% considered "normal"
    const volatilityRatio = Math.max(0.5, Math.min(2.0, Math.sqrt((volatility || 0.01) / typicalVolatility)));
    const minConfidence = baseMinConfidence * volatilityRatio;

    log.volatility_ratio = volatilityRatio.toFixed(2);
    log.adapted_min_confidence = (minConfidence * 100).toFixed(1) + '%';

    if (confidence < minConfidence) {
      log.verdict = 'SKIP';
      log.reason = `Confidence ${(confidence*100).toFixed(1)}% below threshold ${(minConfidence*100).toFixed(1)}% (vol-adjusted from ${(baseMinConfidence*100).toFixed(1)}%)`;
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

    // ── FINAL DECISION: Use gate data if available, otherwise use scoring ────
    let entryPrice, marketProb, modelProb, edge, size, finalConfidence, expectedValue, finalDirection;

    if (evData && log.gates_passed) {
      // Gates passed: use EV data for final decision
      finalDirection = log.gate_direction;
      entryPrice = chainlinkPrice || currentPrice;
      marketProb = entryPrice;
      modelProb = 0.5 + (microData.confidence - 0.5) * 0.6;
      edge = modelProb - marketProb;
      finalConfidence = microData.confidence;
      expectedValue = evData.ev_adjusted;

      // Size based on gate EV + Kelly
      const b = (1 / marketProb) - 1;
      const kellyFraction = (modelProb * b - (1 - modelProb)) / b;
      size = Math.min(Math.max(0, kellyFraction) * kelly_cap * max_trade_size, max_trade_size);

      log.verdict = 'TRADE';
      log.reason = `✅ Gates passed | Micro ${(microData.confidence*100).toFixed(1)}% | EV_adj ${(evData.ev_adjusted*100).toFixed(1)}% | ${finalDirection}`;
      log.entry_price = entryPrice.toFixed(3);
      log.size = '$' + size.toFixed(2);
      log.model_prob = (modelProb*100).toFixed(1) + '%';
      log.market_prob = (marketProb*100).toFixed(1) + '%';
      log.edge = (edge*100).toFixed(1) + '%';
      log.micro_confidence = (microData.confidence*100).toFixed(1) + '%';
      log.ev_adjusted = (evData.ev_adjusted*100).toFixed(2) + '%';

    } else {
      // Fallback: use old scoring system
      entryPrice = this._estimateTokenPrice(Math.abs(score));
      marketProb = entryPrice;
      modelProb = 0.5 + (confidence * 0.4);
      edge = modelProb - marketProb;
      finalConfidence = confidence;
      finalDirection = direction;

      const baseMinEdge = parseFloat(this.settings.min_edge) || 0.03;
      const adaptiveMinEdge = baseMinEdge * volatilityRatio;

      log.edge = (edge * 100).toFixed(1) + '%';
      log.adapted_min_edge = (adaptiveMinEdge * 100).toFixed(1) + '%';

      if (edge <= adaptiveMinEdge) {
        log.verdict = 'SKIP';
        log.reason = `Edge ${(edge*100).toFixed(1)}% below minEdge ${(adaptiveMinEdge*100).toFixed(1)}%`;
        this._emit(log);
        return null;
      }

      const b = (1 / marketProb) - 1;
      const kellyFraction = (modelProb * b - (1 - modelProb)) / b;
      size = Math.min(Math.max(0, kellyFraction) * kelly_cap * max_trade_size, max_trade_size);

      if (size < 0.50) {
        log.verdict = 'SKIP';
        log.reason = `Size $${size.toFixed(2)} too small`;
        this._emit(log);
        return null;
      }

      expectedValue = modelProb * (1 / marketProb - 1) - (1 - modelProb);
      log.verdict = 'TRADE';
      log.entry_price = entryPrice.toFixed(3);
      log.size = '$' + size.toFixed(2);
      log.model_prob = (modelProb*100).toFixed(1) + '%';
      log.market_prob = (marketProb*100).toFixed(1) + '%';
      log.edge = (edge*100).toFixed(1) + '%';
      log.reason = `Score ${score.toFixed(1)} | Conf ${(confidence*100).toFixed(0)}% | Edge ${(edge*100).toFixed(1)}% | ${direction} @ $${entryPrice.toFixed(3)}`;
    }

    if (size < 0.50) {
      log.verdict = 'SKIP';
      log.reason = `Size $${size.toFixed(2)} too small`;
      this._emit(log);
      return null;
    }

    this._emit(log);

    return {
      direction: finalDirection,
      entry_price: entryPrice,
      model_prob: modelProb,
      market_prob: marketProb,
      edge,
      expected_value: expectedValue,
      size,
      fee: marketProb * 0.25 * Math.pow(marketProb * (1 - marketProb), 2) * size,
      confidence: finalConfidence,
      score,
      gates_passed: log.gates_passed || false,
      micro_confidence: microData?.confidence || 0,
      ev_adjusted: evData?.ev_adjusted || 0
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
    for (let i = 1; i < period; i++) {
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
