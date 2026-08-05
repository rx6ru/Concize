// Exercises the append-only transcript log against pg-mem, loading the actual
// src/infra/schema.sql so the SQL is validated end-to-end (no live DB required).

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const { loadSchema } = require('./helpers/schema');

const schema = loadSchema();

jest.mock('../src/core/config', () => ({ database: { POSTGRES_URL: 'postgres://mem' } }));
jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { _setPoolForTesting, closePool, query } = require('../src/infra/postgres');
const {
    appendUtterance, reviseUtterance, getTranscript, getTurnHistory, getWatermarkMs, getRecentTurns,
} = require('../src/transcript/utterance.repository');

let mem;
beforeEach(async () => {
    mem = newDb();
    mem.public.none(schema);
    const { Pool } = mem.adapters.createPg();
    _setPoolForTesting(new Pool());
    await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m1', 'user-A']);
});
afterEach(async () => { await closePool(); });

const turn = (n, over = {}) => ({
    turnId: `t${n}`, t0Ms: n * 1000, t1Ms: n * 1000 + 800, text: `line ${n}`, ...over,
});

describe('append', () => {
    it('assigns monotonic seq per meeting', async () => {
        const a = await appendUtterance('m1', turn(1));
        const b = await appendUtterance('m1', turn(2));
        expect(a.seq).toBe(0);
        expect(b.seq).toBe(1);
    });

    it('defaults to no attribution rather than inventing one', async () => {
        const u = await appendUtterance('m1', turn(1));
        expect(u.speakerLabel).toBeNull();
        expect(u.speakerConfidence).toBe('unknown');
        expect(u.overlap).toBe(false);
    });

    it('stores speaker, confidence and overlap when fusion supplies them', async () => {
        const u = await appendUtterance('m1', turn(1, {
            speakerLabel: 'S2', speakerConfidence: 'provisional', overlap: true, overlapRatio: 0.42,
        }));
        expect(u).toMatchObject({
            speakerLabel: 'S2', speakerConfidence: 'provisional', overlap: true,
        });
        expect(u.overlapRatio).toBeCloseTo(0.42, 5);
    });

    it('rejects a confidence value outside the allowed set', async () => {
        await expect(appendUtterance('m1', turn(1, { speakerConfidence: 'very-sure' })))
            .rejects.toThrow();
    });

    it('rejects an utterance for a meeting that does not exist', async () => {
        await expect(appendUtterance('nope', turn(1))).rejects.toThrow();
    });
});

describe('revision', () => {
    it('supersedes the old revision instead of overwriting it', async () => {
        await appendUtterance('m1', turn(1, { text: 'teh cat' }));
        const revised = await reviseUtterance('m1', 't1', { text: 'the cat', source: 'batch' });

        expect(revised.rev).toBe(1);
        expect(revised.text).toBe('the cat');

        const history = await getTurnHistory('m1', 't1');
        expect(history).toHaveLength(2);
        expect(history[0]).toMatchObject({ rev: 0, text: 'teh cat', supersededBy: 1 });
        expect(history[1]).toMatchObject({ rev: 1, text: 'the cat', supersededBy: null });
    });

    it('leaves exactly one current row per turn', async () => {
        await appendUtterance('m1', turn(1));
        await reviseUtterance('m1', 't1', { text: 'v2' });
        await reviseUtterance('m1', 't1', { text: 'v3' });

        const current = await getTranscript('m1');
        expect(current).toHaveLength(1);
        expect(current[0]).toMatchObject({ rev: 2, text: 'v3' });
    });

    it('carries unchanged fields forward', async () => {
        await appendUtterance('m1', turn(1, { speakerLabel: 'S1', text: 'hello' }));
        const revised = await reviseUtterance('m1', 't1', { speakerLabel: 'S3' });
        expect(revised.text).toBe('hello');
        expect(revised.speakerLabel).toBe('S3');
    });

    it('keeps the original seq so spoken order survives a correction', async () => {
        await appendUtterance('m1', turn(1));
        await appendUtterance('m1', turn(2));
        await reviseUtterance('m1', 't1', { text: 'corrected' });

        const current = await getTranscript('m1');
        expect(current.map((u) => u.turnId)).toEqual(['t1', 't2']);
    });

    it('returns null for an unknown turn', async () => {
        expect(await reviseUtterance('m1', 'ghost', { text: 'x' })).toBeNull();
    });
});

