// Placeholder provider keys, so the suite runs on a fresh clone.
//
// Nothing here calls a provider: these tests assert wiring, budgets and scoping. But constructing a
// client goes through key rotation, which throws when no key is configured at all, so 20 tests
// failed on any machine without a backend/.env — CI, and anyone who had just cloned the repo. It
// only ever looked green because whoever ran it happened to have credentials lying around.
//
// A real key already in the environment always wins, so this changes nothing locally. A test that
// genuinely reaches the network still fails, and fails visibly, rather than being masked.
const PLACEHOLDERS = {
    GROQ_API_KEYS: 'test-groq-key',
    CEREBRAS_API_KEYS: 'test-cerebras-key',
    GEMINI_API_KEYS: 'test-gemini-key',
    SARVAM_API_KEYS: 'test-sarvam-key',
    OPENROUTER_API_KEYS: 'test-openrouter-key',
};

for (const [name, value] of Object.entries(PLACEHOLDERS)) {
    const singular = name.replace(/_KEYS$/, '_KEY');
    if (!process.env[name] && !process.env[singular]) process.env[name] = value;
}
