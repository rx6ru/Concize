// tests/meetingRoutes.test.js

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// Mock the database utility
jest.mock('../db/mongoutils/transcription.db', () => ({
    createTranscription: jest.fn(),
    updateMeetingStatus: jest.fn(),
}));

const { createTranscription } = require('../db/mongoutils/transcription.db');
const meetingRoutes = require('../routes/meetingRoutes');

// Setup test app
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/meeting', meetingRoutes);

describe('Meeting Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('POST /api/meeting/start', () => {
        it('should return a jobId and set a cookie on success', async () => {
            createTranscription.mockResolvedValue(true);

            const response = await request(app)
                .post('/api/meeting/start')
                .send();

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.jobId).toBeDefined();
            expect(typeof response.body.jobId).toBe('string');
            expect(response.headers['set-cookie']).toBeDefined();
        });

        it('should return 500 if createTranscription fails', async () => {
            createTranscription.mockResolvedValue(false);

            const response = await request(app)
                .post('/api/meeting/start')
                .send();

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
        });

        it('should call createTranscription with the generated jobId', async () => {
            createTranscription.mockResolvedValue(true);

            await request(app).post('/api/meeting/start').send();

            expect(createTranscription).toHaveBeenCalledTimes(1);
            expect(createTranscription).toHaveBeenCalledWith(expect.any(String));
        });
    });
});
