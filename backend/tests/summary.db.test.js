// tests/summary.db.test.js

// Mock the MeetingSummary model
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();

jest.mock('../db/models/meetingSummary.model', () => {
    const MockMeetingSummary = jest.fn();
    MockMeetingSummary.findOne = mockFindOne;
    MockMeetingSummary.findOneAndUpdate = mockFindOneAndUpdate;
    MockMeetingSummary.updateOne = mockUpdateOne;
    return MockMeetingSummary;
});

// Mock config
jest.mock('../utils/config', () => ({
    MONGODB_URL: 'mongodb://mock-url',
}));

const {
    getMeetingSummary,
    startSummaryUpdate,
    saveSummaryContent,
    completeSummary,
} = require('../db/mongoutils/summary.db');

describe('summary.db.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getMeetingSummary()', () => {
        it('should return the summary document for a valid jobId', async () => {
            const mockSummary = {
                jobId: 'test-job-123',
                title: 'Test Meeting',
                content: 'Test summary content',
                wordLimit: 500,
                lastProcessedChunkIndex: 2,
            };
            mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(mockSummary) });

            const result = await getMeetingSummary('test-job-123');

            expect(mockFindOne).toHaveBeenCalledWith({ jobId: 'test-job-123' });
            expect(result).toEqual(mockSummary);
        });

        it('should return null if no summary exists', async () => {
            mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

            const result = await getMeetingSummary('non-existent-job');

            expect(result).toBeNull();
        });

        it('should throw error on DB failure', async () => {
            mockFindOne.mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('DB Error')) });

            await expect(getMeetingSummary('error-job')).rejects.toThrow('DB Error');
        });
    });

    describe('startSummaryUpdate()', () => {
        it('should create a new summary for chunk 0 (upsert)', async () => {
            const mockCreatedSummary = {
                jobId: 'new-job',
                title: 'New Meeting',
                content: '',
                wordLimit: 500,
                lastProcessedChunkIndex: -1,
                status: 'updating',
            };
            mockFindOneAndUpdate.mockResolvedValue(mockCreatedSummary);

            const result = await startSummaryUpdate('new-job', 0);

            expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
                { jobId: 'new-job', lastProcessedChunkIndex: -1 },
                expect.objectContaining({
                    $set: { status: 'updating' },
                    $inc: { version: 1 },
                }),
                { new: true, upsert: true }
            );
            expect(result).toEqual(mockCreatedSummary);
        });

        it('should update existing summary for subsequent chunks', async () => {
            const mockUpdatedSummary = {
                jobId: 'existing-job',
                title: 'Existing Meeting',
                content: 'Previous summary',
                wordLimit: 500,
                lastProcessedChunkIndex: 2,
                status: 'updating',
            };
            mockFindOneAndUpdate.mockResolvedValue(mockUpdatedSummary);

            const result = await startSummaryUpdate('existing-job', 3);

            expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
                { jobId: 'existing-job', lastProcessedChunkIndex: 2 },
                expect.objectContaining({
                    $set: { status: 'updating' },
                    $inc: { version: 1 },
                }),
                { new: true, upsert: false }
            );
            expect(result).toEqual(mockUpdatedSummary);
        });

        it('should throw error for out-of-order chunk', async () => {
            // First call returns null (atomic check fails)
            mockFindOneAndUpdate.mockResolvedValue(null);
            // Second call (check if doc exists) returns existing doc with different index
            mockFindOne.mockResolvedValue({
                jobId: 'existing-job',
                lastProcessedChunkIndex: 1,
            });

            await expect(startSummaryUpdate('existing-job', 5)).rejects.toThrow('Out of order');
        });
    });

    describe('saveSummaryContent()', () => {
        it('should update summary content successfully', async () => {
            mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

            await saveSummaryContent('test-job', { title: 'Updated Title', summary: 'Updated content' }, 3);

            expect(mockUpdateOne).toHaveBeenCalledWith(
                { jobId: 'test-job' },
                expect.objectContaining({
                    $set: expect.objectContaining({
                        title: 'Updated Title',
                        content: 'Updated content',
                        lastProcessedChunkIndex: 3,
                    }),
                })
            );
        });

        it('should throw error on DB failure', async () => {
            mockUpdateOne.mockRejectedValue(new Error('Update failed'));

            await expect(
                saveSummaryContent('error-job', { title: 'T', summary: 'S' }, 0)
            ).rejects.toThrow('Update failed');
        });
    });

    describe('completeSummary()', () => {
        it('should mark summary as complete', async () => {
            mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });

            await completeSummary('finished-job');

            expect(mockUpdateOne).toHaveBeenCalledWith(
                { jobId: 'finished-job' },
                expect.objectContaining({
                    $set: expect.objectContaining({
                        status: 'complete',
                    }),
                })
            );
        });
    });
});
