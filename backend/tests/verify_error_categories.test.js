// tests/verify_error_categories.js
const { getLLMStreamResponse } = require('../controllers/chatLLM');
const { createChatEntry } = require('../db/mongoutils/chat.db');
const { queryTranscriptions, queryChats } = require('../controllers/queryVectordb');
const EventEmitter = require('events');

// Mock dependencies
jest.mock('../db/mongoutils/chat.db');
jest.mock('../controllers/queryVectordb');
jest.mock('../utils/keyRotation', () => ({
    getNextKey: () => 'mock-key'
}));
jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
            generateContentStream: jest.fn().mockResolvedValue({
                stream: (async function* () { yield { text: () => "Mock Response" }; })()
            })
        }
    }))
}));

// Mock Response Object
class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.bodyChunks = [];
        this.jsonBody = null;
    }
    setHeader(k, v) { this.headers[k] = v; }
    flushHeaders() { this.emit('headers_sent'); }
    status(code) { this.statusCode = code; return this; }
    json(obj) { this.jsonBody = obj; return this; }
    write(chunk) { this.bodyChunks.push(chunk); }
    end() { this.emit('end'); }
}

describe('Error Category Verification', () => {

    test('Category A: Success should result in 200 OK and Stream Headers', async () => {
        const res = new MockResponse();

        // Setup Mocks for Success
        queryTranscriptions.mockResolvedValue([{ text: "context" }]);
        queryChats.mockResolvedValue([]);
        createChatEntry.mockResolvedValue({ _id: "chat123" });

        await getLLMStreamResponse(res, "Hello", "job1");

        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('text/event-stream');
        expect(res.jsonBody).toBeNull();
        expect(res.bodyChunks.some(c => c.includes('Mock Response'))).toBe(true);
        console.log('✅ Category A (Success) Test Passed');
    });

    test('Category B: Pre-Stream Failure (e.g. Qdrant Timeout) should result in 503 JSON', async () => {
        const res = new MockResponse();

        // Setup Mocks for Failure
        queryTranscriptions.mockRejectedValue(new Error('ConnectTimeoutError: Connection timed out'));

        await getLLMStreamResponse(res, "Hello", "job1");

        expect(res.statusCode).toBe(503);
        expect(res.jsonBody).toEqual({
            error: {
                type: 'server_error',
                code: 'SERVICE_TIMEOUT',
                message: expect.stringContaining('trouble connecting')
            }
        });
        expect(res.headers['Content-Type']).toBeUndefined(); // Should NOT set stream headers
        console.log('✅ Category B (Timeout) Test Passed');
    });

    test('Category B: Pre-Stream Failure (e.g. Rate Limit) should result in 429 JSON', async () => {
        const res = new MockResponse();

        // Setup Mocks for Rate Limit
        queryTranscriptions.mockRejectedValue(new Error('429 Too Many Requests'));

        await getLLMStreamResponse(res, "Hello", "job1");

        expect(res.statusCode).toBe(429);
        expect(res.jsonBody.error.code).toBe('RATE_LIMIT_EXCEEDED');
        console.log('✅ Category B (Rate Limit) Test Passed');
    });
});
