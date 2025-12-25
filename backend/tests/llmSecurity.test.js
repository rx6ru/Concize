// tests/llmSecurity.test.js

// Mock summary.db
jest.mock('../db/mongoutils/summary.db', () => ({
    getMeetingSummary: jest.fn()
}));

const inputGuardrails = require('../utils/llmSecurity/inputGuardrails');
const relevanceFilter = require('../utils/llmSecurity/relevanceFilter');
const outputGuardrails = require('../utils/llmSecurity/outputGuardrails');
const securityMonitor = require('../utils/llmSecurity/securityMonitor');
const { getMeetingSummary } = require('../db/mongoutils/summary.db');

describe('LLM Security', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'warn').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
        jest.spyOn(console, 'log').mockImplementation(() => { });
        securityMonitor.clearViolations('test-job');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('inputGuardrails (simplified)', () => {
        it('should pass valid input', () => {
            const result = inputGuardrails.validate('What was discussed about the budget?');
            expect(result.valid).toBe(true);
            expect(result.blocked).toBe(false);
        });

        it('should block empty input', () => {
            const result = inputGuardrails.validate('');
            expect(result.blocked).toBe(true);
            expect(result.reason).toBe('empty_input');
        });

        it('should block whitespace-only input', () => {
            const result = inputGuardrails.validate('   \n\t   ');
            expect(result.blocked).toBe(true);
            expect(result.reason).toBe('empty_input');
        });

        it('should block input exceeding max length', () => {
            const longInput = 'a'.repeat(11000);
            const result = inputGuardrails.validate(longInput);
            expect(result.blocked).toBe(true);
            expect(result.reason).toBe('too_long');
        });

        it('should ALLOW security-related discussion (no more banned keywords)', () => {
            // These should pass because meetings might legitimately discuss these topics
            const legitQueries = [
                'What did we say about prompt injection prevention?',
                'How should we handle jailbreak attempts?',
                'Discuss developer mode features',
                'What was the bypass strategy we mentioned?'
            ];

            legitQueries.forEach(query => {
                const result = inputGuardrails.validate(query);
                expect(result.valid).toBe(true);
            });
        });
    });

    describe('relevanceFilter (lenient)', () => {
        it('should allow meta-questions about the meeting', async () => {
            const result = await relevanceFilter.isRelevantToMeeting('What was this meeting about?', 'test-job');
            expect(result.relevant).toBe(true);
            expect(result.reason).toBe('meta_query');
        });

        it('should allow queries when no summary exists', async () => {
            getMeetingSummary.mockResolvedValue(null);
            const result = await relevanceFilter.isRelevantToMeeting('Random question', 'test-job');
            expect(result.relevant).toBe(true);
            expect(result.reason).toBe('no_summary_yet');
        });

        it('should allow short queries (lenient)', async () => {
            getMeetingSummary.mockResolvedValue({
                title: 'Q4 Budget Review',
                content: 'Discussed marketing budget allocation.'
            });

            const result = await relevanceFilter.isRelevantToMeeting('Budget?', 'test-job');
            expect(result.relevant).toBe(true);
            expect(result.reason).toBe('short_query');
        });

        it('should allow queries with at least 1 keyword match', async () => {
            getMeetingSummary.mockResolvedValue({
                title: 'Q4 Budget Review',
                content: 'Discussed marketing budget allocation and Q4 revenue projections.'
            });

            const result = await relevanceFilter.isRelevantToMeeting(
                'What were the projections for next quarter marketing?',
                'test-job'
            );
            expect(result.relevant).toBe(true);
        });

        it('should soft-reject clearly off-topic queries', async () => {
            getMeetingSummary.mockResolvedValue({
                title: 'Q4 Budget Review',
                content: 'Discussed marketing budget allocation and Q4 revenue projections.'
            });

            const result = await relevanceFilter.isRelevantToMeeting(
                'Write me a poem about cats dogs birds fish animals nature',
                'test-job'
            );
            expect(result.relevant).toBe(false);
            expect(result.reason).toBe('off_topic');
            // Check for friendly message
            expect(result.message).toContain('rephrase');
        });
    });

    describe('outputGuardrails', () => {
        it('should pass clean output', () => {
            const result = outputGuardrails.validate('The budget was $50,000 for Q4.');
            expect(result.valid).toBe(true);
            expect(result.filtered).toBe(false);
        });

        it('should detect prompt leakage', () => {
            const leakyOutput = 'My system_role is to assist with meetings';
            const result = outputGuardrails.validate(leakyOutput);
            expect(result.filtered).toBe(true);
        });
    });

    describe('securityMonitor', () => {
        it('should track violations', () => {
            const count = securityMonitor.recordViolation('test-id', 'off_topic', {});
            expect(count).toBe(1);
        });

        it('should block after threshold', () => {
            for (let i = 0; i < 10; i++) {
                securityMonitor.recordViolation('bad-actor', 'abuse', {});
            }
            const check = securityMonitor.checkBlocked('bad-actor');
            expect(check.blocked).toBe(true);
        });
    });
});
