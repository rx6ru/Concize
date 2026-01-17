// tests/queryVectordb.test.js

const { queryTranscriptions, queryChats } = require('../controllers/queryVectordb');

// Mock dependencies
jest.mock('@qdrant/js-client-rest');
jest.mock('../controllers/embedding/embeddingService');
jest.mock('../utils/config', () => ({
    QDRANT_URL: 'http://mock-qdrant:6333',
    QDRANT_API_KEY: 'mock-api-key',
    TRANSCRIPTION_COLLECTION: 'test_transcriptions',
    CHAT_COLLECTION: 'test_chats',
}));

const { QdrantClient } = require('@qdrant/js-client-rest');
const { getEmbedding } = require('../controllers/embedding/embeddingService');

describe('queryVectordb Module', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock QdrantClient instance
        mockClient = {
            search: jest.fn(),
        };
        QdrantClient.mockReturnValue(mockClient);

        // Mock embedding generation
        getEmbedding.mockResolvedValue(new Array(768).fill(0.1));
    });

    describe('queryTranscriptions()', () => {
        describe('Happy Path', () => {
            it('should successfully query and return transcription chunks', async () => {
                const mockResults = [
                    {
                        payload: {
                            jobId: 'job-123',
                            text: 'Transcription chunk 1',
                            refined_text: '- Discussion about AI\n',
                        },
                        score: 0.95,
                    },
                    {
                        payload: {
                            jobId: 'job-123',
                            text: 'Transcription chunk 2',
                            refined_text: '- More discussion\n',
                        },
                        score: 0.89,
                    },
                ];

                mockClient.search.mockResolvedValue(mockResults);

                const result = await queryTranscriptions('AI discussion', 'job-123', 5);

                expect(result).toHaveLength(2);
                expect(result[0]).toEqual(mockResults[0].payload);
                expect(result[1]).toEqual(mockResults[1].payload);
            });

            it('should call getEmbedding with user prompt', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryTranscriptions('test prompt', 'job-123');

                expect(getEmbedding).toHaveBeenCalledWith('test prompt');
            });

            it('should call Qdrant search with correct parameters', async () => {
                const mockVector = new Array(768).fill(0.5);
                getEmbedding.mockResolvedValue(mockVector);
                mockClient.search.mockResolvedValue([]);

                await queryTranscriptions('test query', 'job-456', 10);

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_transcriptions',
                    expect.objectContaining({
                        vector: mockVector,
                        filter: {
                            must: [
                                {
                                    key: 'jobId',
                                    match: { value: 'job-456' },
                                },
                            ],
                        },
                        limit: 10,
                        with_payload: true,
                        with_vectors: false,
                    })
                );
            });

            it('should use default limit of 5 when not specified', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryTranscriptions('test', 'job-123');

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_transcriptions',
                    expect.objectContaining({
                        limit: 5,
                    })
                );
            });

            it('should return empty array when no results found', async () => {
                mockClient.search.mockResolvedValue([]);

                const result = await queryTranscriptions('test', 'job-123');

                expect(result).toEqual([]);
            });
        });

        describe('Error Handling', () => {
            it('should return empty array when embedding generation fails', async () => {
                getEmbedding.mockResolvedValue(null);

                const result = await queryTranscriptions('test', 'job-123');

                expect(result).toEqual([]);
                expect(mockClient.search).not.toHaveBeenCalled();
            });

            it('should return empty array when embedding is empty array', async () => {
                getEmbedding.mockResolvedValue([]);

                const result = await queryTranscriptions('test', 'job-123');

                expect(result).toEqual([]);
            });

            it('should throw error when Qdrant search fails', async () => {
                const qdrantError = new Error('Qdrant connection failed');
                mockClient.search.mockRejectedValue(qdrantError);

                await expect(queryTranscriptions('test', 'job-123')).rejects.toThrow(
                    'Qdrant connection failed'
                );
            });

            it('should throw error on Qdrant timeout', async () => {
                const timeoutError = new Error('ETIMEDOUT');
                timeoutError.code = 'ETIMEDOUT';
                mockClient.search.mockRejectedValue(timeoutError);

                await expect(queryTranscriptions('test', 'job-123')).rejects.toThrow('ETIMEDOUT');
            });

            it('should handle authentication errors', async () => {
                const authError = new Error('401 Unauthorized');
                mockClient.search.mockRejectedValue(authError);

                await expect(queryTranscriptions('test', 'job-123')).rejects.toThrow('401 Unauthorized');
            });
        });

        describe('Edge Cases', () => {
            it('should handle very long user prompts', async () => {
                const longPrompt = 'A'.repeat(5000);
                mockClient.search.mockResolvedValue([]);

                await queryTranscriptions(longPrompt, 'job-123');

                expect(getEmbedding).toHaveBeenCalledWith(longPrompt);
            });

            it('should handle special characters in jobId', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryTranscriptions('test', 'job-with-special-chars-!@#');

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_transcriptions',
                    expect.objectContaining({
                        filter: {
                            must: [
                                {
                                    key: 'jobId',
                                    match: { value: 'job-with-special-chars-!@#' },
                                },
                            ],
                        },
                    })
                );
            });

            it('should handle large limit values', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryTranscriptions('test', 'job-123', 1000);

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_transcriptions',
                    expect.objectContaining({ limit: 1000 })
                );
            });

            it('should handle limit of 1', async () => {
                const mockResult = [{ payload: { text: 'Single result' } }];
                mockClient.search.mockResolvedValue(mockResult);

                const result = await queryTranscriptions('test', 'job-123', 1);

                expect(result).toHaveLength(1);
            });
        });
    });

    describe('queryChats()', () => {
        describe('Happy Path', () => {
            it('should successfully query and return chat pairs', async () => {
                const mockResults = [
                    {
                        payload: {
                            jobId: 'job-123',
                            userChat: 'What is AI?',
                            aiChat: 'AI stands for Artificial Intelligence...',
                        },
                        score: 0.92,
                    },
                    {
                        payload: {
                            jobId: 'job-123',
                            userChat: 'Tell me more',
                            aiChat: 'Here are more details...',
                        },
                        score: 0.85,
                    },
                ];

                mockClient.search.mockResolvedValue(mockResults);

                const result = await queryChats('AI questions', 'job-123', 3);

                expect(result).toHaveLength(2);
                expect(result[0]).toEqual(mockResults[0].payload);
                expect(result[1]).toEqual(mockResults[1].payload);
            });

            it('should call getEmbedding with user prompt', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryChats('test prompt', 'job-123');

                expect(getEmbedding).toHaveBeenCalledWith('test prompt');
            });

            it('should call Qdrant search with correct collection name', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryChats('test', 'job-123');

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_chats',
                    expect.any(Object)
                );
            });

            it('should use default limit of 3 when not specified', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryChats('test', 'job-123');

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_chats',
                    expect.objectContaining({ limit: 3 })
                );
            });

            it('should filter by jobId correctly', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryChats('test', 'specific-job-id', 5);

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_chats',
                    expect.objectContaining({
                        filter: {
                            must: [
                                {
                                    key: 'jobId',
                                    match: { value: 'specific-job-id' },
                                },
                            ],
                        },
                    })
                );
            });

            it('should return empty array when no chat history found', async () => {
                mockClient.search.mockResolvedValue([]);

                const result = await queryChats('test', 'job-123');

                expect(result).toEqual([]);
            });
        });

        describe('Error Handling', () => {
            it('should return empty array when embedding generation fails', async () => {
                getEmbedding.mockResolvedValue(null);

                const result = await queryChats('test', 'job-123');

                expect(result).toEqual([]);
                expect(mockClient.search).not.toHaveBeenCalled();
            });

            it('should return empty array when embedding is empty', async () => {
                getEmbedding.mockResolvedValue([]);

                const result = await queryChats('test', 'job-123');

                expect(result).toEqual([]);
            });

            it('should throw error when Qdrant search fails', async () => {
                const error = new Error('Collection not found');
                mockClient.search.mockRejectedValue(error);

                await expect(queryChats('test', 'job-123')).rejects.toThrow('Collection not found');
            });

            it('should handle network errors', async () => {
                const networkError = new Error('ECONNREFUSED');
                networkError.code = 'ECONNREFUSED';
                mockClient.search.mockRejectedValue(networkError);

                await expect(queryChats('test', 'job-123')).rejects.toThrow('ECONNREFUSED');
            });
        });

        describe('Edge Cases', () => {
            it('should handle empty jobId', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryChats('test', '', 3);

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_chats',
                    expect.objectContaining({
                        filter: {
                            must: [{ key: 'jobId', match: { value: '' } }],
                        },
                    })
                );
            });

            it('should handle unicode in user prompt', async () => {
                const unicodePrompt = 'Test with émojis 😀 and 中文';
                mockClient.search.mockResolvedValue([]);

                await queryChats(unicodePrompt, 'job-123');

                expect(getEmbedding).toHaveBeenCalledWith(unicodePrompt);
            });

            it('should handle single result', async () => {
                const singleResult = [
                    {
                        payload: {
                            userChat: 'Question',
                            aiChat: 'Answer',
                            jobId: 'job-123',
                        },
                    },
                ];
                mockClient.search.mockResolvedValue(singleResult);

                const result = await queryChats('test', 'job-123');

                expect(result).toHaveLength(1);
                expect(result[0]).toEqual(singleResult[0].payload);
            });

            it('should handle custom high limit', async () => {
                mockClient.search.mockResolvedValue([]);

                await queryChats('test', 'job-123', 50);

                expect(mockClient.search).toHaveBeenCalledWith(
                    'test_chats',
                    expect.objectContaining({ limit: 50 })
                );
            });
        });
    });

    describe('Module Integration', () => {
        it('should initialize QdrantClient with correct configuration', () => {
            expect(QdrantClient).toHaveBeenCalledWith({
                url: 'http://mock-qdrant:6333',
                apiKey: 'mock-api-key',
                timeout: 60000,
            });
        });

        it('should use same client instance for both functions', async () => {
            mockClient.search.mockResolvedValue([]);

            await queryTranscriptions('test1', 'job-1');
            await queryChats('test2', 'job-2');

            expect(mockClient.search).toHaveBeenCalledTimes(2);
        });

        it('should handle concurrent queries to both collections', async () => {
            mockClient.search.mockResolvedValue([]);

            await Promise.all([
                queryTranscriptions('test1', 'job-1'),
                queryChats('test2', 'job-2'),
            ]);

            expect(mockClient.search).toHaveBeenCalledTimes(2);
        });
    });

    describe('Performance', () => {
        it('should request payload but not vectors for efficiency', async () => {
            mockClient.search.mockResolvedValue([]);

            await queryTranscriptions('test', 'job-123');

            expect(mockClient.search).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    with_payload: true,
                    with_vectors: false,
                })
            );
        });

        it('should limit query results appropriately', async () => {
            const manyResults = Array.from({ length: 100 }, (_, i) => ({
                payload: { text: `Result ${i}` },
            }));
            mockClient.search.mockResolvedValue(manyResults);

            const result = await queryTranscriptions('test', 'job-123', 5);

            // Client should respect limit parameter
            expect(mockClient.search).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ limit: 5 })
            );
        });
    });
});