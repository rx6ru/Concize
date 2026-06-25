// tests/meetingCompletion.test.js

// Mock the database utility before importing the module under test
jest.mock('../src/meetings/meeting.repository', () => ({
    updateMeetingStatus: jest.fn(),
}));

// Mock logger
const mockLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};
jest.mock('../src/core/logger', () => ({
    createLogger: () => mockLogger,
}));

// Mock transcription.db.js BEFORE requiring the controller
const mockDb = {
    updateMeetingStatus: jest.fn(),
};
jest.mock('../src/meetings/meeting.repository', () => mockDb);

const { completeMeeting, completeMeetingWithErrors } = require('../src/meetings/meeting.service');

describe('meetingCompletion Controller', () => {
    beforeEach(() => {
        // Clear mock call history before each test
        jest.clearAllMocks();
    });

    describe('completeMeeting()', () => {
        it('should call updateMeetingStatus with jobId and "completed"', async () => {
            mockDb.updateMeetingStatus.mockResolvedValue(true);
            const jobId = 'test-job-123';

            await completeMeeting(jobId);

            expect(mockDb.updateMeetingStatus).toHaveBeenCalledTimes(1);
            expect(mockDb.updateMeetingStatus).toHaveBeenCalledWith(jobId, 'completed');
        });

        it('should return true when updateMeetingStatus succeeds', async () => {
            mockDb.updateMeetingStatus.mockResolvedValue(true);
            const jobId = 'test-job-456';

            const result = await completeMeeting(jobId);

            expect(result).toBe(true);
        });

        it('should return false when updateMeetingStatus fails', async () => {
            mockDb.updateMeetingStatus.mockResolvedValue(false);
            const jobId = 'non-existent-job';

            const result = await completeMeeting(jobId);

            expect(result).toBe(false);
        });

        it('should return false and log error when updateMeetingStatus throws', async () => {
            mockDb.updateMeetingStatus.mockRejectedValue(new Error('Update failed'));

            const result = await completeMeeting('job-123');

            expect(result).toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Error finalizing meeting'),
                expect.objectContaining({ error: 'Update failed' })
            );
        });
    });

    describe('completeMeetingWithErrors()', () => {
        it('should call updateMeetingStatus with jobId and "completed_with_errors"', async () => {
            mockDb.updateMeetingStatus.mockResolvedValue(true);
            const jobId = 'failed-job-123';

            await completeMeetingWithErrors(jobId);

            expect(mockDb.updateMeetingStatus).toHaveBeenCalledTimes(1);
            expect(mockDb.updateMeetingStatus).toHaveBeenCalledWith(jobId, 'completed_with_errors');
        });

        it('should return true when updateMeetingStatus succeeds', async () => {
            mockDb.updateMeetingStatus.mockResolvedValue(true);
            const jobId = 'failed-job-456';

            const result = await completeMeetingWithErrors(jobId);

            expect(result).toBe(true);
        });

        it('should return false when updateMeetingStatus fails', async () => {
            mockDb.updateMeetingStatus.mockResolvedValue(false);
            const jobId = 'non-existent-failed-job';

            const result = await completeMeetingWithErrors(jobId);

            expect(result).toBe(false);
        });

        it('should return false and log error when updateMeetingStatus throws', async () => {
            mockDb.updateMeetingStatus.mockRejectedValue(new Error('Update failed'));

            const result = await completeMeetingWithErrors('job-123');

            expect(result).toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Error finalizing meeting with errors'),
                expect.objectContaining({ error: 'Update failed' })
            );
        });
    });
});
