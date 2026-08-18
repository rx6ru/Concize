// Parameters for pre-chunking transcription segments.

module.exports = {
    // Timestamp gap (seconds) that triggers a new chunk boundary
    GAP_THRESHOLD_SECONDS: parseFloat(process.env.CHUNK_GAP_THRESHOLD || '3.0'),

    // Minimum tokens in a speaker turn before a speaker change forces a new chunk.
    // Prevents tiny turns like "yes" or "mm-hmm" from becoming their own chunks.
    MIN_TURN_TOKENS: parseInt(process.env.MIN_TURN_TOKENS || '10', 10),

    // Maximum tokens per chunk before forcing a split at the next sentence boundary
    MAX_CHUNK_TOKENS: parseInt(process.env.MAX_CHUNK_TOKENS || '500', 10),

    // Minimum tokens per chunk: chunks smaller than this are merged with a neighbor
    MIN_CHUNK_TOKENS: parseInt(process.env.MIN_CHUNK_TOKENS || '50', 10),
};
