jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const BaseKeyRotationService = require('../src/providers/llm/key.rotation');

const make = (keys, now = () => 1000) => new BaseKeyRotationService(keys, 'Test', { now });

describe('round robin', () => {
    it('hands out each key in turn', () => {
        const r = make(['a', 'b', 'c']);
        expect([r.getNextKey(), r.getNextKey(), r.getNextKey(), r.getNextKey()]).toEqual(['a', 'b', 'c', 'a']);
    });

    it('throws when there are no keys at all', () => {
        expect(() => make([]).getNextKey()).toThrow(/no api keys/i);
    });
});

// Keys gathered from different places will not all be live. A revoked one left in rotation makes
// every Nth request fail for no visible reason.
describe('a revoked key', () => {
    it('is dropped from rotation once it reports invalid', () => {
        const r = make(['dead', 'good']);
        r.reportFailure('dead', 401);

        expect([r.getNextKey(), r.getNextKey(), r.getNextKey()]).toEqual(['good', 'good', 'good']);
    });

    it('is dropped on a 403 as well', () => {
        const r = make(['dead', 'good']);
        r.reportFailure('dead', 403);
        expect(r.getNextKey()).toBe('good');
    });

    it('does not come back, unlike a rate limit', () => {
        let t = 1000;
        const r = make(['dead', 'good'], () => t);
        r.reportFailure('dead', 401);
        t += 60 * 60 * 1000;

        expect([r.getNextKey(), r.getNextKey()]).toEqual(['good', 'good']);
    });

    it('says so clearly when every key is dead, rather than looking like an outage', () => {
        const r = make(['a', 'b']);
        r.reportFailure('a', 401);
        r.reportFailure('b', 401);

        expect(() => r.getNextKey()).toThrow(/all .* keys/i);
    });
});

// A rate-limited key is fine tomorrow, so it rests rather than being discarded.
describe('a rate-limited key', () => {
    it('is skipped while it is cooling down', () => {
        const r = make(['tired', 'fresh']);
        r.reportFailure('tired', 429);

        expect([r.getNextKey(), r.getNextKey()]).toEqual(['fresh', 'fresh']);
    });

    it('comes back once the cooldown passes', () => {
        let t = 1000;
        const r = make(['tired', 'fresh'], () => t);
        r.reportFailure('tired', 429);
        t += 61 * 1000;

        const seen = new Set([r.getNextKey(), r.getNextKey()]);
        expect(seen.has('tired')).toBe(true);
    });

    it('honours a longer cooldown when the provider asks for one', () => {
        let t = 1000;
        const r = make(['tired', 'fresh'], () => t);
        r.reportFailure('tired', 429, { retryAfterMs: 5 * 60 * 1000 });
        t += 61 * 1000;

        expect([r.getNextKey(), r.getNextKey()]).toEqual(['fresh', 'fresh']);
    });

    // Everything resting is temporary, and must read differently from everything being dead.
    it('still hands out a resting key when there is nothing else left', () => {
        const r = make(['only']);
        r.reportFailure('only', 429);

        expect(r.getNextKey()).toBe('only');
    });
});

describe('recovery', () => {
    it('clears a cooldown when the key works again', () => {
        const r = make(['a', 'b']);
        r.reportFailure('a', 429);
        r.reportSuccess('a');

        expect([r.getNextKey(), r.getNextKey()]).toEqual(['a', 'b']);
    });

    it('reports how many keys are usable', () => {
        const r = make(['a', 'b', 'c']);
        r.reportFailure('a', 401);
        r.reportFailure('b', 429);

        expect(r.health()).toMatchObject({ total: 3, dead: 1, resting: 1, usable: 1 });
    });
});
