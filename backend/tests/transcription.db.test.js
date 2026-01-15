// tests/transcription.db.test.js

// Create mock save function
const mockSave = jest.fn();

// Mock the Meeting model as a constructor function
jest.mock('../db/models/meeting.model', () => {
    const MockMeeting = jest.fn().mockImplementation(() => ({
        save: mockSave,
    }));
    MockMeeting.findOne = jest.fn();
    MockMeeting.findOneAndUpdate = jest.fn();
    return MockMeeting;
});

// Mock config to prevent actual env access
jest.mock('../utils/config', () => ({
    MONGODB_URL: 'mongodb://mock-url',
}));

const Meeting = require('../db/models/meeting.model');
const {
    createTranscription,
    appendTranscription,
    updateMeetingStatus,
    getMeetingStatus,
    getTranscription,
} = require('../db/mongoutils/transcription.db');

describe('transcription.db.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSave.mockReset();
    });

    describe('createTranscription()', () => {
        it('should create a new meeting document and return true', async () => {
            mockSave.mockResolvedValue(true);

            const result = await createTranscription('test-job-123');

            expect(mockSave).toHaveBeenCalled();
            expect(result).toBe(true);
        });

        it('should return false if save throws an error', async () => {
            mockSave.mockRejectedValue(new Error('DB Error'));
            jest.spyOn(console, 'error').mockImplementation(() => { });

            const result = await createTranscription('error-job');

            expect(result).toBe(false);
        });
    });

    describe('appendTranscription()', () => {
        it('should append text and return true', async () => {
            Meeting.findOneAndUpdate.mockResolvedValue({ jobId: 'test-job-456' });

            const result = await appendTranscription('test-job-456', 'Hello world');

            expect(Meeting.findOneAndUpdate).toHaveBeenCalledWith(
                { jobId: 'test-job-456' },
                { $push: { transcriptionChunks: 'Hello world' } },
                { new: true, upsert: true }
            );
            expect(result).toBe(true);
        });

        it('should return false if no document is updated', async () => {
            Meeting.findOneAndUpdate.mockResolvedValue(null);

            const result = await appendTranscription('missing-job', 'Text');

            expect(result).toBe(false);
        });
    });

    describe('updateMeetingStatus()', () => {
        it('should update status and return true', async () => {
            Meeting.findOneAndUpdate.mockResolvedValue({ status: 'completed' });

            const result = await updateMeetingStatus('job-789', 'completed');

            expect(Meeting.findOneAndUpdate).toHaveBeenCalledWith(
                { jobId: 'job-789' },
                { status: 'completed' },
                { new: true }
            );
            expect(result).toBe(true);
        });

        it('should return false if document not found', async () => {
            Meeting.findOneAndUpdate.mockResolvedValue(null);

            const result = await updateMeetingStatus('non-existent', 'completed');

            expect(result).toBe(false);
        });
    });

    describe('getMeetingStatus()', () => {
        it('should return the status of a meeting', async () => {
            Meeting.findOne.mockResolvedValue({ status: 'in-progress' });

            const result = await getMeetingStatus('job-status-test');

            expect(Meeting.findOne).toHaveBeenCalledWith(
                { jobId: 'job-status-test' },
                { status: 1, _id: 0 }
            );
            expect(result).toBe('in-progress');
        });

        it('should return null if meeting not found', async () => {
            Meeting.findOne.mockResolvedValue(null);

            const result = await getMeetingStatus('missing-job');

            expect(result).toBeNull();
        });
    });

    describe('getTranscription()', () => {
        it('should return the transcription document', async () => {
            const mockDoc = { transcriptionChunks: ['Hello', 'World'], status: 'completed' };
            Meeting.findOne.mockResolvedValue(mockDoc);

            const result = await getTranscription('job-trans-test');

            expect(result).toEqual(mockDoc);
        });

        it('should return null if transcription not found', async () => {
            Meeting.findOne.mockResolvedValue(null);

            const result = await getTranscription('missing-job');

            expect(result).toBeNull();
        });
    });
});
