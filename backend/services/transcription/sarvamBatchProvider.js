// services/transcription/sarvamBatchProvider.js
// Sarvam Batch API transcription provider — orchestrates the 7-step async workflow.
// Uses the sarvamService client from utils/llm/ for auth + key rotation.

'use strict';

const axios = require('axios');
const sarvamClient = require('../../utils/llm/sarvamService');
const { createLogger } = require('../../utils/logger');

const logger = createLogger('sarvamBatchProvider');

const SARVAM_BASE = 'https://api.sarvam.ai';

// Polling configuration
const POLL_INTERVAL_MS = parseInt(process.env.SARVAM_POLL_INTERVAL_MS || '5000', 10);
const MAX_WAIT_MS = parseInt(process.env.SARVAM_MAX_WAIT_MS || '300000', 10); // 5 min default

/**
 * Step 1: Initiate a new batch transcription job.
 */
async function initiateJob(options = {}) {
    const { data } = await axios.post(
        `${SARVAM_BASE}/speech-to-text/stt/job/initiate`,
        {
            job_parameters: {
                model: options.model || 'saaras:v3',
                mode: options.mode || 'transcribe',
                language_code: options.languageCode || 'unknown',
                with_diarization: options.withDiarization !== false,
                num_speakers: options.numSpeakers || 2,
                with_timestamps: options.withTimestamps !== false,
            },
        },
        { headers: { ...sarvamClient.getHeaders(), 'Content-Type': 'application/json' } }
    );
    logger.info('Sarvam job initiated', { jobId: data.job_id, state: data.job_state });
    return data;
}

/**
 * Step 2: Get a presigned upload URL.
 */
async function getUploadUrl(sarvamJobId, filename) {
    const { data } = await axios.post(
        `${SARVAM_BASE}/speech-to-text/stt/job/upload`,
        { job_id: sarvamJobId, files: [filename] },
        { headers: { ...sarvamClient.getHeaders(), 'Content-Type': 'application/json' } }
    );
    return data.upload_urls[filename];
}

/**
 * Step 3: Upload audio buffer to the presigned URL.
 */
async function uploadFile(uploadInfo, audioBuffer, contentType = 'audio/webm') {
    await axios.put(uploadInfo.url, audioBuffer, {
        headers: { ...uploadInfo.headers, 'Content-Type': contentType },
        maxBodyLength: Infinity,
    });
    logger.debug('Audio uploaded to presigned URL');
}

/**
 * Step 4: Start processing the job.
 */
async function startJob(sarvamJobId) {
    const { data } = await axios.post(
        `${SARVAM_BASE}/speech-to-text/stt/job/start/${sarvamJobId}`,
        {},
        { headers: sarvamClient.getHeaders() }
    );
    logger.info('Sarvam job started', { jobId: sarvamJobId, state: data.job_state });
    return data;
}

/**
 * Step 5: Poll until the job completes or times out.
 */
async function waitForCompletion(sarvamJobId) {
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT_MS) {
        const { data } = await axios.get(
            `${SARVAM_BASE}/speech-to-text/stt/job/status/${sarvamJobId}`,
            { headers: sarvamClient.getHeaders() }
        );

        logger.debug('Sarvam poll', {
            jobId: sarvamJobId,
            state: data.job_state,
            elapsed: Math.round((Date.now() - startTime) / 1000) + 's',
        });

        if (data.job_state === 'Completed') return data;
        if (data.job_state === 'Failed') {
            throw new Error(`Sarvam job failed: ${data.error_message || 'unknown error'}`);
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(`Sarvam job timed out after ${MAX_WAIT_MS / 1000}s (jobId: ${sarvamJobId})`);
}

/**
 * Step 6-7: Download the transcription result JSON.
 */
async function downloadResults(sarvamJobId, outputFile) {
    const { data } = await axios.post(
        `${SARVAM_BASE}/speech-to-text/stt/job/download`,
        { job_id: sarvamJobId, files: [outputFile] },
        { headers: { ...sarvamClient.getHeaders(), 'Content-Type': 'application/json' } }
    );
    const downloadUrl = data.download_urls[outputFile].url;
    const result = await axios.get(downloadUrl);
    return result.data;
}

/**
 * Full pipeline: audioBuffer → Sarvam Batch API → raw transcript JSON.
 */
async function transcribeBatch(audioBuffer, metadata = {}) {
    const filename = metadata.originalFileName || `chunk_${Date.now()}.webm`;
    logger.info('Starting Sarvam batch transcription', { filename });

    const job = await initiateJob({ withDiarization: true, withTimestamps: true });
    const uploadInfo = await getUploadUrl(job.job_id, filename);
    await uploadFile(uploadInfo, audioBuffer, metadata.mimetype || 'audio/webm');
    await startJob(job.job_id);
    const status = await waitForCompletion(job.job_id);

    const outputFile = status.job_details?.[0]?.output_file;
    if (!outputFile) {
        throw new Error(`No output file in Sarvam job response (jobId: ${job.job_id})`);
    }

    const transcript = await downloadResults(job.job_id, outputFile);
    logger.info('Sarvam transcription complete', {
        jobId: job.job_id,
        language: transcript.language_code,
        hasDiarization: !!transcript.diarized_transcript,
    });

    return transcript;
}

module.exports = { transcribeBatch };
