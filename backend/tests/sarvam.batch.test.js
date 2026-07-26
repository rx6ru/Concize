jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../src/providers/llm/sarvam', () => ({
    getHeaders: () => ({ 'api-subscription-key': 'test-key' }),
}));

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn(), put: jest.fn() }));

const axios = require('axios');
const { transcribeBatch } = require('../src/providers/stt/sarvam.batch');

// The seven-step batch workflow, answered in the order transcribeBatch walks it.
function stubWorkflow() {
    axios.post.mockImplementation(async (url) => {
        if (url.endsWith('/job/v1')) return { data: { job_id: 'job-1', job_state: 'Created' } };
        if (url.endsWith('/upload-files')) {
            return { data: { upload_urls: { 'a.wav': { file_url: 'https://up/a' } } } };
        }
        if (url.endsWith('/download-files')) {
            return { data: { download_urls: { 'out.json': { file_url: 'https://dl/out' } } } };
        }
        return { data: {} };
    });
    axios.put.mockResolvedValue({ data: {} });
    axios.get.mockImplementation(async (url) => {
        if (url.includes('/status')) {
            return { data: { job_state: 'Completed', job_details: [{ outputs: [{ file_name: 'out.json' }] }] } };
        }
        return { data: { diarized_transcript: { entries: [] } } };
    });
}

const jobParameters = () => axios.post.mock.calls
    .find(([url]) => url.endsWith('/job/v1'))[1].job_parameters;

beforeEach(() => {
    jest.clearAllMocks();
    stubWorkflow();
});

describe('diarization parameters', () => {
    // A hardcoded two forced every meeting into two clusters. Five AMI meetings, including a
    // four-participant one, all came back split almost exactly in half.
    it('lets the provider detect the speaker count when none is given', async () => {
        await transcribeBatch(Buffer.from('audio'), { originalFileName: 'a.wav' });

        expect(jobParameters()).not.toHaveProperty('num_speakers');
        expect(jobParameters().with_diarization).toBe(true);
    });

    it('passes a caller-supplied speaker count through', async () => {
        await transcribeBatch(Buffer.from('audio'), { originalFileName: 'a.wav', numSpeakers: 5 });

        expect(jobParameters().num_speakers).toBe(5);
    });

    // The live lane tracks thirty speakers, this provider takes eight. Asking for more is
    // rejected outright, which loses the whole job rather than the speakers past the ceiling.
    it('caps the request at the ceiling recorded for the model', async () => {
        await transcribeBatch(Buffer.from('audio'), { originalFileName: 'a.wav', numSpeakers: 22 });

        expect(jobParameters().num_speakers).toBe(8);
    });
});
