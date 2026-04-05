// MARKET_SLUG: polymarket.com/event/MARKET_SLUG
const MARKET_SLUG = "auto";

const OUTCOME_MAP = { "En hausse": "Yes", "En baisse": "No" };
const GAMMA_API   = "https://gamma-api.polymarket.com";
const CLOB_API    = "https://clob.polymarket.com";
const REFRESH_MS  = 7000;

let marketCache   = null;
let lastPrices    = {};
let marketStaleAt = 0;

// ─── 1. Market discovery ────────────────────────────────────────────────────

async function resolveSlug() {
  if (MARKET_SLUG !== "auto") return MARKET_SLUG;

  const nowSec = Math.floor(Date.now() / 1000);
  const base   = Math.floor(nowSec / 300) * 300;

  for (const t of [base, base + 300, base - 300]) {
    const slug = `btc-updown-5m-${t}`;
    const res = await fetch(`${GAMMA_API}/markets/slug/${slug}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) return slug;
  }

  throw new Error("No active 5m BTC market");
}

async function fetchMarket() {
  const slug = await resolveSlug();

  const res = await fetch(`${GAMMA_API}/markets/slug/${slug}`, {
    signal: AbortSignal.timeout(5000)
  });

  if (!res.ok) throw new Error("Market fetch failed");

  const m = await res.json();

  let ids = m.clobTokenIds;
  if (typeof ids === "string") ids = JSON.parse(ids);

  const outcomes = m.outcomes || ["Yes", "No"];

  const tokenMap = {};
  outcomes.forEach((o, i) => tokenMap[o] = ids[i]);

  const endMs = new Date(m.endDate || m.end_date_iso).getTime();
  marketStaleAt = endMs > Date.now() ? endMs : Date.now() + 30000;

  return { slug, tokenMap };
}

async function getMarket() {
  if (marketCache && Date.now() < marketStaleAt) return marketCache;
  marketCache = await fetchMarket();
  return marketCache;
}

// ─── 2. Live price ──────────────────────────────────────────────────────────

async function getLivePrice(tokenId) {
  const res = await fetch(`${CLOB_API}/lastTradePrice?token_id=${tokenId}`, {
    signal: AbortSignal.timeout(4000)
  });

  if (!res.ok) throw new Error("Price fetch failed");

  const { price } = await res.json();
  const p = parseFloat(price);

  if (!p || p <= 0 || p >= 1) throw new Error("Invalid price");

  return Math.round(p * 100);
}

// ─── 3. UI update ───────────────────────────────────────────────────────────

function updateButtons(outcomeName, cents) {
  if (lastPrices[outcomeName] === cents) return;
  lastPrices[outcomeName] = cents;

  document.querySelectorAll(".trading-button").forEach(btn => {
    const labelEl = btn.querySelector(".opacity-70");
    if (!labelEl) return;

    const label = labelEl.textContent.trim();
    if (OUTCOME_MAP[label] !== outcomeName) return;

    const priceEl = btn.querySelector(".ml-1\\.5");
    if (priceEl) priceEl.textContent = `${cents}¢`;
  });
}

function setButtonsError() {
  document.querySelectorAll(".trading-button .ml-1\\.5").forEach(el => {
    el.textContent = "--";
  });
}

// ─── 4. Display refresh ─────────────────────────────────────────────────────

async function refreshDisplay() {
  try {
    const { tokenMap } = await getMarket();

    const entries = Object.entries(tokenMap);

    const results = await Promise.allSettled(
      entries.map(([_, id]) => getLivePrice(id))
    );

    results.forEach((res, i) => {
      const [outcome] = entries[i];
      if (res.status === "fulfilled") {
        updateButtons(outcome, res.value);
      } else {
        console.warn("Price failed:", outcome);
      }
    });

  } catch (err) {
    console.error("Display error:", err.message);
    setButtonsError();
  }
}

// ─── 5. Trade execution ──────────────────────────────────────────────────────

async function executeTrade(outcomeLabel, amountUSDC) {
  const outcomeName = OUTCOME_MAP[outcomeLabel];
  if (!outcomeName) throw new Error("Invalid outcome");

  const { tokenMap } = await getMarket();
  const tokenId = tokenMap[outcomeName];

  if (!tokenId) throw new Error("Missing tokenId");

  // Always fetch fresh price — never use cache or UI value
  const cents = await getLivePrice(tokenId);

  if (!cents || cents <= 0 || cents >= 100) {
    throw new Error("Unsafe price — abort trade");
  }

  const price = cents / 100;

  console.log(`TRADE ${outcomeName} @ ${cents}¢`);

  // PLACE ORDER HERE:
  // await polymarket.placeOrder({ tokenId, price, size: amountUSDC / price })

  return { tokenId, outcomeName, price, cents };
}

// ─── 6. Boot ────────────────────────────────────────────────────────────────

refreshDisplay();
setInterval(refreshDisplay, REFRESH_MS);
