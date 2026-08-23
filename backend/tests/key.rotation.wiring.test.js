// Proves the wiring, not just the class: reportFailure/reportSuccess were never called anywhere
// in backend/src, so getClient()'s caller had no way to say which key a 401/429 came from.
// These tests drive the real groq.js / cerebras.js / openrouter.js singletons end to end,
// through the client each getClient() hands back, exactly as a real caller would.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/core/config', () => ({
    inference: {
        groqKeys: ['groq-a', 'groq-b', 'groq-c'],
        cerebrasKeys: ['cere-a', 'cere-b'],
        openrouterKeys: ['or-a', 'or-b'],
    },
}));

// `__create` is the raw mock, kept reachable alongside `chat.completions.create` because
// wrapClient() overwrites that property with its own reporting wrapper.
jest.mock('groq-sdk', () => jest.fn().mockImplementation((opts) => {
    const create = jest.fn();
    return { apiKey: opts.apiKey, chat: { completions: { create } }, __create: create };
}));

jest.mock('openai', () => jest.fn().mockImplementation((opts) => {
    const create = jest.fn();
    return { apiKey: opts.apiKey, chat: { completions: { create } }, __create: create };
}));

const groqService = require('../src/providers/llm/groq');
const cerebrasService = require('../src/providers/llm/cerebras');
const openrouterService = require('../src/providers/llm/openrouter');

const apiError = (status, headers) => Object.assign(new Error(`status ${status}`), { status, headers });

// The report happens in a .then() the wrapper attaches but doesn't await; give it a tick.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('wired key rotation (real groq.js / cerebras.js / openrouter.js)', () => {
    afterEach(() => {
        for (const svc of [groqService, cerebrasService, openrouterService]) {
            svc.dead.clear();
            svc.restingUntil.clear();
            svc.currentIndex = 0;
        }
    });

    it('a 401 from the wrapped client retires that key permanently', async () => {
        const client = groqService.getClient(); // groq-a
        client.__create.mockRejectedValueOnce(apiError(401));

        await expect(client.chat.completions.create({})).rejects.toThrow();
        await flush();

        expect(groqService.health()).toMatchObject({ dead: 1 });
        const seen = new Set([
            groqService.getClient().apiKey,
            groqService.getClient().apiKey,
            groqService.getClient().apiKey,
        ]);
        expect(seen.has('groq-a')).toBe(false);
    });

    it('a 403 does the same, on a different provider', async () => {
        const client = cerebrasService.getClient(); // cere-a
        client.__create.mockRejectedValueOnce(apiError(403));

        await expect(client.chat.completions.create({})).rejects.toThrow();
        await flush();

        expect(cerebrasService.getClient().apiKey).toBe('cere-b');
        expect(cerebrasService.getClient().apiKey).toBe('cere-b');
    });

    it('a 429 rests the key; it is handed out again once its cooldown passes', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            const client = openrouterService.getClient(); // or-a
            client.__create.mockRejectedValueOnce(apiError(429));

            await expect(client.chat.completions.create({})).rejects.toThrow();
            await flush();

            // Still resting: round robin skips straight to or-b.
            expect(openrouterService.getClient().apiKey).toBe('or-b');

            Date.now.mockReturnValue(1_000_000 + 61 * 1000);
            const seen = new Set([
                openrouterService.getClient().apiKey,
                openrouterService.getClient().apiKey,
            ]);
            expect(seen.has('or-a')).toBe(true);
        } finally {
            Date.now.mockRestore();
        }
    });

    it('honours a Retry-After header instead of the default cooldown', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
        try {
            const client = groqService.getClient(); // groq-a
            client.__create.mockRejectedValueOnce(apiError(429, { 'retry-after': '300' }));

            await expect(client.chat.completions.create({})).rejects.toThrow();
            await flush();

            // Past the default 60s cooldown, but not the 300s one the header asked for.
            Date.now.mockReturnValue(2_000_000 + 61 * 1000);
            expect(groqService.getClient().apiKey).not.toBe('groq-a');
        } finally {
            Date.now.mockRestore();
        }
    });

    it('a success clears a resting key\'s cooldown', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(3_000_000);
        try {
            const client = groqService.getClient(); // groq-a
            client.__create.mockRejectedValueOnce(apiError(429));
            await expect(client.chat.completions.create({})).rejects.toThrow();
            await flush();
            expect(groqService.getClient().apiKey).not.toBe('groq-a');

            client.__create.mockResolvedValueOnce({ ok: true });
            await client.chat.completions.create({});
            await flush();

            const seen = new Set([
                groqService.getClient().apiKey,
                groqService.getClient().apiKey,
                groqService.getClient().apiKey,
            ]);
            expect(seen.has('groq-a')).toBe(true);
        } finally {
            Date.now.mockRestore();
        }
    });

    it('still round-robins across the healthy keys', () => {
        const seen = [
            groqService.getClient().apiKey,
            groqService.getClient().apiKey,
            groqService.getClient().apiKey,
            groqService.getClient().apiKey,
        ];
        expect(seen).toEqual(['groq-a', 'groq-b', 'groq-c', 'groq-a']);
    });

    it('fails loudly, with no key material, once every key is dead', async () => {
        const clients = [groqService.getClient(), groqService.getClient(), groqService.getClient()];
        for (const c of clients) {
            c.__create.mockRejectedValueOnce(apiError(401));
            await expect(c.chat.completions.create({})).rejects.toThrow();
        }
        await flush();

        let error;
        try {
            groqService.getClient();
        } catch (e) {
            error = e;
        }

        expect(error).toBeDefined();
        expect(error.message).toMatch(/all groq api keys are invalid/i);
        expect(error.message).not.toMatch(/groq-a|groq-b|groq-c/);
    });

    it('two in-flight calls on different keys do not cross-report', async () => {
        const clientA = groqService.getClient(); // groq-a
        const clientB = groqService.getClient(); // groq-b

        clientB.__create.mockRejectedValueOnce(apiError(401));
        clientA.__create.mockResolvedValueOnce({ ok: true });

        const pB = clientB.chat.completions.create({}).catch(() => {});
        const pA = clientA.chat.completions.create({});
        await Promise.all([pA, pB]);
        await flush();

        expect(groqService.health()).toMatchObject({ dead: 1 });
        expect(groqService.dead.has('groq-b')).toBe(true);
        expect(groqService.dead.has('groq-a')).toBe(false);
    });
});
