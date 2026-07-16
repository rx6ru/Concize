jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createNarrator, NARRATE_PROMPT } = require('../src/transcript/narrative');
const { estimateTokens } = require('../src/transcript/chunk.boundary');

let n = 0;
const chunk = (t0, t1, text, speakers = ['S1']) => {
    const ordinal = n++;
    return { ordinal, t0Ms: t0, t1Ms: t1, text, speakers, turnIds: [`turn${ordinal}`] };
};

const reply = (text) => ({ choices: [{ message: { content: text } }] });

function makeNarrator(over = {}) {
    const complete = over.complete || jest.fn(async () => reply('Narrative text.'));
    return { complete, narrator: createNarrator({ complete, model: 'test-model', minChunks: 4, maxChunks: 8, ...over }) };
}

beforeEach(() => { n = 0; });

describe('buffering', () => {
    it('emits nothing before minChunks', async () => {
        const { narrator, complete } = makeNarrator();
        expect(await narrator.add('m1', chunk(0, 1000, 'a'))).toBeNull();
        expect(await narrator.add('m1', chunk(1000, 2000, 'b'))).toBeNull();
        expect(await narrator.add('m1', chunk(2000, 3000, 'c'))).toBeNull();
        expect(complete).not.toHaveBeenCalled();
        expect(narrator.pending('m1')).toBe(3);
    });

    it('emits once minChunks accumulates', async () => {
        const { narrator, complete } = makeNarrator();
        for (const [t0, t1] of [[0, 1000], [1000, 2000], [2000, 3000]]) {
            await narrator.add('m1', chunk(t0, t1, 'x'));
        }
        const out = await narrator.add('m1', chunk(3000, 4000, 'y'));

        expect(out).not.toBeNull();
        expect(out.layer).toBe(2);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(narrator.pending('m1')).toBe(0);
    });

    it('hard-emits at maxChunks even if minChunks was not reached', async () => {
        const { narrator, complete } = makeNarrator({ minChunks: 10, maxChunks: 5 });
        for (let i = 0; i < 4; i++) {
            expect(await narrator.add('m1', chunk(i * 1000, (i + 1) * 1000, 'x'))).toBeNull();
        }
        expect(complete).not.toHaveBeenCalled();

        const out = await narrator.add('m1', chunk(4000, 5000, 'x'));
        expect(out).not.toBeNull();
        expect(complete).toHaveBeenCalledTimes(1);
    });

    it('builds the merged span, speakers and turnIds from the source chunks', async () => {
        const { narrator } = makeNarrator();
        await narrator.add('m1', chunk(0, 1000, 'a', ['S1']));
        await narrator.add('m1', chunk(1000, 2500, 'b', ['S2']));
        await narrator.add('m1', chunk(2500, 4000, 'c', ['S1']));
        const out = await narrator.add('m1', chunk(4000, 6000, 'd', ['S3']));

        expect(out.t0Ms).toBe(0);
        expect(out.t1Ms).toBe(6000);
        expect(out.speakers.sort()).toEqual(['S1', 'S2', 'S3']);
        expect(out.turnIds).toEqual(['turn0', 'turn1', 'turn2', 'turn3']);
        expect(out.sourceOrdinals).toEqual([0, 1, 2, 3]);
        expect(out.tokens).toBe(estimateTokens('Narrative text.'));
    });

    it('increments ordinals per meeting, independently across meetings', async () => {
        const { narrator } = makeNarrator();
        let firstM1, secondM1, firstM2;
        for (let i = 0; i < 4; i++) firstM1 = await narrator.add('m1', chunk(i, i + 1, 'x'));
        for (let i = 0; i < 4; i++) secondM1 = await narrator.add('m1', chunk(20 + i, 21 + i, 'x'));
        for (let i = 0; i < 4; i++) firstM2 = await narrator.add('m2', chunk(i, i + 1, 'x'));

        expect(firstM1.ordinal).toBe(0);
        expect(secondM1.ordinal).toBe(1);
        expect(firstM2.ordinal).toBe(0);
    });
});

