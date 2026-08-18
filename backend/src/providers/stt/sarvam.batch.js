// Sarvam Batch API transcription provider: orchestrates the 7-step async workflow.

'use strict';

const axios = require('axios');
const sarvamClient = require('../llm/sarvam');
const { limitsFor } = require('../../core/provider.limits');
const { createLogger } = require('../../core/logger');

const logger = createLogger('sarvamBatchProvider');

const SARVAM_BASE = 'https://api.sarvam.ai';

const POLL_INTERVAL_MS = parseInt(process.env.SARVAM_POLL_INTERVAL_MS || '5000', 10);
const MAX_WAIT_MS = parseInt(process.env.SARVAM_MAX_WAIT_MS || '300000', 10); // 5 min default

/**
 * Step 1: Initiate a new batch transcription job.
 */
async function initiateJob(options = {}) {
    // num_speakers is optional; the provider detects the count when absent. Defaulting it to 2 previously forced every meeting into two clusters, however many people were actually talking.
    // Model is configurable (v3/v4) rather than hardcoded so the two can be compared on real audio, v4 accepts language_code 'unknown' just like v3, so auto-detection still works. (v4-multispk is a different, beta-gated model that requires an explicit language.)
    const model = options.model || process.env.SARVAM_BATCH_MODEL || 'saaras:v3';
    const jobParameters = {
        model,
        mode: options.mode || 'transcribe',
        language_code: options.languageCode || 'unknown',
        with_diarization: options.withDiarization !== false,
        with_timestamps: options.withTimestamps !== false,
    };

    if (options.numSpeakers) {
        // Asking for more than the provider supports is rejected outright, which would cost the whole job rather than just the speakers past the ceiling.
        const ceiling = limitsFor('sarvam', model).maxSpeakers;
        const asked = ceiling ? Math.min(options.numSpeakers, ceiling) : options.numSpeakers;
        if (asked < options.numSpeakers) {
            logger.warn('Capping requested speakers to the provider ceiling', {
                asked: options.numSpeakers, ceiling, model,
            });
        }
        jobParameters.num_speakers = asked;
    }

    const { data } = await axios.post(
        `${SARVAM_BASE}/speech-to-text/job/v1`,
        { job_parameters: jobParameters },
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
        `${SARVAM_BASE}/speech-to-text/job/v1/upload-files`,
        { job_id: sarvamJobId, files: [filename] },
        { headers: { ...sarvamClient.getHeaders(), 'Content-Type': 'application/json' } }
    );
    return data.upload_urls[filename];
}

/**
 * Step 3: Upload audio buffer to the presigned URL.
 */
async function uploadFile(uploadInfo, audioBuffer, contentType = 'audio/webm') {
    // Presigned Azure blob PUT: the field is `file_url` (was `url`), and the blob type header is mandatory, without it Azure rejects the upload.
    await axios.put(uploadInfo.file_url || uploadInfo.url, audioBuffer, {
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
        maxBodyLength: Infinity,
    });
    logger.debug('Audio uploaded to presigned URL');
}

/**
 * Step 4: Start processing the job.
 */
async function startJob(sarvamJobId) {
    const { data } = await axios.post(
        `${SARVAM_BASE}/speech-to-text/job/v1/${sarvamJobId}/start`,
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
            `${SARVAM_BASE}/speech-to-text/job/v1/${sarvamJobId}/status`,
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
        `${SARVAM_BASE}/speech-to-text/job/v1/download-files`,
        { job_id: sarvamJobId, files: [outputFile] },
        { headers: { ...sarvamClient.getHeaders(), 'Content-Type': 'application/json' } }
    );
    const entry = data.download_urls[outputFile];
    const downloadUrl = entry.file_url || entry.url;
    const result = await axios.get(downloadUrl);
    return result.data;
}

/**
 * Full pipeline: audioBuffer → Sarvam Batch API → raw transcript JSON.
 */
async function transcribeBatch(audioBuffer, metadata = {}) {
    const filename = metadata.originalFileName || `chunk_${Date.now()}.webm`;
    logger.info('Starting Sarvam batch transcription', { filename });

    const job = await initiateJob({
        withDiarization: true, withTimestamps: true, numSpeakers: metadata.numSpeakers,
    });
    const uploadInfo = await getUploadUrl(job.job_id, filename);
    await uploadFile(uploadInfo, audioBuffer, metadata.mimetype || 'audio/webm');
    await startJob(job.job_id);
    const status = await waitForCompletion(job.job_id);

    const outputFile = status.job_details?.[0]?.outputs?.[0]?.file_name
        ?? status.job_details?.[0]?.output_file;
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
