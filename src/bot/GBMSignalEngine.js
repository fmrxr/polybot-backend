/**
 * GBM Signal Engine — with full decision logging
 */

class GBMSignalEngine {
  constructor(settings) {
    this.settings = settings;
    this.consecutiveSignals = [];
    this.REQUIRED_CONFIRMATIONS = 3;
    this.onDecision = null; // callback(decisionLog) set by BotInstance
  }

  computeGBMProbability({ currentPrice, beatPrice, volatility, drift, timeToResolutionSec }) {
    const T = timeToResolutionSec / (365 * 24 * 3600);
    if (T <= 0) return 0.5;
    const sigma = volatility;
    const mu = drift - 0.5 * sigma * sigma;
    const logRatio = Math.log(beatPrice / currentPrice);
    const d1 = (mu * T - logRatio) / (sigma * Math.sqrt(T));
    return Math.max(0.01, Math.min(0.99, this._normalCDF(d1)));
  }

  marketAnchoredProb(modelProb, marketProb) {
    const MARKET_WEIGHT = 0.60;
    return MARKET_WEIGHT * marketProb + (1 - MARKET_WEIGHT) * modelProb;
  }

  adjustedDrift({ rawDrift, momentum, obImbalance, currentPrice, vwap }) {
    const mrSignal = (vwap - currentPrice) / currentPrice;
    return (rawDrift + 0.3 * momentum + 0.2 * obImbalance + 0.15 * mrSignal) * 0.4;
  }

  calculateFee(price, size) {
    return price * 0.25 * Math.pow(price * (1 - price), 2) * size;
  }

  calculateEV(prob, entryPrice) {
    const feePct = entryPrice * 0.25 * Math.pow(entryPrice * (1 - entryPrice), 2);
    const payout = (1 / entryPrice) - 1;
    return prob * payout * (1 - feePct) - (1 - prob);
  }

  kellySize(prob, entryPrice, maxTradeSize, kellyCap) {
    const b = (1 / entryPrice) - 1;
    const kelly = (prob * b - (1 - prob)) / b;
    return Math.min(Math.max(0, kelly * kellyCap) * maxTradeSize, maxTradeSize);
  }

  _emit(log) {
    if (this.onDecision) this.onDecision(log);
  }

