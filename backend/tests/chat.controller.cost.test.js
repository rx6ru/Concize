// Proves the cost breaker is actually wired into the chat controller, and that it runs first:
// a trip must short-circuit before the injection guard, the relevance check, retrieval, or the
// completion call — none of which are free. Everything downstream of the breaker check is
// mocked; those paths already have their own coverage elsewhere (injection.guard.test.js,
// output.guardrails.test.js, retrieval.pipeline.test.js, etc).

jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../src/core/cost.breaker', () => ({ isOverBudget: jest.fn() }));
jest.mock('../src/providers/llm/inference.provider', () => ({ getChatInference: jest.fn() }));
jest.mock('../src/providers/llm/resilient.inference', () => ({ runResilient: jest.fn() }));
jest.mock('../src/chat/vector.search', () => ({ queryTranscriptions: jest.fn(), queryChats: jest.fn() }));
jest.mock('../src/chat/retrieval.wiring', () => ({ buildContext: jest.fn(), checkQuery: jest.fn() }));
jest.mock('../src/chat/chat.repository', () => ({ createChatEntry: jest.fn(), updateChatEntry: jest.fn() }));
jest.mock('../src/providers/embedding/chat.embedding', () => ({ upsertChatPair: jest.fn() }));
jest.mock('../src/summary/summary.repository', () => ({ getMeetingSummary: jest.fn() }));
jest.mock('../src/safety', () => ({
    validateInput: jest.fn(),
    isRelevantToMeeting: jest.fn(),
    recordViolation: jest.fn(),
    checkBlocked: jest.fn(),
    createStreamGuard: jest.fn(),
    SAFE_FALLBACK: '[redacted]',
}));

const { isOverBudget } = require('../src/core/cost.breaker');
const { checkBlocked, validateInput } = require('../src/safety');
const { checkQuery, buildContext } = require('../src/chat/retrieval.wiring');
const { getChatInference } = require('../src/providers/llm/inference.provider');
const config = require('../src/core/config');
const { getLLMStreamResponse } = require('../src/chat/chat.controller');

function fakeRes() {
    const res = { statusCode: null, body: null, headersSent: false, writable: true, writableEnded: false };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; res.headersSent = true; return res; };
    res.setHeader = () => {};
    res.flushHeaders = () => {};
    res.write = () => {};
    res.end = () => { res.writableEnded = true; };
    return res;
}

beforeEach(() => {
    jest.clearAllMocks();
    checkBlocked.mockReturnValue({ blocked: false });
});

describe('cost breaker tripped', () => {
    it('refuses with 503 before any other work', async () => {
        isOverBudget.mockReturnValue(true);
        const res = fakeRes();

        await getLLMStreamResponse(res, 'what did we decide?', 'm1', 'user-A');

        expect(res.statusCode).toBe(503);
        expect(res.body.error.code).toBe('DAILY_COST_CEILING_REACHED');
    });

    it('never calls the injection guard, relevance check, retrieval, or the LLM client', async () => {
        isOverBudget.mockReturnValue(true);

        await getLLMStreamResponse(fakeRes(), 'what did we decide?', 'm1', 'user-A');

        expect(checkBlocked).not.toHaveBeenCalled();
        expect(validateInput).not.toHaveBeenCalled();
        expect(checkQuery).not.toHaveBeenCalled();
        expect(buildContext).not.toHaveBeenCalled();
        expect(getChatInference).not.toHaveBeenCalled();
    });

    it('checks the breaker against the configured chat provider, model and cost ceiling', async () => {
        isOverBudget.mockReturnValue(true);

        await getLLMStreamResponse(fakeRes(), 'x', 'm1', 'user-A');

        expect(isOverBudget).toHaveBeenCalledWith(
            config.inference.chat.provider,
            config.inference.chat.model,
            expect.objectContaining({ ceilingTokens: config.limits.costCeilingTokensPerDay }),
        );
    });
});

describe('cost breaker not tripped', () => {
    it('falls through to normal Phase 0 handling', async () => {
        isOverBudget.mockReturnValue(false);
        checkBlocked.mockReturnValue({ blocked: true, violationCount: 5 });
        const res = fakeRes();

        await getLLMStreamResponse(res, 'x', 'm1', 'user-A');

        expect(checkBlocked).toHaveBeenCalledWith('m1');
        expect(res.statusCode).toBe(429);
        expect(res.body.error.code).toBe('TEMPORARILY_BLOCKED');
    });
});
