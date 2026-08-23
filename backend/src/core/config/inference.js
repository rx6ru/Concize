// LLM inference provider and model configuration
// Supports per-task provider (groq | cerebras | openrouter | sarvam) and model selection

const VALID_PROVIDERS = ['groq', 'cerebras', 'openrouter', 'sarvam'];

// Supports both plural (GROQ_API_KEYS, comma-separated) and singular (GROQ_API_KEY) env var forms.
function parseKeys(pluralKey, singularKey) {
    const raw = process.env[pluralKey] || process.env[singularKey] || '';
    return raw.split(',').map(k => k.trim()).filter(k => k);
}

function validateProvider(provider, taskName) {
    const normalized = provider.toLowerCase().trim();
    if (!VALID_PROVIDERS.includes(normalized)) {
        throw new Error(
            `Invalid provider "${provider}" for ${taskName}. Valid options: ${VALID_PROVIDERS.join(', ')}`
        );
    }
    return normalized;
}

const groqKeys = parseKeys('GROQ_API_KEYS', 'GROQ_API_KEY');
const cerebrasKeys = parseKeys('CEREBRAS_API_KEYS', 'CEREBRAS_API_KEY');
const openrouterKeys = parseKeys('OPENROUTER_API_KEYS', 'OPENROUTER_API_KEY');
const geminiKeys = parseKeys('GEMINI_API_KEYS', 'GEMINI_API_KEY');
const sarvamKeys = parseKeys('SARVAM_API_KEYS', 'SARVAM_API_KEY');

// maxTokens is the answer allowance and counts against the same request limit as the prompt (see provider.limits.js). Both were previously set as if the ceiling applied to the prompt alone: chat left 2000 tokens for a context that runs ~3300, and clean asked for more than the model accepts in total.
const chat = {
    provider: validateProvider(process.env.CHAT_PROVIDER || 'cerebras', 'chat'),
    model: process.env.CHAT_MODEL || 'llama3.1-8b',
    temperature: 0.4,
    // ~900 words, generous for an answer about a meeting, and leaves 6800 for the context.
    maxTokens: Number(process.env.CHAT_MAX_TOKENS) || 1200,
    // How much context retrieval may spend, when the model's own ceiling is the wrong answer.
    // A million-token model would otherwise be handed a million-token budget, and how retrieval
    // behaves at that size has never been measured. Null means derive it from the model.
    contextTokens: Number(process.env.CHAT_CONTEXT_TOKENS) || null,
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

const transcription = {
    provider: validateProvider(process.env.TRANSCRIPTION_PROVIDER || 'sarvam', 'transcription'),
    model: process.env.TRANSCRIPTION_MODEL || 'saaras:v1',
};

const transcriptionFilters = {
    silenceThreshold: parseFloat(process.env.SILENCE_THRESHOLD || '0.5'),
    confidenceFloor: parseFloat(process.env.CONFIDENCE_FLOOR || '-0.5'),
};

module.exports = {
    groqKeys,
    cerebrasKeys,
    openrouterKeys,
    geminiKeys,
    sarvamKeys,
    chat,
    clean,
    summary,
    transcription,
    transcriptionFilters,
    VALID_PROVIDERS,
};
