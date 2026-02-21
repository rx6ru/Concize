// services/preChunker.js
// Groups transcription segments into semantically coherent chunks
// using structural signals: speaker changes, timestamp gaps, and token limits.

'use strict';

const config = require('../configs/appConfig');
const { createLogger } = require('../utils/logger');

const logger = createLogger('preChunker');

/**
 * Rough token count: split by whitespace.
 * Not exact (would need a tokenizer for that), but sufficient for chunking decisions.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
    return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Groups transcription segments into pre-chunks based on structural signals.
 *
 * Boundary rules (in priority order):
 * 1. Timestamp gap > GAP_THRESHOLD_SECONDS → always a new chunk
 * 2. Speaker change → new chunk IF the current chunk has ≥ MIN_TURN_TOKENS
 * 3. Current chunk exceeds MAX_CHUNK_TOKENS → split at next segment
 *
 * Post-processing:
 * - Chunks smaller than MIN_CHUNK_TOKENS are merged with their neighbor
 *
 * @param {import('./transcription/transcriptionResult').TranscriptionResult} result
 * @returns {Array<{
 *   text: string,
 *   startTime: number,
 *   endTime: number,
 *   speakers: string[],
 *   segmentCount: number,
 * }>}
 */
function preChunkSegments(result) {
    const {
        GAP_THRESHOLD_SECONDS,
        MIN_TURN_TOKENS,
        MAX_CHUNK_TOKENS,
        MIN_CHUNK_TOKENS,
    } = config.chunking;

    const segments = result.segments || [];

    if (segments.length === 0) {
        // Fallback: if no segments, create a single chunk from flat text
        if (result.transcription && result.transcription.trim()) {
            return [{
                text: result.transcription.trim(),
                startTime: 0,
                endTime: 0,
                speakers: [],
                segmentCount: 0,
            }];
        }
        return [];
    }

    // Phase 1: Group segments into raw chunks using boundary rules
    const rawChunks = [];
    let currentChunk = createEmptyChunk();

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const prevSeg = i > 0 ? segments[i - 1] : null;

        let shouldSplit = false;

        if (prevSeg) {
            // Rule 1: Timestamp gap
            const gap = seg.startTime - prevSeg.endTime;
            if (gap > GAP_THRESHOLD_SECONDS) {
                shouldSplit = true;
            }

            // Rule 2: Speaker change (only if current chunk has enough content)
            if (!shouldSplit && seg.speaker != null && prevSeg.speaker != null) {
                if (seg.speaker !== prevSeg.speaker) {
                    const currentTokens = estimateTokens(currentChunk.text);
                    if (currentTokens >= MIN_TURN_TOKENS) {
                        shouldSplit = true;
                    }
                }
            }

            // Rule 3: Token limit exceeded
            if (!shouldSplit) {
                const projectedTokens = estimateTokens(currentChunk.text + ' ' + seg.text);
                if (projectedTokens > MAX_CHUNK_TOKENS) {
                    shouldSplit = true;
                }
            }
        }

        // Split: save current chunk and start a new one
        if (shouldSplit && currentChunk.text.trim()) {
            rawChunks.push(finalizeChunk(currentChunk));
            currentChunk = createEmptyChunk();
        }

        // Add segment to current chunk
        addSegmentToChunk(currentChunk, seg);
    }

    // Don't forget the last chunk
    if (currentChunk.text.trim()) {
        rawChunks.push(finalizeChunk(currentChunk));
    }

    // Phase 2: Merge tiny chunks with neighbors
    const mergedChunks = mergeTinyChunks(rawChunks, MIN_CHUNK_TOKENS);

    logger.info('Pre-chunking complete', {
        inputSegments: segments.length,
        rawChunks: rawChunks.length,
        mergedChunks: mergedChunks.length,
        hasSpeakers: segments.some(s => s.speaker != null),
    });

    return mergedChunks;
}

/**
 * Creates an empty chunk accumulator.
 */
function createEmptyChunk() {
    return {
        texts: [],
        startTime: Infinity,
        endTime: -Infinity,
        speakers: new Set(),
        segmentCount: 0,
        text: '',
    };
}

/**
 * Adds a segment to a chunk accumulator.
 */
function addSegmentToChunk(chunk, seg) {
    chunk.texts.push(seg.text);
    chunk.text = chunk.texts.join(' ');
    chunk.startTime = Math.min(chunk.startTime, seg.startTime);
    chunk.endTime = Math.max(chunk.endTime, seg.endTime);
    if (seg.speaker != null) chunk.speakers.add(seg.speaker);
    chunk.segmentCount++;
}

/**
 * Converts a chunk accumulator into the final output shape.
 */
function finalizeChunk(chunk) {
    return {
        text: chunk.text.trim(),
        startTime: chunk.startTime === Infinity ? 0 : chunk.startTime,
        endTime: chunk.endTime === -Infinity ? 0 : chunk.endTime,
        speakers: [...chunk.speakers],
        segmentCount: chunk.segmentCount,
    };
}

/**
 * Merges chunks smaller than minTokens with their nearest neighbor.
 * Forward merge (into next chunk) is preferred; falls back to backward merge.
 */
function mergeTinyChunks(chunks, minTokens) {
    if (chunks.length <= 1) return chunks;

    const merged = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tokens = estimateTokens(chunk.text);

        if (tokens < minTokens && merged.length > 0) {
            // Merge backward into previous chunk
            const prev = merged[merged.length - 1];
            prev.text = prev.text + ' ' + chunk.text;
            prev.endTime = Math.max(prev.endTime, chunk.endTime);
            prev.speakers = [...new Set([...prev.speakers, ...chunk.speakers])];
            prev.segmentCount += chunk.segmentCount;
        } else {
            merged.push({ ...chunk });
        }
    }

    return merged;
}

module.exports = { preChunkSegments, estimateTokens };
