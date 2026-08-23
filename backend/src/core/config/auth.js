// Authentication configuration

const supabase = {
    mode: process.env.AUTH_MODE || 'jwks',
    jwksUri: process.env.SUPABASE_JWKS_URI,
    issuer: process.env.SUPABASE_JWT_ISSUER,
    audience: process.env.SUPABASE_JWT_AUD || 'authenticated',
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
};

module.exports = { supabase };
