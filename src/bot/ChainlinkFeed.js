const { ethers } = require('ethers');

const CHAINLINK_BTC_USD = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c';
const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)'
];

class ChainlinkFeed {
  constructor() {
    this.price = null;
    this.lastUpdate = null;
    this.updateInterval = null;
  }

  async start(intervalMs = 30000) {
    await this.fetchPrice();
    this.updateInterval = setInterval(() => this.fetchPrice(), intervalMs);
    console.log(`[ChainlinkFeed] Started with ${intervalMs}ms interval`);
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log('[ChainlinkFeed] Stopped');
  }

  async fetchPrice() {
    const rpcUrls = [
      process.env.ETH_RPC_URL,
      'https://ethereum.publicnode.com',
      'https://cloudflare-eth.com',
    ].filter(Boolean);

    for (const rpc of rpcUrls) {
      try {
        // ethers v6 API
        const provider = new ethers.JsonRpcProvider(rpc);
        const contract = new ethers.Contract(CHAINLINK_BTC_USD, CHAINLINK_ABI, provider);
        const [, answer, , updatedAt] = await contract.latestRoundData();

        // ethers v6: formatUnits is a top-level function
        this.price = parseFloat(ethers.formatUnits(answer, 8));
        this.lastUpdate = new Date(Number(updatedAt) * 1000);

        return this.price;
      } catch (err) {
        console.warn(`[ChainlinkFeed] RPC ${rpc} failed:`, err.message);
        continue;
      }
    }

    console.error('[ChainlinkFeed] All RPC endpoints failed');
    return null;
  }

  getPrice() {
    return this.price;
  }

  getLastUpdate() {
    return this.lastUpdate;
  }

  // Check if price is stale (older than maxAgeSeconds)
  isStale(maxAgeSeconds = 120) {
    if (!this.lastUpdate) return true;
    return (Date.now() - this.lastUpdate.getTime()) > (maxAgeSeconds * 1000);
  }
}

module.exports = ChainlinkFeed;
