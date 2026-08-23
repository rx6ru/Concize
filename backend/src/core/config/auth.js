// Authentication configuration

// Named for Supabase because that is one way to run it, not the only one. With AUTH_MODE=hs256
// this deployment signs its own tokens and needs no external issuer at all.
const supabase = {
    mode: process.env.AUTH_MODE || 'jwks',
    jwksUri: process.env.SUPABASE_JWKS_URI,
    issuer: process.env.AUTH_JWT_ISSUER || process.env.SUPABASE_JWT_ISSUER,
    audience: process.env.SUPABASE_JWT_AUD || 'authenticated',
    jwtSecret: process.env.AUTH_JWT_SECRET || process.env.SUPABASE_JWT_SECRET,
};

module.exports = { supabase };
