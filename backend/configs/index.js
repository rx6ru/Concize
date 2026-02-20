// configs/index.js
// Convergence point — all config modules merged into a single export
//
// Usage:
//   const config = require('../configs');
//   config.server.PORT
//   config.inference.chat.model
//   config.database.MONGODB_URL

require('dotenv').config();

const server = require('./server');
const database = require('./database');
const storage = require('./storage');
const auth = require('./auth');
const inference = require('./inference');
const queues = require('./queues');

// --- Startup Validation ---
const warnings = [];
const errors = [];

// Critical: Must have at least one set of LLM keys
if (inference.groqKeys.length === 0 && inference.cerebrasKeys.length === 0) {
    warnings.push('No Groq or Cerebras API keys configured. LLM features will not work.');
}

// Validate that keys exist for configured providers
const tasksUsingCerebras = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'cerebras');
const tasksUsingGroq = ['chat', 'clean', 'summary']
    .filter(task => inference[task].provider === 'groq');

if (tasksUsingCerebras.length > 0 && inference.cerebrasKeys.length === 0) {
    errors.push(
        `Tasks [${tasksUsingCerebras.join(', ')}] are configured to use Cerebras, ` +
        `but no CEREBRAS_API_KEYS are set.`
    );
}

// Groq is always needed for transcription, plus any tasks configured for it
if (inference.groqKeys.length === 0) {
    const groqTasks = [...tasksUsingGroq, 'transcription (Whisper)'];
    warnings.push(
        `No GROQ_API_KEYS set. Required for: [${groqTasks.join(', ')}].`
    );
}

if (inference.geminiKeys.length === 0) {
    warnings.push('No GEMINI_API_KEYS set. Embedding features will not work.');
}

if (!database.MONGODB_URL) {
    warnings.push('MONGODB_URL is not set.');
}

if (!storage.CLOUDAMQP_URL) {
    warnings.push('CLOUDAMQP_URL is not set.');
}

// Print validation results
if (errors.length > 0) {
    errors.forEach(e => console.error(`[CONFIG ERROR] ${e}`));
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
}

if (warnings.length > 0) {
    warnings.forEach(w => console.warn(`[CONFIG WARNING] ${w}`));
}

// Log active inference routing
console.log('[CONFIG] Inference routing:');
console.log(`  Chat:    ${inference.chat.provider} → ${inference.chat.model}`);
console.log(`  Clean:   ${inference.clean.provider} → ${inference.clean.model}`);
console.log(`  Summary: ${inference.summary.provider} → ${inference.summary.model}`);
console.log(`  Transcription: groq → whisper-large-v3 (fixed)`);

const config = Object.freeze({
    server,
    database,
    storage,
    auth,
    inference,
    queues,
});

module.exports = config;
