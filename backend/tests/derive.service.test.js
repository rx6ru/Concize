jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createDeriveService } = require('../src/transcript/derive.service');

let n = 0;
const utt = (t0, t1, text, speaker = 'S1') => ({
    turnId: `t${n++}`, t0Ms: t0, t1Ms: t1, text, speakerLabel: speaker, overlap: false,
});

function makeService(over = {}) {
    const stored = [];
    const insertChunk = jest.fn(async (meetingId, c) => {
        const row = { ...c, meetingId, ordinal: stored.length };
        stored.push(row);
        return row;
    });
    const markDirtyForRange = jest.fn(async () => []);
    const onChunk = jest.fn();
    const svc = createDeriveService({
        insertChunk, markDirtyForRange, onChunk,
        chunkerOptions: { maxDurationMs: 5000, minDurationMs: 1000, overlapRatio: 0 },
        ...over,
    });
    return { svc, stored, insertChunk, markDirtyForRange, onChunk };
}

beforeEach(() => { n = 0; });

describe('ingest', () => {
    it('returns null while the chunk is still open', async () => {
        const { svc, insertChunk } = makeService();
        expect(await svc.ingest('m1', utt(0, 1000, 'hello'))).toBeNull();
        expect(insertChunk).not.toHaveBeenCalled();
    });

    it('stores a chunk once a boundary is reached', async () => {
        const { svc, insertChunk } = makeService();
        await svc.ingest('m1', utt(0, 1000, 'a'));
        const chunk = await svc.ingest('m1', utt(1000, 6000, 'b'));

        expect(chunk).not.toBeNull();
        expect(insertChunk).toHaveBeenCalledWith('m1', expect.objectContaining({ layer: 1 }));
    });

    it('notifies downstream after storing, e.g. to enqueue embedding', async () => {
        const { svc, onChunk } = makeService();
        await svc.ingest('m1', utt(0, 1000, 'a'));
        await svc.ingest('m1', utt(1000, 6000, 'b'));

        expect(onChunk).toHaveBeenCalledWith('m1', expect.objectContaining({ ordinal: 0 }));
    });

    it('keeps meetings independent', async () => {
        const { svc } = makeService();
        await svc.ingest('m1', utt(0, 1000, 'a'));
        await svc.ingest('m2', utt(0, 1000, 'b'));

        expect(svc.active()).toBe(2);
        // m1 closing must not consume m2's buffer
        await svc.ingest('m1', utt(1000, 6000, 'c'));
        expect(svc.active()).toBe(2);
    });

    it('never throws when storage fails — ingestion must not break', async () => {
        const { svc } = makeService({
            insertChunk: jest.fn(async () => { throw new Error('db down'); }),
        });
        await svc.ingest('m1', utt(0, 1000, 'a'));
        await expect(svc.ingest('m1', utt(1000, 6000, 'b'))).resolves.toBeNull();
    });
});

describe('revision handling', () => {
    it('marks overlapping chunks dirty', async () => {
        const { svc, markDirtyForRange } = makeService();
        await svc.onUtteranceRevised('m1', { t0Ms: 1000, t1Ms: 2000 });
        expect(markDirtyForRange).toHaveBeenCalledWith('m1', 1000, 2000);
    });

    it('keeps the open buffer instead of throwing the pending transcript away', async () => {
        const { svc } = makeService();
        const first = utt(0, 1000, 'held text');
        await svc.ingest('m1', first);
        await svc.onUtteranceRevised('m1', { ...first, speakerLabel: 'S9' });

        const chunk = await svc.ingest('m1', utt(1000, 7000, 'later'));
        expect(chunk.text).toBe('held text later');
    });

    it('applies the correction to the utterance still sitting in the buffer', async () => {
        const { svc } = makeService();
        const first = utt(0, 1000, 'held text');
        await svc.ingest('m1', first);
        await svc.onUtteranceRevised('m1', { ...first, speakerLabel: 'S9' });

        const chunk = await svc.ingest('m1', utt(1000, 7000, 'later'));
        expect(chunk.speakers).toContain('S9');
    });

    it('survives a dirty-marking failure', async () => {
        const { svc } = makeService({
            markDirtyForRange: jest.fn(async () => { throw new Error('db down'); }),
        });
        await expect(svc.onUtteranceRevised('m1', { t0Ms: 0, t1Ms: 1 })).resolves.toBeUndefined();
    });

    it('works when no dirty-marker is wired', async () => {
        const { svc } = makeService({ markDirtyForRange: null });
        await expect(svc.onUtteranceRevised('m1', { t0Ms: 0, t1Ms: 1 })).resolves.toBeUndefined();
    });
});

describe('finish', () => {
    it('stores the trailing partial chunk', async () => {
        const { svc } = makeService();
        await svc.ingest('m1', utt(0, 1000, 'trailing'));
        const chunk = await svc.finish('m1');

        expect(chunk).toMatchObject({ text: 'trailing', reason: 'flush' });
    });

    it('releases the chunker so a finished meeting holds no memory', async () => {
        const { svc } = makeService();
        await svc.ingest('m1', utt(0, 1000, 'a'));
        expect(svc.active()).toBe(1);

        await svc.finish('m1');
        expect(svc.active()).toBe(0);
    });

    it('returns null for a meeting that was never started', async () => {
        const { svc } = makeService();
        expect(await svc.finish('ghost')).toBeNull();
    });

    it('returns null when nothing was buffered', async () => {
        const { svc } = makeService();
        await svc.ingest('m1', utt(0, 1000, 'a'));
        await svc.ingest('m1', utt(1000, 6000, 'b'));   // closes on the cap, buffer empty after
        expect(await svc.finish('m1')).toBeNull();
    });

    it('survives a storage failure on the final chunk', async () => {
        const { svc } = makeService({
            insertChunk: jest.fn(async () => { throw new Error('db down'); }),
        });
        await svc.ingest('m1', utt(0, 1000, 'a'));
        await expect(svc.finish('m1')).resolves.toBeNull();
        expect(svc.active()).toBe(0);
    });
});
