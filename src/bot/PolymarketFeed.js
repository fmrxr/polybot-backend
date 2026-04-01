// Ensure Web Crypto API is available for ethers.js wallet signing
if (!globalThis.crypto) {
  const crypto = require('crypto');
  globalThis.crypto = crypto;
}

const axios = require('axios');
const { ethers } = require('ethers');

const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

class PolymarketFeed {
  constructor(privateKey, userApiKey = null, funderAddress = null) {
    this.privateKey = privateKey;
    this.userApiKey = userApiKey;
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.funderAddress = funderAddress || this.address; // Use provided funder address or fallback to wallet address
    this.clobClient = null;
    this.OrderType = null;
    this.Side = null;
    this.markets = new Map();
    this.activeMarkets = [];
    this.isConnected = false;
  }

  async init() {
    console.log(`[PolymarketFeed] init() called for address ${this.address}`);
    try {
      // Dynamic import for ESM module
      console.log(`[PolymarketFeed] Attempting to import SDK modules...`);
      const { ClobClient, OrderType, Side } = await import('@polymarket/clob-client');
      this.OrderType = OrderType;
      this.Side = Side;
      console.log(`[PolymarketFeed] ✅ SDK modules imported`);

      // Step 1: Create temp client to derive L2 API credentials
      try {
        const tempClient = new ClobClient(POLYMARKET_CLOB_API, CHAIN_ID, this.wallet);
        console.log(`[PolymarketFeed] Temp client created`);

        const apiCreds = await tempClient.createOrDeriveApiKey();
        console.log(`[PolymarketFeed] API credentials derived for ${this.address}`);

        // Step 2: Create trading client with L2 credentials
        // Signature type 2 = GNOSIS_SAFE (Polymarket proxy wallet)
        // This is the standard type for users who log into Polymarket with MetaMask/browser wallet
        console.log(`[PolymarketFeed] Using funder address: ${this.funderAddress}`);
        this.clobClient = new ClobClient(
          POLYMARKET_CLOB_API,
          CHAIN_ID,
          this.wallet,
          apiCreds,
          2, // GNOSIS_SAFE - Polymarket proxy wallet type
          this.funderAddress
        );
        console.log(`[PolymarketFeed] Trading client created`);

        this.isConnected = true;
        console.log(`[PolymarketFeed] ✅ Initialized trading client for ${this.address}`);
      } catch(initErr) {
        console.error('[PolymarketFeed] Client initialization failed:', initErr.message);
        throw initErr;
      }
    } catch(e) {
      console.error('[PolymarketFeed] Failed to initialize CLOB client - full error:', e);
      // Continue without CLOB client — market discovery still works
    }
  }

