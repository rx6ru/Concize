// frontend/config.example.js
//
// TEMPLATE — copy this file to `config.js` and fill in your values:
//   cp config.example.js config.js
// `config.js` is gitignored so your project URL/keys are not committed.
//
// SUPABASE_PUBLISHABLE_KEY is the new-format public client key (sb_publishable_...) — safe to
// ship in a client. It replaces the legacy anon key. NEVER put the secret key (sb_secret_...) here.

const CONCIZE_CONFIG = {
    // Your Supabase project URL, e.g. https://abcdefgh.supabase.co
    SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
    // Supabase publishable key (Project Settings → API keys → publishable). Format: sb_publishable_...
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_YOUR_KEY',
    // Your Concize backend base URL (no trailing slash).
    BACKEND_URL: 'http://localhost:3000',
};

// Make it explicit on the global object for both page (window) and worker (self) contexts.
if (typeof self !== 'undefined') self.CONCIZE_CONFIG = CONCIZE_CONFIG;
