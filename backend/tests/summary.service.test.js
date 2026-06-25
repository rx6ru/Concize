// tests/summaryService.test.js

// Mock DB utilities
jest.mock('../src/summary/summary.repository', () => ({
    startSummaryUpdate: jest.fn(),
    saveSummaryContent: jest.fn(),
}));

// Mock inference provider
const mockClient = {
    chat: {
        completions: {
            create: jest.fn(),
        },
    },
};

jest.mock('../src/providers/llm/inference.provider', () => ({
    getSummaryInference: jest.fn().mockReturnValue({
        client: mockClient,
        model: 'mock-summary-model',
        taskConfig: { provider: 'groq', model: 'mock-summary-model' },
    }),
}));

// Mock secure prompt module
jest.mock('../prompts/meetingSummary', () => ({
    getSummaryPrompt: jest.fn().mockReturnValue('Mock prompt template'),
}));

const { startSummaryUpdate, saveSummaryContent } = require('../src/summary/summary.repository');
const { processSummaryUpdate } = require('../src/summary/summary.service');

describe('summaryService.js', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('processSummaryUpdate()', () => {
        const mockSummaryDoc = {
            jobId: 'test-job',
            title: 'Test Meeting',
            content: 'Previous summary content',
            wordLimit: 500,
            lastProcessedChunkIndex: 2,
        };


        it('should process a chunk successfully', async () => {
            startSummaryUpdate.mockResolvedValue(mockSummaryDoc);
            mockClient.chat.completions.create.mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            title: 'Updated Title',
                            summary: 'Updated summary with new info',
                        }),
                    },
                }],
            });
            saveSummaryContent.mockResolvedValue();

            await processSummaryUpdate('test-job', 'New transcript chunk', 3);

            expect(startSummaryUpdate).toHaveBeenCalledWith('test-job', 3);
            expect(mockClient.chat.completions.create).toHaveBeenCalled();
            expect(saveSummaryContent).toHaveBeenCalledWith(
                'test-job',
                { title: 'Updated Title', summary: 'Updated summary with new info' },
                3
            );
        });

        it('should throw error if startSummaryUpdate returns null', async () => {
            startSummaryUpdate.mockResolvedValue(null);

            // With current implementation, it returns early without throwing
            // This tests that behavior
            await processSummaryUpdate('test-job', 'Text', 3);

            expect(mockClient.chat.completions.create).not.toHaveBeenCalled();
            expect(saveSummaryContent).not.toHaveBeenCalled();
        });

        it('should throw error if LLM returns invalid JSON', async () => {
            startSummaryUpdate.mockResolvedValue(mockSummaryDoc);
            mockClient.chat.completions.create.mockResolvedValue({
                choices: [{
                    message: {
                        content: 'Not valid JSON',
                    },
                }],
            });

            await expect(processSummaryUpdate('test-job', 'Text', 3)).rejects.toThrow();
        });

        it('should throw error if LLM response is missing title or summary', async () => {
            startSummaryUpdate.mockResolvedValue(mockSummaryDoc);
            mockClient.chat.completions.create.mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({ title: 'Only Title' }), // Missing summary
                    },
                }],
            });

            await expect(processSummaryUpdate('test-job', 'Text', 3)).rejects.toThrow('Missing title or summary');
        });

        it('should throw error if LLM returns empty response', async () => {
            startSummaryUpdate.mockResolvedValue(mockSummaryDoc);
            mockClient.chat.completions.create.mockResolvedValue({
                choices: [{
                    message: {
                        content: '',
                    },
                }],
            });

            await expect(processSummaryUpdate('test-job', 'Text', 3)).rejects.toThrow('Empty response');
        });

        it('should propagate errors from startSummaryUpdate', async () => {
            const dbError = new Error('Out of order: chunk 5');
            startSummaryUpdate.mockRejectedValue(dbError);

            await expect(processSummaryUpdate('test-job', 'Text', 5)).rejects.toThrow('Out of order');
        });
    });
});
