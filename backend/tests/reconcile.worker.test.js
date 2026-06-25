jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createReconcileWorker } = require('../src/transcript/reconcile.worker');

const HOUR = 3600000;

// Provider-shaped diarized output, seconds-based, as the real API returns it.
const batchResult = (entries) => ({
    diarized_transcript: {
        entries: entries.map(([t0, t1, text, spk]) => ({
            start_time_seconds: t0 / 1000, end_time_seconds: t1 / 1000,
            transcript: text, speaker_id: spk,
        })),
    },
});

const liveTurn = (turnId, t0, t1, text, speakerLabel = null) =>
    ({ turnId, t0Ms: t0, t1Ms: t1, text, speakerLabel, overlap: false });

function make(over = {}) {
    const revised = [];
    const deps = {
        loadAudio: jest.fn(async () => ({ buffer: Buffer.from('audio'), durationMs: 60000 })),
        sliceAudio: jest.fn(async (b) => b),
        transcribeBatch: jest.fn(async () => batchResult([[0, 5000, 'the cat sat', '0']])),
        getTranscript: jest.fn(async () => [liveTurn('t1', 0, 5000, 'teh cat sat', 'S1')]),
        reviseUtterance: jest.fn(async (m, id, changes) => { revised.push({ id, changes }); return changes; }),
        markDirtyForRange: jest.fn(async () => []),
        ...over,
    };
    return { worker: createReconcileWorker(deps), revised, ...deps };
}

describe('happy path', () => {
    it('applies corrections from batch to the live transcript', async () => {
        const w = make();
        const result = await w.worker.run('m1');

        expect(result).toMatchObject({ applied: 1, unmatched: 0, failedSegments: 0, skipped: false });
        expect(w.revised[0].changes).toMatchObject({ text: 'the cat sat', source: 'batch' });
    });

    it('marks affected chunks dirty so they are re-derived', async () => {
        const w = make();
        await w.worker.run('m1');
        expect(w.markDirtyForRange).toHaveBeenCalledWith('m1', 0, 5000);
    });

    it('reads provider timestamps in seconds and stores milliseconds', async () => {
        const w = make({
            transcribeBatch: jest.fn(async () => batchResult([[1500, 4200, 'corrected', '0']])),
            getTranscript: jest.fn(async () => [liveTurn('t1', 1500, 4200, 'wrong', 'S1')]),
        });
        await w.worker.run('m1');
        expect(w.revised[0].changes).toMatchObject({ t0Ms: 1500, t1Ms: 4200 });
    });

    it('accepts a bare array of diarized entries as well as an object', async () => {
        const w = make({
            transcribeBatch: jest.fn(async () => ({
                diarized_transcript: [{ start_s: 0, end_s: 5, text: 'right', speaker: '0' }],
            })),
        });
        expect((await w.worker.run('m1')).applied).toBe(1);
    });

    it('does nothing when batch already agrees', async () => {
        const w = make({
            transcribeBatch: jest.fn(async () => batchResult([[0, 5000, 'teh cat sat', '0']])),
            getTranscript: jest.fn(async () => [liveTurn('t1', 0, 5000, 'teh cat sat', 'S1')]),
        });
        const result = await w.worker.run('m1');
        expect(result.applied).toBe(0);
        expect(w.reviseUtterance).not.toHaveBeenCalled();
    });
});

describe('long meetings', () => {
    it('splits a 4-hour recording into multiple batch calls', async () => {
        const w = make({
            loadAudio: jest.fn(async () => ({ buffer: Buffer.from('a'), durationMs: 4 * HOUR })),
            getTranscript: jest.fn(async () => []),
        });
        await w.worker.run('m1');
        expect(w.transcribeBatch.mock.calls.length).toBeGreaterThan(1);
    });

    it('slices audio per segment rather than sending the whole file', async () => {
        const w = make({
            loadAudio: jest.fn(async () => ({ buffer: Buffer.from('a'), durationMs: 4 * HOUR })),
            getTranscript: jest.fn(async () => []),
        });
        await w.worker.run('m1');

        const ranges = w.sliceAudio.mock.calls.map(([, t0, t1]) => t1 - t0);
        expect(ranges.every((ms) => ms <= 2 * HOUR)).toBe(true);
    });
});

describe('failure handling', () => {
    it('continues when one segment fails and reports it', async () => {
        let call = 0;
        const w = make({
            loadAudio: jest.fn(async () => ({ buffer: Buffer.from('a'), durationMs: 4 * HOUR })),
            getTranscript: jest.fn(async () => []),
            transcribeBatch: jest.fn(async () => {
                call += 1;
                if (call === 1) throw new Error('provider 500');
                return batchResult([[0, 1000, 'ok', '0']]);
            }),
        });
        const result = await w.worker.run('m1');
        expect(result.failedSegments).toBe(1);
        expect(result.skipped).toBe(false);
    });

    it('leaves turns inside a failed window untouched rather than flagging them', async () => {
        const w = make({
            loadAudio: jest.fn(async () => ({ buffer: Buffer.from('a'), durationMs: 4 * HOUR })),
            // a turn in the first (failed) segment
            getTranscript: jest.fn(async () => [liveTurn('t1', 1000, 2000, 'early', 'S1')]),
            transcribeBatch: jest.fn(async () => { throw new Error('down'); }),
        });
        const result = await w.worker.run('m1');
        expect(result.skipped).toBe(true);
        expect(w.reviseUtterance).not.toHaveBeenCalled();
    });

    it('changes nothing when every segment fails', async () => {
        const w = make({ transcribeBatch: jest.fn(async () => { throw new Error('down'); }) });
        const result = await w.worker.run('m1');

        expect(result).toMatchObject({ applied: 0, skipped: true });
        expect(w.reviseUtterance).not.toHaveBeenCalled();
    });

    it('keeps applying revisions after one write fails', async () => {
        let call = 0;
        const w = make({
            transcribeBatch: jest.fn(async () => batchResult([[0, 2000, 'first', '0'], [3000, 5000, 'second', '1']])),
            getTranscript: jest.fn(async () => [
                liveTurn('t1', 0, 2000, 'wrong one', 'S1'),
                liveTurn('t2', 3000, 5000, 'wrong two', 'S2'),
            ]),
            reviseUtterance: jest.fn(async () => {
                call += 1;
                if (call === 1) throw new Error('db blip');
                return {};
            }),
        });
        const result = await w.worker.run('m1');
        expect(result).toMatchObject({ proposed: 2, applied: 1 });
    });

    it('skips a recording with no duration', async () => {
        const w = make({ loadAudio: jest.fn(async () => ({ buffer: Buffer.alloc(0), durationMs: 0 })) });
        const result = await w.worker.run('m1');

        expect(result.skipped).toBe(true);
        expect(w.transcribeBatch).not.toHaveBeenCalled();
    });

    it('reports turns batch heard nothing for without revising them', async () => {
        const w = make({
            transcribeBatch: jest.fn(async () => batchResult([[50000, 55000, 'elsewhere', '0']])),
            getTranscript: jest.fn(async () => [liveTurn('t1', 0, 5000, 'phantom', 'S1')]),
        });
        const result = await w.worker.run('m1');

        expect(result.unmatched).toBe(1);
        expect(result.applied).toBe(0);
    });

    it('works without a dirty-marker wired', async () => {
        const w = make({ markDirtyForRange: null });
        await expect(w.worker.run('m1')).resolves.toMatchObject({ applied: 1 });
    });
});
