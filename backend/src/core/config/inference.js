// LLM inference provider and model configuration
// Supports per-task provider (groq | cerebras | sarvam) and model selection

const VALID_PROVIDERS = ['groq', 'cerebras', 'sarvam'];

/**
 * Parses comma-separated API keys from environment variables.
 * Supports both plural (GROQ_API_KEYS) and singular (GROQ_API_KEY) forms.
 * @param {string} pluralKey - Env var name for comma-separated keys
 * @param {string} singularKey - Env var name for a single key fallback
 * @returns {string[]}
 */
function parseKeys(pluralKey, singularKey) {
    const raw = process.env[pluralKey] || process.env[singularKey] || '';
    return raw.split(',').map(k => k.trim()).filter(k => k);
}

/**
 * Validates that a provider name is supported.
 * @param {string} provider
 * @param {string} taskName - For error messaging
 * @returns {string} Validated provider name
 */
function validateProvider(provider, taskName) {
    const normalized = provider.toLowerCase().trim();
    if (!VALID_PROVIDERS.includes(normalized)) {
        throw new Error(
            `Invalid provider "${provider}" for ${taskName}. Valid options: ${VALID_PROVIDERS.join(', ')}`
        );
    }
    return normalized;
}

// --- API Keys ---
const groqKeys = parseKeys('GROQ_API_KEYS', 'GROQ_API_KEY');
const cerebrasKeys = parseKeys('CEREBRAS_API_KEYS', 'CEREBRAS_API_KEY');
const geminiKeys = parseKeys('GEMINI_API_KEYS', 'GEMINI_API_KEY');
const sarvamKeys = parseKeys('SARVAM_API_KEYS', 'SARVAM_API_KEY');

// --- Per-task provider + model routing ---
// maxTokens is the ANSWER allowance, and the provider counts it as part of the request — so every
// token reserved here is a token the prompt cannot use. See core/provider.limits.js. Both of these
// were set as though the ceiling applied to the prompt alone; chat left 2000 tokens for a context
// that is routinely 3300, and clean asked for more than the model accepts in total.
const chat = {
    provider: validateProvider(process.env.CHAT_PROVIDER || 'cerebras', 'chat'),
    model: process.env.CHAT_MODEL || 'llama3.1-8b',
    temperature: 0.4,
    // ~900 words, generous for an answer about a meeting, and leaves 6800 for the context.
    maxTokens: Number(process.env.CHAT_MAX_TOKENS) || 1200,
};

const clean = {
    provider: validateProvider(process.env.CLEAN_PROVIDER || 'cerebras', 'clean'),
    model: process.env.CLEAN_MODEL || 'llama3.1-8b',
    temperature: 1,
    // Output is a tidied copy of its input, and a chunk is capped at 800 tokens.
    maxTokens: Number(process.env.CLEAN_MAX_TOKENS) || 1500,
};

const summary = {
    provider: validateProvider(process.env.SUMMARY_PROVIDER || 'cerebras', 'summary'),
    model: process.env.SUMMARY_MODEL || 'llama3.1-8b',
};

// Transcription — now configurable (defaults to Sarvam)
const transcription = {
    provider: validateProvider(process.env.TRANSCRIPTION_PROVIDER || 'sarvam', 'transcription'),
    model: process.env.TRANSCRIPTION_MODEL || 'saaras:v1',
};

// --- Transcription quality filters (tunable via env) ---
const transcriptionFilters = {
    silenceThreshold: parseFloat(process.env.SILENCE_THRESHOLD || '0.5'),
    confidenceFloor: parseFloat(process.env.CONFIDENCE_FLOOR || '-0.5'),
};

module.exports = {
    groqKeys,
    cerebrasKeys,
    geminiKeys,
    sarvamKeys,
    chat,
    clean,
    summary,
    transcription,
    transcriptionFilters,
    VALID_PROVIDERS,
};
