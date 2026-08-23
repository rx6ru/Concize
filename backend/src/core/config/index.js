// Merges all config modules into a single export (config.server.PORT, config.inference.chat.model, ...).

require('dotenv').config();

// Logger must be required AFTER dotenv to pick up LOG_LEVEL
const { createLogger } = require('../logger');
const logger = createLogger('config');

const server = require('./runtime');
const database = require('./database');
const storage = require('./storage');
const auth = require('./auth');
const inference = require('./inference');
const queues = require('./queues');
const { promptBudget, maxRequestTokens } = require('../provider.limits');
const chunking = require('./chunking');
const limits = require('./limits');

// --- Startup Validation ---
const warnings = [];
const errors = [];

if (inference.groqKeys.length === 0 && inference.cerebrasKeys.length === 0) {
    warnings.push('No Groq or Cerebras API keys configured. LLM features will fail at runtime.');
}

// Validate that keys exist for configured providers
const tasksUsingCerebras = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'cerebras');
const tasksUsingGroq = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'groq');

const tasksUsingOpenRouter = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'openrouter');

if (tasksUsingOpenRouter.length > 0 && inference.openrouterKeys.length === 0) {
    warnings.push(
        `Tasks [${tasksUsingOpenRouter.join(', ')}] are configured to use OpenRouter, ` +
        `but no OPENROUTER_API_KEYS are set.`
    );
}

if (tasksUsingCerebras.length > 0 && inference.cerebrasKeys.length === 0) {
    warnings.push(
        `Tasks [${tasksUsingCerebras.join(', ')}] are configured to use Cerebras, ` +
        `but no CEREBRAS_API_KEYS are set.`
    );
}

// Groq keys needed for transcription (if provider is groq) plus any LLM tasks
if (inference.groqKeys.length === 0) {
    const groqNeeds = [...tasksUsingGroq];
    if (inference.transcription.provider === 'groq') groqNeeds.push('transcription (Whisper)');
    if (groqNeeds.length > 0) {
        warnings.push(
            `No GROQ_API_KEYS set. Required for: [${groqNeeds.join(', ')}].`
        );
    }
}

if (inference.transcription.provider === 'sarvam' && inference.sarvamKeys.length === 0) {
    warnings.push('TRANSCRIPTION_PROVIDER is set to sarvam, but no SARVAM_API_KEYS are set. Transcriptions will fail.');
}

if (inference.geminiKeys.length === 0) {
    warnings.push('No GEMINI_API_KEYS set. Embedding features will not work.');
}

if (!database.POSTGRES_URL) {
    warnings.push('POSTGRES_URL is not set.');
}

if (!queues.CLOUDAMQP_URL) {
    warnings.push('CLOUDAMQP_URL is not set in queues config.');
}

// The answer allowance counts against the same request limit as the prompt, so a task whose maxTokens alone exceeds that limit always fails. Caught at boot; otherwise it shows up as an unexplained 413 in production.
for (const task of ['chat', 'clean']) {
    const { provider, model, maxTokens } = inference[task];
    const budget = promptBudget(provider, model, { completionTokens: maxTokens });
    if (budget === null) continue;
    if (budget === 0) {
        errors.push(`${task}: max_completion_tokens ${maxTokens} is at or over what ${model} `
            + `accepts in one request (${maxRequestTokens(provider, model)}). Every call will 413.`);
    } else if (budget < 2000) {
        warnings.push(`${task}: max_completion_tokens ${maxTokens} leaves only ${budget} tokens `
            + `for the prompt on ${model}. Retrieved context alone is usually larger than that.`);
    }
}

if (auth.supabase.mode === 'jwks' && !auth.supabase.jwksUri) {
    warnings.push('AUTH_MODE is jwks but SUPABASE_JWKS_URI is not set. JWT auth will be misconfigured.');
}
if (auth.supabase.mode === 'hs256' && !auth.supabase.jwtSecret) {
    warnings.push('AUTH_MODE is hs256 but SUPABASE_JWT_SECRET is not set. JWT auth will be misconfigured.');
}

if (errors.length > 0) {
    errors.forEach(e => logger.error(e));
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
}

if (warnings.length > 0) {
    warnings.forEach(w => logger.warn(w));
}

logger.info('Inference routing configuration', {
    chat: `${inference.chat.provider} -> ${inference.chat.model}`,
    clean: `${inference.clean.provider} -> ${inference.clean.model}`,
    summary: `${inference.summary.provider} -> ${inference.summary.model}`,
    transcription: `${inference.transcription.provider} -> ${inference.transcription.model}`,
});

const config = Object.freeze({
    server,
    database,
    storage,
    auth,
    inference,
    queues,
    chunking,
    limits,
});

module.exports = config;