  evaluate({
    currentPrice, beatPrice, marketProbUp,
    entryPriceUp, entryPriceDown, spread,
    volatility, drift, momentum, obImbalance,
    vwap, timeToResolutionSec, distanceToBeat
  }) {
    const { min_ev_threshold, min_prob_diff, market_prob_min, market_prob_max,
            direction_filter, max_trade_size, kelly_cap } = this.settings;

    const base = {
      btc_price: currentPrice.toFixed(2),
      beat_price: beatPrice.toFixed(2),
      distance: distanceToBeat.toFixed(2),
      market_prob_up: (marketProbUp * 100).toFixed(1) + '%',
      spread: spread.toFixed(3),
      volatility: (volatility * 100).toFixed(3) + '%',
      momentum: momentum ? (momentum * 100).toFixed(3) + '%' : '—',
      time_to_res: Math.round(timeToResolutionSec) + 's',
      confirmations: this.consecutiveSignals.length + '/' + this.REQUIRED_CONFIRMATIONS,
      timestamp: new Date().toISOString()
    };

    // Filter 1: Distance
    if (distanceToBeat < 30 || distanceToBeat > 100) {
      this._emit({ ...base, verdict: 'SKIP', reason: `Distance $${distanceToBeat.toFixed(0)} outside $30–$100 range` });
      return null;
    }

    // Filter 2: Market probability zone
    if (marketProbUp < market_prob_min || marketProbUp > market_prob_max) {
      this._emit({ ...base, verdict: 'SKIP', reason: `Market prob ${(marketProbUp*100).toFixed(1)}% outside uncertainty zone (${(market_prob_min*100).toFixed(0)}–${(market_prob_max*100).toFixed(0)}%)` });
      return null;
    }

    // Filter 3: Spread
    if (spread > 0.15) {
      this._emit({ ...base, verdict: 'SKIP', reason: `Spread ${spread.toFixed(3)} too wide (max 0.15) — market illiquid` });
      return null;
    }

    // Compute model probability
    const adjDrift = this.adjustedDrift({ rawDrift: drift, momentum, obImbalance, currentPrice, vwap });
    const modelProbUp = this.computeGBMProbability({ currentPrice, beatPrice, volatility, drift: adjDrift, timeToResolutionSec });
    const anchoredProbUp = this.marketAnchoredProb(modelProbUp, marketProbUp);
    const anchoredProbDown = 1 - anchoredProbUp;

    const evUp = this.calculateEV(anchoredProbUp, entryPriceUp);
    const evDown = this.calculateEV(anchoredProbDown, entryPriceDown);
    const probDiffUp = anchoredProbUp - entryPriceUp;
    const probDiffDown = anchoredProbDown - entryPriceDown;

    const modelInfo = {
      ...base,
      model_prob_up: (modelProbUp * 100).toFixed(1) + '%',
      anchored_prob_up: (anchoredProbUp * 100).toFixed(1) + '%',
      ev_up: (evUp * 100).toFixed(1) + '%',
      ev_down: (evDown * 100).toFixed(1) + '%',
      prob_diff_up: (probDiffUp * 100).toFixed(1) + '%',
      prob_diff_down: (probDiffDown * 100).toFixed(1) + '%',
    };

    // Filter 4: EV + prob diff
    let direction = null, entryPrice = null, finalProb = null;

    if (direction_filter !== 'DOWN') {
      if (evUp >= min_ev_threshold && probDiffUp >= min_prob_diff) {
        direction = 'UP'; entryPrice = entryPriceUp; finalProb = anchoredProbUp;
      }
    }
    if (!direction && direction_filter !== 'UP') {
      if (evDown >= min_ev_threshold && probDiffDown >= min_prob_diff) {
        direction = 'DOWN'; entryPrice = entryPriceDown; finalProb = anchoredProbDown;
      }
    }

    if (!direction) {
      const bestEv = Math.max(evUp, evDown);
      const reason = bestEv > 0
        ? `Best EV ${(bestEv*100).toFixed(1)}% below threshold ${(min_ev_threshold*100).toFixed(0)}% — edge not strong enough`
        : `Negative EV — both directions unfavorable at current prices`;
      this._emit({ ...modelInfo, verdict: 'SKIP', reason });
      this.consecutiveSignals = [];
      return null;
    }

    // Filter 5: Multi-signal confirmation
    this.consecutiveSignals.push(direction);
    if (this.consecutiveSignals.length > this.REQUIRED_CONFIRMATIONS) this.consecutiveSignals.shift();

    const confirmCount = this.consecutiveSignals.filter(s => s === direction).length;

    if (this.consecutiveSignals.length < this.REQUIRED_CONFIRMATIONS || !this.consecutiveSignals.every(s => s === direction)) {
      this._emit({ ...modelInfo, verdict: 'WAIT', direction, reason: `Confirmation ${confirmCount}/${this.REQUIRED_CONFIRMATIONS} — waiting for 3 consecutive ${direction} signals` });
      return null;
    }

    this.consecutiveSignals = [];

    const ev = this.calculateEV(finalProb, entryPrice);
    const size = this.kellySize(finalProb, entryPrice, max_trade_size, kelly_cap);

    if (size < 0.50) {
      this._emit({ ...modelInfo, verdict: 'SKIP', reason: `Kelly size $${size.toFixed(2)} too small (min $0.50)` });
      return null;
    }

    this._emit({
      ...modelInfo,
      verdict: 'TRADE',
      direction,
      entry_price: entryPrice.toFixed(3),
      final_ev: (ev * 100).toFixed(1) + '%',
      size: '$' + size.toFixed(2),
      reason: `All filters passed — ${direction} @ ${entryPrice.toFixed(3)} | EV ${(ev*100).toFixed(1)}% | Size $${size.toFixed(2)}`
    });

    return {
      direction, entry_price: entryPrice,
      model_prob: modelProbUp, market_prob: marketProbUp,
      anchored_prob: finalProb, expected_value: ev, size,
      fee: this.calculateFee(entryPrice, size)
    };
  }

  _normalCDF(x) {
    const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
    return 0.5 * (1.0 + sign * y);
  }
}

module.exports = { GBMSignalEngine };
