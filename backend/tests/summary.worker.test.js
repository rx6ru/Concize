// Queue message handling for the summary worker: which messages get acked, which get requeued,
// and which get dropped. Broker and database are faked, the handler is the real one.

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('amqplib', () => ({ connect: jest.fn() }));
jest.mock('../src/infra/postgres', () => ({ connectPg: jest.fn() }));
jest.mock('../src/meetings/meeting.repository', () => ({ getTranscription: jest.fn() }));
jest.mock('../src/summary/summary.repository', () => ({ completeSummary: jest.fn(async () => {}) }));
jest.mock('../src/summary/summary.service', () => ({ processSummaryUpdate: jest.fn(async () => {}) }));

const { handleMessage } = require('../src/summary/summary.worker');
const { getTranscription } = require('../src/meetings/meeting.repository');
const { completeSummary } = require('../src/summary/summary.repository');
const { processSummaryUpdate } = require('../src/summary/summary.service');

const channelSpy = () => ({ ack: jest.fn(), nack: jest.fn() });
const message = (payload) => ({ content: Buffer.from(JSON.stringify(payload)) });

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    getTranscription.mockResolvedValue({ transcriptionChunks: ['chunk zero', 'chunk one'] });
    processSummaryUpdate.mockResolvedValue(undefined);
    completeSummary.mockResolvedValue(undefined);
});

afterEach(() => {
    jest.useRealTimers();
});

// the requeue branches sleep before nacking, so the timers have to be advanced
async function settle(promise) {
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(3000);
    return promise;
}

describe('a normal chunk', () => {
    it('summarises it and acks', async () => {
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', chunkIndex: 0 });

        await handleMessage(channel, msg);

        expect(processSummaryUpdate).toHaveBeenCalledWith('m1', 'chunk zero', 0);
        expect(channel.ack).toHaveBeenCalledWith(msg);
        expect(channel.nack).not.toHaveBeenCalled();
    });

    it('passes the text at that index, not the first one', async () => {
        await handleMessage(channelSpy(), message({ jobId: 'm1', chunkIndex: 1 }));
        expect(processSummaryUpdate).toHaveBeenCalledWith('m1', 'chunk one', 1);
    });

    it('does not finalise a chunk that is not the last', async () => {
        await handleMessage(channelSpy(), message({ jobId: 'm1', chunkIndex: 0 }));
        expect(completeSummary).not.toHaveBeenCalled();
    });
});

describe('a duplicate the broker redelivered', () => {
    it('acks instead of requeueing forever', async () => {
        // the repository returns without doing work for a chunk already behind the watermark,
        // so the handler sees success. requeueing here is what looped the queue.
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', chunkIndex: 0 });

        await handleMessage(channel, msg);

        expect(channel.ack).toHaveBeenCalledWith(msg);
        expect(channel.nack).not.toHaveBeenCalled();
    });
});

describe('a chunk that arrived too early', () => {
    it('requeues rather than dropping the meeting summary', async () => {
        processSummaryUpdate.mockRejectedValue(new Error('Out of order: chunk 5, expected 2'));
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', chunkIndex: 1 });

        await settle(handleMessage(channel, msg));

        expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
        expect(channel.ack).not.toHaveBeenCalled();
    });

    it('requeues when the transcript row has not caught up yet', async () => {
        getTranscription.mockResolvedValue({ transcriptionChunks: [] });
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', chunkIndex: 0 });

        await settle(handleMessage(channel, msg));

        expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
        expect(processSummaryUpdate).not.toHaveBeenCalled();
    });

    it('requeues when there is no transcript row at all', async () => {
        getTranscription.mockResolvedValue(null);
        const channel = channelSpy();

        await settle(handleMessage(channel, message({ jobId: 'm1', chunkIndex: 0 })));

        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    });
});

describe('a chunk that failed for another reason', () => {
    it('drops it rather than requeueing, so one bad chunk cannot block the queue', async () => {
        processSummaryUpdate.mockRejectedValue(new Error('groq is down'));
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', chunkIndex: 0 });

        await handleMessage(channel, msg);

        expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
        expect(channel.ack).not.toHaveBeenCalled();
    });
});

describe('the finalise marker', () => {
    it('completes the summary and acks', async () => {
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', finalise: true });

        await handleMessage(channel, msg);

        expect(completeSummary).toHaveBeenCalledWith('m1');
        expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('does not try to summarise anything', async () => {
        await handleMessage(channelSpy(), message({ jobId: 'm1', finalise: true }));

        expect(getTranscription).not.toHaveBeenCalled();
        expect(processSummaryUpdate).not.toHaveBeenCalled();
    });

    it('still acks when completing fails, or the marker redelivers forever', async () => {
        completeSummary.mockRejectedValue(new Error('pg down'));
        const channel = channelSpy();
        const msg = message({ jobId: 'm1', finalise: true });

        await handleMessage(channel, msg);

        expect(channel.ack).toHaveBeenCalledWith(msg);
    });
});

describe('the last chunk', () => {
    it('finalises after summarising', async () => {
        await handleMessage(channelSpy(), message({ jobId: 'm1', chunkIndex: 0, isLastChunk: true }));

        expect(processSummaryUpdate).toHaveBeenCalled();
        expect(completeSummary).toHaveBeenCalledWith('m1');
    });
});

describe('junk on the queue', () => {
    it('ignores a null delivery', async () => {
        const channel = channelSpy();
        await handleMessage(channel, null);

        expect(channel.ack).not.toHaveBeenCalled();
        expect(channel.nack).not.toHaveBeenCalled();
    });
});
