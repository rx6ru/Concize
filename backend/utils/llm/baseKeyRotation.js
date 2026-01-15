class BaseKeyRotationService {
    constructor(keys, name) {
        this.keys = keys || [];
        this.currentIndex = 0;
        this.name = name;

        if (!this.keys || this.keys.length === 0) {
            console.warn(`WARNING: No API keys configured for ${this.name}`);
        } else {
            console.log(`[${this.name}] Initialized key rotation with ${this.keys.length} keys.`);
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
            console.log(`[${this.name}] Using key index ${this.currentIndex}. Next: ${nextIndex}`);
        }

        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        return key;
    }
}

module.exports = BaseKeyRotationService;
