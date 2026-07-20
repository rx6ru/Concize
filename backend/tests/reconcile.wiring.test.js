// The composition that turns a stored recording into transcript corrections.
// Everything below the wiring is faked; the worker itself has its own suite.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const mockRunWorker = jest.fn(async () => ({ applied: 3, proposed: 4, unmatched: 1, failedSegments: 0 }));
jest.mock('../src/transcript/reconcile.worker', () => ({
    createReconcileWorker: jest.fn(() => ({ run: mockRunWorker })),
}));
jest.mock('../src/providers/stt/sarvam.batch', () => ({ transcribeBatch: jest.fn() }));
jest.mock('../src/transcript/utterance.repository', () => ({
    getTranscript: jest.fn(), reviseUtterance: jest.fn(),
}));
jest.mock('../src/transcript/chunk.repository', () => ({ markDirtyForRange: jest.fn() }));

const { createReconciler } = require('../src/transcript/reconcile.wiring');
const { createReconcileWorker } = require('../src/transcript/reconcile.worker');

function make(over = {}) {
    const loadRecording = over.loadRecording
        || jest.fn(async () => ({ buffer: Buffer.alloc(100), durationMs: 60000 }));
    const discardRecording = over.discardRecording || jest.fn(async () => true);
    return { loadRecording, discardRecording, reconciler: createReconciler({ loadRecording, discardRecording }) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRunWorker.mockResolvedValue({ applied: 3, proposed: 4, unmatched: 1, failedSegments: 0 });
});

describe('reconciling a finished meeting', () => {
    it('runs the pass and reports what it applied', async () => {
        const { reconciler } = make();
        expect(await reconciler.run('m1')).toMatchObject({ applied: 3, unmatched: 1 });
        expect(mockRunWorker).toHaveBeenCalledWith('m1');
    });

    it('does nothing when the meeting was never recorded', async () => {
        const { reconciler, discardRecording } = make({ loadRecording: jest.fn(async () => null) });

        expect(await reconciler.run('m1')).toBeNull();
        expect(mockRunWorker).not.toHaveBeenCalled();
        expect(discardRecording).not.toHaveBeenCalled();
    });

    it('deletes the recording once the pass is done', async () => {
        const { reconciler, discardRecording } = make();
        await reconciler.run('m1');
        expect(discardRecording).toHaveBeenCalledWith('m1');
    });

    it('still deletes the recording when the pass fails', async () => {
        mockRunWorker.mockRejectedValue(new Error('sarvam down'));
        const { reconciler, discardRecording } = make();

        expect(await reconciler.run('m1')).toBeNull();
        expect(discardRecording).toHaveBeenCalledWith('m1');
    });

    it('swallows a failure rather than letting it escape into session teardown', async () => {
        mockRunWorker.mockRejectedValue(new Error('sarvam down'));
        const { reconciler } = make();

        await expect(reconciler.run('m1')).resolves.toBeNull();
    });

    it('gives the worker a slicer that produces a self-contained wav per segment', async () => {
        make();
        const { sliceAudio } = createReconcileWorker.mock.calls[0][0];
        const wav = Buffer.concat([
            require('../src/realtime/recorder').wavHeader(32000),
            Buffer.alloc(32000),
        ]);

        const segment = sliceAudio(wav, 0, 500);

        expect(segment.subarray(0, 4).toString()).toBe('RIFF');
        expect(segment.subarray(8, 12).toString()).toBe('WAVE');
    });

    it('passes the real repositories through, not stubs', async () => {
        make();
        const deps = createReconcileWorker.mock.calls[0][0];

        expect(typeof deps.loadAudio).toBe('function');
        expect(typeof deps.transcribeBatch).toBe('function');
        expect(typeof deps.getTranscript).toBe('function');
        expect(typeof deps.reviseUtterance).toBe('function');
        expect(typeof deps.markDirtyForRange).toBe('function');
    });
});
