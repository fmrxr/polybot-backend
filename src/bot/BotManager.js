const BotInstance = require('./BotInstance');
const CopyBotInstance = require('./CopyBotInstance');

class BotManager {
  constructor() {
    this.instances = new Map();       // userId -> BotInstance
    this.copyInstances = new Map();   // userId -> CopyBotInstance
  }

  async startBot(userId, settings) {
    // Stop existing instance if running
    if (this.instances.has(userId)) {
      await this.stopBot(userId);
    }

    const bot = new BotInstance(userId, settings);
    this.instances.set(userId, bot);
    await bot.start();
    return bot;
  }

  async stopBot(userId) {
    const bot = this.instances.get(userId);
    if (bot) {
      await bot.stop();
      this.instances.delete(userId);
    }
  }

  async startCopyBot(userId, settings) {
    if (this.copyInstances.has(userId)) {
      await this.stopCopyBot(userId);
    }

    const bot = new CopyBotInstance(userId, settings);
    this.copyInstances.set(userId, bot);
    await bot.start();
    return bot;
  }

  async stopCopyBot(userId) {
    const bot = this.copyInstances.get(userId);
    if (bot) {
      await bot.stop();
      this.copyInstances.delete(userId);
    }
  }

  getBotStatus(userId) {
    const bot = this.instances.get(userId);
    return bot ? bot.getStatus() : null;
  }

  getCopyBotStatus(userId) {
    const bot = this.copyInstances.get(userId);
    return bot ? bot.getStatus() : null;
  }

  getActiveCount() {
    return this.instances.size + this.copyInstances.size;
  }

  isRunning(userId) {
    const bot = this.instances.get(userId);
    return bot ? bot.isRunning : false;
  }

  isCopyRunning(userId) {
    const bot = this.copyInstances.get(userId);
    return bot ? bot.isRunning : false;
  }

  /**
   * Stop all bot instances — used for graceful shutdown
   */
  async stopAll() {
    console.log(`[BotManager] Stopping all instances (${this.instances.size} signal, ${this.copyInstances.size} copy)...`);

    const stopPromises = [];

    // Stop signal bots
    for (const [userId, instance] of this.instances) {
      stopPromises.push(
        instance.stop().catch(err => {
          console.error(`[BotManager] Error stopping signal bot for user ${userId}:`, err.message);
        })
      );
    }

    // Stop copy bots
    for (const [userId, instance] of this.copyInstances) {
      stopPromises.push(
        instance.stop().catch(err => {
          console.error(`[BotManager] Error stopping copy bot for user ${userId}:`, err.message);
        })
      );
    }

    await Promise.all(stopPromises);

    this.instances.clear();
    this.copyInstances.clear();

    console.log('[BotManager] All instances stopped.');
  }
}

module.exports = BotManager;
