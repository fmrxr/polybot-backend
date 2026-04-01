const { BotInstance } = require('./BotInstance');
const { CopyBotInstance } = require('./CopyBotInstance');

class BotManager {
  constructor() {
    this.instances = new Map(); // userId -> BotInstance (GBM bot)
    this.copyInstances = new Map(); // userId -> CopyBotInstance
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
    for (const [userId] of this.copyInstances) {
      await this.stopCopyBot(userId);
    }
  }

  // Copy bot methods
  async startCopyBot(userId, settings) {
    if (this.copyInstances.has(userId)) {
      throw new Error('Copy bot already running');
    }
    const instance = new CopyBotInstance(userId, settings);
    await instance.start();
    this.copyInstances.set(userId, instance);
    return instance;
  }

  async stopCopyBot(userId) {
    const instance = this.copyInstances.get(userId);
    if (instance) {
      instance.stop();
      this.copyInstances.delete(userId);
    }
  }

  isCopyRunning(userId) {
    return this.copyInstances.has(userId) && this.copyInstances.get(userId).isRunning;
  }

  getCopyStatus(userId) {
    const instance = this.copyInstances.get(userId);
    return instance ? instance.getStatus() : { is_running: false, targets_count: 0 };
  }
}

module.exports = { BotManager };
