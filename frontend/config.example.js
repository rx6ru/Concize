// frontend/config.example.js
//
// TEMPLATE — copy this file to `config.js` and fill in your values:
//   cp config.example.js config.js
// `config.js` is gitignored so your project URL/keys are not committed.
//
// The anon key is a PUBLIC key (safe to ship in a client) — it only allows the operations
// your Supabase Row-Level Security / auth settings permit. Never ship the service_role key.

const CONCIZE_CONFIG = {
    // Your Supabase project, e.g. https://abcdefgh.supabase.co
    SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
    // Supabase anon/public key (Project Settings → API).
    SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',
    // Your Concize backend base URL (no trailing slash).
    BACKEND_URL: 'http://localhost:3000',
};

// Make it explicit on the global object for both page (window) and worker (self) contexts.
if (typeof self !== 'undefined') self.CONCIZE_CONFIG = CONCIZE_CONFIG;
