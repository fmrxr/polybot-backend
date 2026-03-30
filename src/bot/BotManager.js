const { BotInstance } = require('./BotInstance');

class BotManager {
  constructor() {
    this.instances = new Map(); // userId -> BotInstance
  }

  async startBot(userId, settings) {
    if (this.instances.has(userId)) {
      throw new Error('Bot already running');
    }
    const instance = new BotInstance(userId, settings);
    await instance.start();
    this.instances.set(userId, instance);
    return instance;
  }

  async stopBot(userId) {
    const instance = this.instances.get(userId);
    if (instance) {
      await instance.stop();
      this.instances.delete(userId);
    }
  }

  isRunning(userId) {
    return this.instances.has(userId) && this.instances.get(userId).isRunning;
  }

  getStatus(userId) {
    const instance = this.instances.get(userId);
    return instance ? instance.getStatus() : { is_running: false, open_trades: 0 };
  }

  async stopAll() {
    for (const [userId] of this.instances) {
      await this.stopBot(userId);
    }
  }
}

module.exports = { BotManager };
