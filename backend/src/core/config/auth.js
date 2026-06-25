// Authentication configuration

const ALLOWED_AUTH_CODES = (process.env.ALLOWED_AUTH_CODES && process.env.ALLOWED_AUTH_CODES.trim() !== '')
    ? process.env.ALLOWED_AUTH_CODES.split(',').map(c => c.trim()).filter(c => c)
    : [];

const legacyEnabled = process.env.LEGACY_AUTH_ENABLED !== undefined
    ? process.env.LEGACY_AUTH_ENABLED === 'true'
    : process.env.NODE_ENV !== 'production';

const supabase = {
    mode: process.env.AUTH_MODE || 'jwks',
    jwksUri: process.env.SUPABASE_JWKS_URI,
    issuer: process.env.SUPABASE_JWT_ISSUER,
    audience: process.env.SUPABASE_JWT_AUD || 'authenticated',
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
};

const legacy = {
    enabled: legacyEnabled,
    codes: ALLOWED_AUTH_CODES,
    ownerId: process.env.LEGACY_OWNER_ID || 'legacy-owner',
};

module.exports = {
    ALLOWED_AUTH_CODES,
    supabase,
    legacy,
};