  _extractClobTokenIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
      } catch (_) {}
      return value
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
    }
    if (typeof value === 'object') {
      if ('yes' in value || 'Yes' in value || 'no' in value || 'No' in value) {
        return [value.yes || value.Yes, value.no || value.No].filter(Boolean);
      }
      if ('0' in value || '1' in value) {
        return [value[0], value[1]].filter(Boolean);
      }
      return Object.values(value).filter(Boolean);
    }
    return [];
  }

  _getMarketWindowTs(market, event = {}) {
    const slug = String(market.slug || market.market_slug || event.slug || '').toLowerCase();
    const match = slug.match(/btc-updown-5m-(\d+)/);
    if (match) return parseInt(match[1], 10);

    const end = market.endDate || market.endDateIso || event.endDate;
    if (end) {
      const endSec = Math.floor(new Date(end).getTime() / 1000);
      if (!Number.isNaN(endSec)) return endSec - 300;
    }

    return null;
  }

  _normalizeMarketTokens(market, event = {}) {
    if (market.tokens && !Array.isArray(market.tokens)) {
      if (typeof market.tokens === 'string') {
        try {
          market.tokens = JSON.parse(market.tokens);
        } catch (_) {
          market.tokens = market.tokens.split(',').map(v => v.trim()).filter(Boolean);
        }
      } else if (typeof market.tokens === 'object') {
        market.tokens = Object.values(market.tokens).filter(Boolean);
      }
    }

    if (market.tokens && Array.isArray(market.tokens) && market.tokens.length > 0) return market;

    if (event.markets?.length === 1 && event.tokens && Array.isArray(event.tokens) && event.tokens.length > 0) {
      market.tokens = event.tokens;
      return market;
    }

    const tokenIds = this._extractClobTokenIds(market.clobTokenIds);
    if (tokenIds.length > 0) {
      market.tokens = tokenIds.map((id, i) => ({ token_id: id, outcome: i === 0 ? 'Yes' : 'No' }));
    }

    if (!market.windowTs) {
      const windowTs = this._getMarketWindowTs(market, event);
      if (windowTs) market.windowTs = windowTs;
    }

    return market;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async fetchActiveBTCMarkets() {
    try {
      const windowTs = this.getCurrentWindowTs();
      const offsets = [0, -300, 300, -600, 600, -900, 900];
      const slugs = [...new Set(offsets.map(offset => `btc-updown-5m-${windowTs + offset}`))];
      const found = [];
      const maxAttempts = 5;

      for (let attempt = 1; attempt <= maxAttempts && found.length === 0; attempt++) {
        if (attempt > 1) {
          console.log(`[PolymarketFeed] Retrying slug search (${attempt}/${maxAttempts})...`);
          await this._delay(2500);
        }

        for (const slug of slugs) {
          try {
            const response = await axios.get(`${POLYMARKET_GAMMA_API}/events`, {
              params: { slug },
              timeout: 8000
            });

            const events = Array.isArray(response.data) ? response.data : [response.data];

            for (const event of events) {
              if (!event || !event.markets) continue;
              for (const market of event.markets) {
                this._normalizeMarketTokens(market, event);
                const end = market.endDate || market.endDateIso || event.endDate;
                const secsToRes = end ? (new Date(end).getTime() - Date.now()) / 1000 : -1;
                if (secsToRes > 10) {
                  if (!market.tokens || market.tokens.length === 0) {
                    this._normalizeMarketTokens(market, event);
                  }
                  const clobIds = this._extractClobTokenIds(market.clobTokenIds);
                  console.log(`[PolymarketFeed] ✅ Found market via slug ${slug}: "${market.question}" | ${Math.round(secsToRes)}s | tokens: ${(market.tokens||[]).length} | clobTokenIds: ${clobIds.length}`);
                  found.push(market);
                }
              }
            }
          } catch (e) {
            // Silently skip failed slugs
          }
        }

        if (found.length === 0 && attempt < maxAttempts) {
          console.log('[PolymarketFeed] No markets found yet; waiting before retrying...');
        }
      }

      if (found.length === 0) {
        console.log('[PolymarketFeed] Slug approach found nothing — trying direct search...');
        try {
          const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets`, {
            params: { active: true, closed: false, limit: 300, search: 'btc-updown-5m' },
            timeout: 8000
          });
          const markets = Array.isArray(response.data) ? response.data : (response.data?.markets || []);
          const now = Date.now();
          for (const m of markets) {
            const end = m.endDate || m.endDateIso;
            const secsToRes = end ? (new Date(end).getTime() - now) / 1000 : -1;
            const slug = String(m.slug || m.market_slug || '').toLowerCase();
            const q = String(m.question || m.title || '').toLowerCase();
            if (secsToRes > 10 && secsToRes < 7200 && (slug.startsWith('btc-updown-5m-') || q.includes('btc') || q.includes('bitcoin'))) {
              this._normalizeMarketTokens(m);
              console.log(`[PolymarketFeed] Fallback found: "${m.question || m.title || '?'}" | ${Math.round(secsToRes)}s`);
              found.push(m);
            }
          }
        } catch (e) {
          console.error('[PolymarketFeed] Fallback search failed:', e.message);
        }
      }

      found.sort((a, b) => (a.windowTs || Infinity) - (b.windowTs || Infinity));
      this.activeMarkets = found;
      console.log(`[PolymarketFeed] Active markets: ${found.length}`);
      return found;

    } catch (err) {
      console.error('[PolymarketFeed] fetchActiveBTCMarkets error:', err.message);
      return [];
    }
  }

  getCurrentWindowTs() {
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - (nowSec % 300);
  }

  async placeOrder({ tokenId, side, price, size, conditionId }) {
    try {
      if (!this.clobClient) {
        throw new Error('CLOB client not initialized — check API credentials');
      }

      if (!this.OrderType || !this.Side) {
        throw new Error('SDK enums not initialized — call init() first');
      }

      // Use official SDK to place order with proper authentication
      const orderSide = side === 'BUY' ? this.Side.BUY : this.Side.SELL;
      console.log(`[PolymarketFeed] Placing order: ${orderSide} ${size} shares @ $${price}`);

      const response = await this.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: parseFloat(price),
          size: parseFloat(size),
          side: orderSide
        },
        {
          tickSize: '0.01',
          negRisk: false
        },
        this.OrderType.GTC  // Good-Til-Cancelled order type
      );

      console.log(`[PolymarketFeed] Full order response:`, JSON.stringify(response, null, 2));
      console.log(`[PolymarketFeed] Response keys:`, Object.keys(response || {}));
      console.log(`[PolymarketFeed] Response.success:`, response?.success);
      console.log(`[PolymarketFeed] Response.errorMsg:`, response?.errorMsg);

      if (!response || !response.success) {
        console.error('[PolymarketFeed] Order rejected by CLOB');
        console.error('[PolymarketFeed] Error message:', response?.errorMsg || 'None');
        console.error('[PolymarketFeed] Full response body:', response);
      }

      return {
        orderID: response?.orderID,
        id: response?.orderID,
        status: response?.status
      };
    } catch (err) {
      console.error('[PolymarketFeed] Order failed:', err.message);
      console.error('[PolymarketFeed] Full error:', err);
      throw new Error(err.message || 'Order placement failed');
    }
  }

  async getOrderStatus(orderId) {
    try {
      if (!this.clobClient) return null;
      // Use getOrder() to fetch single order, or getOpenOrders() to list all
      const order = await this.clobClient.getOrder(orderId);
      if (!order) return null;
      const originalSize = parseFloat(order.original_size || 0);
      const matched = parseFloat(order.size_matched || 0);
      return {
        status: order.status || 'UNKNOWN',
        size_matched: matched,
        size_remaining: Math.max(0, originalSize - matched)
      };
    } catch (err) {
      throw new Error(`Order status check failed: ${err.message}`);
    }
  }

  async checkResolution(conditionId) {
    try {
      const response = await axios.get(`${POLYMARKET_GAMMA_API}/markets/${conditionId}`, {
        timeout: 5000
      });
      const market = response.data;
      return { resolved: market.closed || market.resolved, outcome: market.outcomePrices };
    } catch (err) {
      return { resolved: false };
    }
  }

  disconnect() {
    // Cleanup
  }
}

module.exports = { PolymarketFeed };
