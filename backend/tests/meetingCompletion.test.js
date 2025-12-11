// tests/meetingCompletion.test.js

// Mock the database utility before importing the module under test
jest.mock('../db/mongoutils/transcription.db', () => ({
    updateMeetingStatus: jest.fn(),
}));

const { completeMeeting } = require('../controllers/meetingCompletion');
const { updateMeetingStatus } = require('../db/mongoutils/transcription.db');

describe('meetingCompletion Controller', () => {
    beforeEach(() => {
        // Clear mock call history before each test
        jest.clearAllMocks();
    });

    describe('completeMeeting()', () => {
        it('should call updateMeetingStatus with jobId and "completed"', async () => {
            updateMeetingStatus.mockResolvedValue(true);
            const jobId = 'test-job-123';

            await completeMeeting(jobId);

            expect(updateMeetingStatus).toHaveBeenCalledTimes(1);
            expect(updateMeetingStatus).toHaveBeenCalledWith(jobId, 'completed');
        });

        it('should return true when updateMeetingStatus succeeds', async () => {
            updateMeetingStatus.mockResolvedValue(true);
            const jobId = 'test-job-456';

            const result = await completeMeeting(jobId);

            expect(result).toBe(true);
        });

        it('should return false when updateMeetingStatus fails', async () => {
            updateMeetingStatus.mockResolvedValue(false);
            const jobId = 'non-existent-job';

            const result = await completeMeeting(jobId);

            expect(result).toBe(false);
        });

        it('should return false and log error when updateMeetingStatus throws', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
            updateMeetingStatus.mockRejectedValue(new Error('Database error'));
            const jobId = 'error-job';

            const result = await completeMeeting(jobId);

            expect(result).toBe(false);
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });
});
