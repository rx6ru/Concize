// tests/meetingRoutes.test.js

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// Mock the database utility
jest.mock('../db/queries/transcription.db', () => ({
    createTranscription: jest.fn(),
    updateMeetingStatus: jest.fn(),
    // The legacy summary route runs requireLegacyMeetingAccess, which calls getMeetingOwner.
    // Resolve to the stub user so the ownership gate passes.
    getMeetingOwner: jest.fn().mockResolvedValue('test-owner'),
}));

const { createTranscription } = require('../db/queries/transcription.db');
const meetingRoutes = require('../routes/v1/meetingRoutes');

// Setup test app. A stub auth middleware injects req.user, mirroring the real
// `authenticate` middleware that runs globally in production.
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => { req.user = { id: 'test-owner' }; next(); });
app.use('/api/v1/meeting', meetingRoutes);

describe('Meeting Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('POST /api/v1/meeting/start', () => {
        it('should return a jobId and set a cookie on success', async () => {
            createTranscription.mockResolvedValue(true);

            const response = await request(app)
                .post('/api/v1/meeting/start')
                .send();

            expect(response.status).toBe(201);
            expect(response.body.success).toBe(true);
            expect(response.body.meetingId).toBeDefined();
            expect(typeof response.body.meetingId).toBe('string');
            expect(response.headers['set-cookie']).toBeDefined();
        });

        it('should return 500 if createTranscription fails', async () => {
            createTranscription.mockResolvedValue(false);

            const response = await request(app)
                .post('/api/v1/meeting/start')
                .send();

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
        });

        it('should call createTranscription with the generated jobId', async () => {
            createTranscription.mockResolvedValue(true);

            await request(app).post('/api/v1/meeting/start').send();

            expect(createTranscription).toHaveBeenCalledTimes(1);
            expect(createTranscription).toHaveBeenCalledWith(expect.any(String), 'test-owner');
        });
    });
});


// Re-doing the top level mock to include getMeetingSummary
jest.mock('../db/queries/summary.db', () => ({
    getMeetingSummary: jest.fn(),
}));

// Re-import after mock
const { getMeetingSummary } = require('../db/queries/summary.db');

describe('Meeting Routes (Expanded)', () => {
    // Tests for GET /api/v1/meeting/:jobId/summary
    describe('GET /api/v1/meeting/:jobId/summary', () => {

        it('should return 200 and summary data when found', async () => {
            const mockSummary = {
                title: 'Test Summary',
                content: 'Meeting content',
                status: 'updating',
                updatedAt: new Date().toISOString()
            };
            getMeetingSummary.mockResolvedValue(mockSummary);

            const response = await request(app).get('/api/v1/meeting/job-123/summary');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.summary).toEqual(mockSummary);
            expect(getMeetingSummary).toHaveBeenCalledWith('job-123');
        });

        it('should return 404 when summary not found', async () => {
            getMeetingSummary.mockResolvedValue(null);

            const response = await request(app).get('/api/v1/meeting/job-123/summary');

            expect(response.status).toBe(404);
            expect(response.body.success).toBe(false);
            expect(response.body.error).toMatch(/not found/);
        });

        it('should return 500 on database error', async () => {
            getMeetingSummary.mockRejectedValue(new Error('DB Error'));

            const response = await request(app).get('/api/v1/meeting/job-123/summary');

            expect(response.status).toBe(500);
            expect(response.body.success).toBe(false);
        });
    });
});