describe('failure handling', () => {
    it('returns null and keeps the buffer when the LLM call fails', async () => {
        const { narrator } = makeNarrator({ complete: jest.fn(async () => { throw new Error('provider down'); }) });
        for (let i = 0; i < 3; i++) await narrator.add('m1', chunk(i, i + 1, 'x'));

        const out = await narrator.add('m1', chunk(10, 11, 'x'));
        expect(out).toBeNull();
        expect(narrator.pending('m1')).toBe(4);
    });

    it('retries on the next add() and succeeds once the call recovers', async () => {
        let fail = true;
        const complete = jest.fn(async () => {
            if (fail) throw new Error('provider down');
            return reply('recovered narrative');
        });
        const { narrator } = makeNarrator({ complete });
        for (let i = 0; i < 3; i++) await narrator.add('m1', chunk(i, i + 1, 'x'));
        expect(await narrator.add('m1', chunk(10, 11, 'x'))).toBeNull();

        fail = false;
        const out = await narrator.add('m1', chunk(20, 21, 'x'));

        expect(out).not.toBeNull();
        expect(out.text).toBe('recovered narrative');
        expect(out.sourceOrdinals).toHaveLength(5);
    });

    it('treats an empty response as a failure and keeps the buffer', async () => {
        const { narrator } = makeNarrator({ complete: jest.fn(async () => reply('')) });
        for (let i = 0; i < 3; i++) await narrator.add('m1', chunk(i, i + 1, 'x'));

        expect(await narrator.add('m1', chunk(10, 11, 'x'))).toBeNull();
        expect(narrator.pending('m1')).toBe(4);
    });

    it('treats a non-string response as a failure and keeps the buffer', async () => {
        const { narrator } = makeNarrator({
            complete: jest.fn(async () => ({ choices: [{ message: { content: undefined } }] })),
        });
        for (let i = 0; i < 3; i++) await narrator.add('m1', chunk(i, i + 1, 'x'));

        expect(await narrator.add('m1', chunk(10, 11, 'x'))).toBeNull();
        expect(narrator.pending('m1')).toBe(4);
    });

    it('treats a timeout as a failure and keeps the buffer', async () => {
        const complete = jest.fn(() => new Promise((resolve) => {
            setTimeout(() => resolve(reply('too slow')), 200);
        }));
        const { narrator } = makeNarrator({ complete, timeoutMs: 20 });
        for (let i = 0; i < 3; i++) await narrator.add('m1', chunk(i, i + 1, 'x'));

        const out = await narrator.add('m1', chunk(10, 11, 'x'));
        expect(out).toBeNull();
        expect(narrator.pending('m1')).toBe(4);
    });
});

describe('flush', () => {
    it('emits whatever is buffered even below minChunks', async () => {
        const { narrator, complete } = makeNarrator();
        await narrator.add('m1', chunk(0, 1000, 'a'));
        await narrator.add('m1', chunk(1000, 2000, 'b'));

        const out = await narrator.flush('m1');
        expect(out).not.toBeNull();
        expect(out.sourceOrdinals).toEqual([0, 1]);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(narrator.pending('m1')).toBe(0);
        expect(narrator.active()).toBe(0);
    });

    it('returns null and stays a no-op when nothing is buffered', async () => {
        const { narrator } = makeNarrator();
        expect(await narrator.flush('ghost')).toBeNull();
        expect(narrator.active()).toBe(0);
    });
});

describe('prompt', () => {
    it('includes the given speaker labels', async () => {
        const { narrator, complete } = makeNarrator();
        await narrator.add('m1', chunk(0, 1000, 'a', ['Alice']));
        await narrator.add('m1', chunk(1000, 2000, 'b', ['Bob']));
        await narrator.add('m1', chunk(2000, 3000, 'c', ['Alice']));
        await narrator.add('m1', chunk(3000, 4000, 'd', ['Bob']));

        const [{ messages }] = complete.mock.calls[0];
        expect(messages[0].content).toBe(NARRATE_PROMPT);
        expect(messages[1].content).toContain('Alice');
        expect(messages[1].content).toContain('Bob');
    });
});

describe('provider outage', () => {
    it('drops the span rather than buffering the whole meeting', async () => {
        const { narrator } = makeNarrator({ complete: async () => { throw new Error('down'); } });
        for (let i = 0; i < 60; i++) {
            await narrator.add('m1', chunk(i * 1000, i * 1000 + 900, 'line'));
        }

        expect(narrator.pending('m1')).toBeLessThanOrEqual(8);
    });
});
