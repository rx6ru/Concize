// utils/config.js
// BACKWARD COMPATIBILITY SHIM
// Provides flattened config for files that haven't migrated to the new configs/ system.
// New code should import from '../configs' directly.
//
// Usage (legacy):
//   const config = require('../utils/config');
//   config.PORT   → config.server.PORT (via configs/)
//
// Usage (new):
//   const config = require('../configs');
//   config.server.PORT

const config = require('../configs/appConfig');

// Flatten all domain configs for backward compatibility
module.exports = {
    // server
    ...config.server,
    // database
    ...config.database,
    // storage
    ...config.storage,
    // auth
    ...config.auth,
    // queues
    ...config.queues,
    // inference (legacy flat keys)
    GROQ_API_KEYS: config.inference.groqKeys,
    GEMINI_API_KEYS: config.inference.geminiKeys,
    GROQ_CHAT_MODEL: config.inference.chat.model,
};
