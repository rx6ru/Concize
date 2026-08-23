// Round-robin across a provider's API keys, skipping the ones that cannot currently be used.
//
// Plain round-robin assumes every key works. Keys collected from several places do not: one may be revoked, another may have spent its daily quota. Left in rotation, a dead key makes every Nth request fail with no pattern a caller can see.
//
// Two failure modes, handled differently because they mean different things:
//   401/403: the key is invalid. Permanent; drop it for this process.
//   429    : the key is fine, its quota is not. Rest it and try again later.

const { createLogger } = require('../../core/logger');
const { getRetryAfterMs } = require('./resilient.call');
const logger = createLogger('keyRotation');

const DEFAULT_COOLDOWN_MS = 60 * 1000;

class BaseKeyRotationService {
    /** @param {{now?: function}} [deps] `now` is injectable so cooldowns are testable without waiting. */
    constructor(keys, name, { now = () => Date.now() } = {}) {
        this.keys = keys || [];
        this.currentIndex = 0;
        this.name = name;
        this.now = now;

        this.dead = new Set();          // key -> permanently unusable
        this.restingUntil = new Map();  // key -> timestamp it may be used again

        if (!this.keys.length) {
            logger.warn(`No API keys configured for ${this.name}`);
        } else {
            logger.info('Initialized key rotation', { service: this.name, keyCount: this.keys.length });
        }
    }

    usable(key) {
        if (this.dead.has(key)) return false;
        const until = this.restingUntil.get(key);
        return !until || this.now() >= until;
    }

    getNextKey() {
        if (!this.keys.length) {
            throw new Error(`No API keys configured for ${this.name}`);
        }

        // One full pass, starting where the last call left off.
        for (let i = 0; i < this.keys.length; i++) {
            const index = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[index];
            if (!this.usable(key)) continue;
            this.currentIndex = (index + 1) % this.keys.length;
            return key;
        }

        // Nothing usable. Everything dead is a configuration problem and must say so; everything merely resting is temporary, so hand one back and let the caller's retry handle the 429.
        const live = this.keys.filter((k) => !this.dead.has(k));
        if (!live.length) {
            throw new Error(`All ${this.name} API keys are invalid (${this.keys.length} tried)`);
        }
        logger.warn('Every key is rate limited, using the least rested', { service: this.name });
        const soonest = live.reduce((a, b) =>
            (this.restingUntil.get(a) || 0) <= (this.restingUntil.get(b) || 0) ? a : b);
        return soonest;
    }

    /**
     * Tells the rotator a key just failed, so it can stop handing it out.
     * @param {{retryAfterMs?: number}} [opts]
     */
    reportFailure(key, status, { retryAfterMs } = {}) {
        if (status === 401 || status === 403) {
            if (!this.dead.has(key)) {
                this.dead.add(key);
                logger.error('API key rejected, dropping it from rotation', {
                    service: this.name, remaining: this.keys.length - this.dead.size,
                });
            }
            return;
        }

        if (status === 429) {
            this.restingUntil.set(key, this.now() + (retryAfterMs || DEFAULT_COOLDOWN_MS));
        }
    }

    /** A key that works again should not stay rested. */
    reportSuccess(key) {
        this.restingUntil.delete(key);
    }

    /**
     * Patches a client's `chat.completions.create` so a call through it reports back on its own.
     * getClient() hands back a bare SDK client with no way for a caller to say which key it used,
     * so the client has to say it for them.
     * A no-op on a client that isn't shaped this way, so it's safe to call unconditionally.
     * @param {object} client an SDK client, e.g. `new Groq(...)` or `new OpenAI(...)`
     * @param {string} key the key `client` was built with
     * @returns {object} the same client, patched in place
     */
    wrapClient(client, key) {
        const create = client && client.chat && client.chat.completions && client.chat.completions.create;
        if (typeof create !== 'function') return client;

        const bound = create.bind(client.chat.completions);
        client.chat.completions.create = (...args) => {
            const result = bound(...args);
            if (result && typeof result.then === 'function') {
                result.then(
                    () => this.reportSuccess(key),
                    (err) => this.reportFailure(key, err && (err.status ?? err.code), { retryAfterMs: getRetryAfterMs(err) }),
                );
            }
            return result;
        };
        return client;
    }

    health() {
        const resting = this.keys.filter((k) => !this.dead.has(k) && !this.usable(k)).length;
        const dead = this.dead.size;
        return {
            service: this.name,
            total: this.keys.length,
            dead,
            resting,
            usable: this.keys.length - dead - resting,
        };
    }
}

module.exports = BaseKeyRotationService;
