// tests/verify_error_categories.js
const { getLLMStreamResponse } = require('../src/chat/chat.controller');
const { createChatEntry } = require('../src/chat/chat.repository');
const { queryTranscriptions, queryChats } = require('../src/chat/vector.search');
const EventEmitter = require('events');

// Mock dependencies
jest.mock('../src/chat/chat.repository', () => ({
    createChatEntry: jest.fn().mockResolvedValue({ _id: 'chat123' }),
    updateChatEntry: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/chat/vector.search');
// Null context sends the controller down the legacy transcription path, which is what these
// error-category cases exercise.
jest.mock('../src/chat/retrieval.wiring', () => ({
    buildContext: jest.fn().mockResolvedValue(null),
    checkQuery: jest.fn().mockResolvedValue({ verdict: 'pass', score: 0, checked: true }),
}));
jest.mock('../src/providers/embedding/chat.embedding', () => ({
    upsertChatPair: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/summary/summary.repository', () => ({
    getMeetingSummary: jest.fn().mockResolvedValue({ title: 'Test', content: 'Test meeting summary' }),
}));
jest.mock('../src/safety', () => ({
    validateInput: jest.fn().mockReturnValue({ blocked: false }),
    isRelevantToMeeting: jest.fn().mockResolvedValue({ relevant: true }),
    recordViolation: jest.fn(),
}));
jest.mock('../prompts/systemPrompt', () => ({
    SECURE_SYSTEM_PROMPT: 'Mock system prompt',
}));
jest.mock('../src/providers/llm/inference.provider', () => ({
    getChatInference: jest.fn().mockReturnValue({
        client: {
            chat: {
                completions: {
                    create: jest.fn().mockResolvedValue({
                        // Async Iterable Stream
                        [Symbol.asyncIterator]: async function* () {
                            yield { choices: [{ delta: { content: "Mock Response" } }] };
                        }
                    })
                }
            },
        },
        model: 'mock-chat-model',
        taskConfig: { provider: 'groq', model: 'mock-chat-model', temperature: 0.4, maxTokens: 6000 },
    }),
}));

// Mock Response Object
class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.bodyChunks = [];
        this.jsonBody = null;
        this.writable = true;
        this.writableEnded = false;
    }
    setHeader(k, v) { this.headers[k] = v; }
    flushHeaders() { this.emit('headers_sent'); }
    status(code) { this.statusCode = code; return this; }
    json(obj) { this.jsonBody = obj; return this; }
    write(chunk) { this.bodyChunks.push(chunk); }
    end() { this.emit('end'); }
}

describe('Error Category Verification', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

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
    });

    test('Category A: a missing chat-history collection should not fail the answer', async () => {
        const res = new MockResponse();

        queryTranscriptions.mockResolvedValue([{ text: "context" }]);
        queryChats.mockRejectedValue(new Error('Not Found'));

        await getLLMStreamResponse(res, "Hello", "job1");

        expect(res.statusCode).toBe(200);
        expect(res.bodyChunks.some(c => c.includes('Mock Response'))).toBe(true);
    });

    test('Category A: a missing summary should not fail the answer', async () => {
        const res = new MockResponse();
        const { getMeetingSummary } = require('../src/summary/summary.repository');

        queryTranscriptions.mockResolvedValue([{ text: "context" }]);
        queryChats.mockResolvedValue([]);
        getMeetingSummary.mockRejectedValue(new Error('pg down'));

        await getLLMStreamResponse(res, "Hello", "job1");

        expect(res.statusCode).toBe(200);
        getMeetingSummary.mockResolvedValue({ title: 'Test', content: 'Test meeting summary' });
    });

    test('Category B: Pre-Stream Failure (e.g. Rate Limit) should result in 429 JSON', async () => {
        const res = new MockResponse();

        // Setup Mocks for Rate Limit
        queryTranscriptions.mockRejectedValue(new Error('429 Too Many Requests'));

        await getLLMStreamResponse(res, "Hello", "job1");

        expect(res.statusCode).toBe(429);
        expect(res.jsonBody.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });
});
