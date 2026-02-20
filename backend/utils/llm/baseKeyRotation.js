const { createLogger } = require('../../utils/logger');
const logger = createLogger('keyRotation');

class BaseKeyRotationService {
    constructor(keys, name) {
        this.keys = keys || [];
        this.currentIndex = 0;
        this.name = name;

        if (!this.keys || this.keys.length === 0) {
            logger.warn(`No API keys configured for ${this.name}`);
        } else {
            logger.info(`Initialized key rotation`, { service: this.name, keyCount: this.keys.length });
        }
    }

    getNextKey() {
        if (this.keys.length === 0) {
            throw new Error(`No API keys configured for ${this.name}`);
        }
        const key = this.keys[this.currentIndex];

        // Only log rotation if there are multiple keys
        if (this.keys.length > 1) {
            const nextIndex = (this.currentIndex + 1) % this.keys.length;
            logger.debug(`Rotating key`, { service: this.name, current: this.currentIndex, next: nextIndex });
        }

        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        return key;
    }
}

module.exports = BaseKeyRotationService;
