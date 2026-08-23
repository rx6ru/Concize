// Proves chat records its own real completion spend to the ledger the breaker reads, closing
// the gap where chat.controller.js checked isOverBudget but never recorded anything against it
// (the ledger's only writers were the narration and embedding lanes).

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/chat/chat.repository', () => ({
    createChatEntry: jest.fn().mockResolvedValue({ _id: 'chat123' }),
    updateChatEntry: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/chat/vector.search', () => ({
    queryTranscriptions: jest.fn().mockResolvedValue([{ text: 'context' }]),
    queryChats: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/chat/retrieval.wiring', () => ({
    buildContext: jest.fn().mockResolvedValue(null),
    checkQuery: jest.fn().mockResolvedValue({ verdict: 'pass', score: 0, checked: true }),
}));
jest.mock('../src/providers/embedding/chat.embedding', () => ({
    upsertChatPair: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/summary/summary.repository', () => ({
    getMeetingSummary: jest.fn().mockResolvedValue({ title: 'Test', content: 'summary' }),
}));
jest.mock('../src/safety', () => ({
    validateInput: jest.fn().mockReturnValue({ blocked: false }),
    isRelevantToMeeting: jest.fn().mockResolvedValue({ relevant: true }),
    recordViolation: jest.fn(),
    checkBlocked: jest.fn().mockReturnValue({ blocked: false, violationCount: 0 }),
    // Real guard, not a stub, matching error.categories.test.js's reasoning: a permissive fake
    // here would prove nothing about what actually reaches the ledger-recording line.
    createStreamGuard: jest.requireActual('../src/safety/output.guardrails').createStreamGuard,
    SAFE_FALLBACK: jest.requireActual('../src/safety/output.guardrails').SAFE_FALLBACK,
}));
jest.mock('../prompts/systemPrompt', () => ({ SECURE_SYSTEM_PROMPT: 'Mock system prompt' }));
jest.mock('../src/core/cost.breaker', () => ({ isOverBudget: jest.fn().mockReturnValue(false) }));
jest.mock('../src/core/usage.ledger', () => ({ ledger: { record: jest.fn() } }));

// Set by each test before calling getLLMStreamResponse; read lazily by the generator below so
// jest.clearAllMocks() (which does not touch mockImplementation) never has to re-wire this.
let mockStreamChunks;
jest.mock('../src/providers/llm/inference.provider', () => ({
    getChatInference: jest.fn().mockReturnValue({
        client: {
            chat: {
                completions: {
                    create: jest.fn().mockImplementation(async () => ({
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of mockStreamChunks) yield chunk;
                        },
                    })),
                },
            },
        },
        model: 'mock-chat-model',
        taskConfig: { provider: 'groq', model: 'mock-chat-model', temperature: 0.4, maxTokens: 6000 },
    }),
}));

const EventEmitter = require('events');
const { getLLMStreamResponse } = require('../src/chat/chat.controller');
const { ledger } = require('../src/core/usage.ledger');

class MockResponse extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 200;
        this.headers = {};
        this.bodyChunks = [];
        this.writable = true;
        this.writableEnded = false;
    }
    setHeader(k, v) { this.headers[k] = v; }
    flushHeaders() {}
    status(code) { this.statusCode = code; return this; }
    json(obj) { this.jsonBody = obj; return this; }
    write(chunk) { this.bodyChunks.push(chunk); }
    end() { this.writableEnded = true; }
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('chat completion usage recording', () => {
    it('records the real token count the provider reports, not zero', async () => {
        mockStreamChunks = [
            { choices: [{ delta: { content: 'Hello' } }] },
            { choices: [], usage: { total_tokens: 42 } },
        ];

        const res = new MockResponse();
        await getLLMStreamResponse(res, 'Hello', 'job1', 'user-A');

        expect(res.statusCode).toBe(200);
        expect(ledger.record).toHaveBeenCalledWith('groq', 'mock-chat-model', 42);
    });

    // A client that closes the tab mid-answer still cost real tokens. The loop used to bail on the
    // disconnect before reading the chunk already in hand, which is usually the terminal usage one.
    it('still records usage from the chunk in hand when the client has already disconnected', async () => {
        mockStreamChunks = [
            { choices: [{ delta: { content: 'Hello' } }] },
            { choices: [], usage: { total_tokens: 42 } },
        ];

        const res = new MockResponse();
        // Disconnects after the first delta is written, so the usage chunk arrives unwritable.
        const write = res.write.bind(res);
        res.write = (chunk) => { write(chunk); res.writableEnded = true; };

        await getLLMStreamResponse(res, 'Hello', 'job1', 'user-A');

        expect(ledger.record).toHaveBeenCalledWith('groq', 'mock-chat-model', 42);
    });

    it('records nothing when the provider never sends a usage chunk, rather than guessing zero', async () => {
        mockStreamChunks = [{ choices: [{ delta: { content: 'Hello' } }] }];

        await getLLMStreamResponse(new MockResponse(), 'Hello', 'job1', 'user-A');

        expect(ledger.record).not.toHaveBeenCalled();
    });

    it('asks the provider for stream usage in the first place', async () => {
        mockStreamChunks = [{ choices: [{ delta: { content: 'Hi' } }] }];
        const { getChatInference } = require('../src/providers/llm/inference.provider');

        await getLLMStreamResponse(new MockResponse(), 'Hi', 'job1', 'user-A');

        const create = getChatInference().client.chat.completions.create;
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            stream_options: { include_usage: true },
        }));
    });
});
