// Convergence point — all config modules merged into a single export
//
// Usage:
//   const config = require('../configs');
//   config.server.PORT
//   config.inference.chat.model
//   config.database.MONGODB_URL

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
const chunking = require('./chunking');

// --- Startup Validation ---
const warnings = [];
const errors = [];

// Critical: Must have at least one set of LLM keys
if (inference.groqKeys.length === 0 && inference.cerebrasKeys.length === 0) {
    warnings.push('No Groq or Cerebras API keys configured. LLM features will fail at runtime.');
}

// Validate that keys exist for configured providers
const tasksUsingCerebras = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'cerebras');
const tasksUsingGroq = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'groq');

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

// Sarvam keys needed if transcription provider is sarvam
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

// Auth validation
if (auth.supabase.mode === 'jwks' && !auth.supabase.jwksUri) {
    warnings.push('AUTH_MODE is jwks but SUPABASE_JWKS_URI is not set. JWT auth will be misconfigured.');
}
if (auth.supabase.mode === 'hs256' && !auth.supabase.jwtSecret) {
    warnings.push('AUTH_MODE is hs256 but SUPABASE_JWT_SECRET is not set. JWT auth will be misconfigured.');
}
if (auth.legacy.enabled) {
    logger.info('Legacy x-auth-code auth is ENABLED. This is a security caveat — disable in production via LEGACY_AUTH_ENABLED=false.');
}

// Print validation results
if (errors.length > 0) {
    errors.forEach(e => logger.error(e));
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
}

if (warnings.length > 0) {
    warnings.forEach(w => logger.warn(w));
}

// Log active inference routing
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
});

module.exports = config;
