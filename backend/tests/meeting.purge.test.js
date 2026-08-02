jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { createMeetingPurge } = require('../src/meetings/meeting.purge');

const build = (over = {}) => {
    const purgeVectors = over.purgeVectors || jest.fn(async () => {});
    const deleteMeeting = over.deleteMeeting || jest.fn(async () => true);
    return { purgeVectors, deleteMeeting, purge: createMeetingPurge({ purgeVectors, deleteMeeting }) };
};

describe('deleting a meeting', () => {
    it('removes the vectors and the rows', async () => {
        const { purge, purgeVectors, deleteMeeting } = build();

        await expect(purge('m1')).resolves.toEqual({ deleted: true });

        expect(purgeVectors).toHaveBeenCalledWith('m1');
        expect(deleteMeeting).toHaveBeenCalledWith('m1');
    });

    // Vectors first: they live outside Postgres and nothing else records where they are, so
    // dropping the row first would strand them with no way left to find them.
    it('purges vectors before dropping the rows', async () => {
        const order = [];
        const { purge } = build({
            purgeVectors: jest.fn(async () => { order.push('vectors'); }),
            deleteMeeting: jest.fn(async () => { order.push('rows'); return true; }),
        });

        await purge('m1');

        expect(order).toEqual(['vectors', 'rows']);
    });

    it('keeps the rows when the vector store is unreachable, so it can be retried', async () => {
        const { purge, deleteMeeting } = build({
            purgeVectors: jest.fn(async () => { throw new Error('qdrant down'); }),
        });

        await expect(purge('m1')).rejects.toThrow('qdrant down');

        expect(deleteMeeting).not.toHaveBeenCalled();
    });

    it('reports a meeting that was not there', async () => {
        const { purge } = build({ deleteMeeting: jest.fn(async () => false) });

        await expect(purge('ghost')).resolves.toEqual({ deleted: false });
    });
});