// A three-hour meeting is thousands of turns. Returning them all makes the post-meeting view
// slow to first paint and impossible to stream into a list.
describe('paging the transcript', () => {
    it('returns a page and where the next one starts', async () => {
        for (let n = 1; n <= 5; n++) await appendUtterance('m1', turn(n));

        const page = await getTranscript('m1', { limit: 2 });

        expect(page.map((u) => u.turnId)).toEqual(['t1', 't2']);
        expect(page[page.length - 1].seq).toBe(1);
    });

    it('continues from a cursor without repeating or skipping', async () => {
        for (let n = 1; n <= 5; n++) await appendUtterance('m1', turn(n));

        const first = await getTranscript('m1', { limit: 2 });
        const second = await getTranscript('m1', { limit: 2, afterSeq: first[first.length - 1].seq });

        expect(second.map((u) => u.turnId)).toEqual(['t3', 't4']);
    });

    // Paging by seq rather than offset, so a revision landing mid-page cannot shift the window
    // and make a turn appear twice or vanish.
    it('is stable when a turn is revised between pages', async () => {
        for (let n = 1; n <= 5; n++) await appendUtterance('m1', turn(n));
        const first = await getTranscript('m1', { limit: 2 });

        await reviseUtterance('m1', 't1', { ...turn(1), text: 'corrected' });

        const second = await getTranscript('m1', { limit: 2, afterSeq: first[first.length - 1].seq });
        expect(second.map((u) => u.turnId)).toEqual(['t3', 't4']);
    });

    it('returns nothing past the end', async () => {
        await appendUtterance('m1', turn(1));
        expect(await getTranscript('m1', { afterSeq: 99 })).toEqual([]);
    });
});

describe('reads', () => {
    it('returns the transcript in spoken order, not insertion order', async () => {
        await appendUtterance('m1', turn(1));
        await appendUtterance('m1', turn(2));
        await appendUtterance('m1', turn(3));

        const t = await getTranscript('m1');
        expect(t.map((u) => u.text)).toEqual(['line 1', 'line 2', 'line 3']);
    });

    it('scopes reads to one meeting', async () => {
        await query('INSERT INTO meetings (job_id, owner_id) VALUES ($1, $2)', ['m2', 'user-B']);
        await appendUtterance('m1', turn(1));
        await appendUtterance('m2', turn(9));

        expect(await getTranscript('m1')).toHaveLength(1);
        expect((await getTranscript('m2'))[0].text).toBe('line 9');
    });

    it('reports the watermark from current revisions only', async () => {
        await appendUtterance('m1', turn(1));            // t1_ms 1800
        await appendUtterance('m1', turn(5));            // t1_ms 5800
        expect(await getWatermarkMs('m1')).toBe(5800);
    });

    it('reflects a shortened revision in the watermark', async () => {
        await appendUtterance('m1', turn(5));
        await reviseUtterance('m1', 't5', { t1Ms: 4000 });
        expect(await getWatermarkMs('m1')).toBe(4000);
    });

    it('returns zero watermark for a meeting with no utterances', async () => {
        expect(await getWatermarkMs('m1')).toBe(0);
    });
});

describe('recent turns', () => {
    it('measures the window back from the watermark, not the wall clock', async () => {
        await appendUtterance('m1', turn(1));            // 1000–1800
        await appendUtterance('m1', turn(60));           // 60000–60800
        await appendUtterance('m1', turn(61));           // 61000–61800

        const recent = await getRecentTurns('m1', { windowMs: 5000 });
        expect(recent.map((u) => u.text)).toEqual(['line 60', 'line 61']);
    });

    it('returns the whole transcript when the window covers it', async () => {
        await appendUtterance('m1', turn(1));
        await appendUtterance('m1', turn(2));

        expect(await getRecentTurns('m1', { windowMs: 600000 })).toHaveLength(2);
    });

    it('returns nothing for a meeting with no utterances', async () => {
        expect(await getRecentTurns('m1')).toEqual([]);
    });

    it('excludes superseded revisions', async () => {
        await appendUtterance('m1', turn(60));
        await reviseUtterance('m1', 't60', { text: 'corrected' });

        const recent = await getRecentTurns('m1', { windowMs: 5000 });
        expect(recent).toHaveLength(1);
        expect(recent[0].text).toBe('corrected');
    });
});
