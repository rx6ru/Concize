// Sign up and sign in, for deployments that issue their own tokens.
//
// Mounted ahead of the authenticate middleware in server.js, for the same reason /health is:
// a caller asking for a token cannot be expected to already hold one.

const express = require('express');
const router = express.Router();

const config = require('../../../core/config');
const { hashPassword, verifyPassword, MIN_LENGTH, DUMMY_HASH } = require('../../../auth/password');
const { createTokenIssuer } = require('../../../auth/token.issuer');
const { createUser, findUserByEmail } = require('../../../auth/user.repository');
const { createLogger } = require('../../../core/logger');
const { createRateLimiter } = require('../../middleware/rate.limit');

const logger = createLogger('authRoutes');

// Both routes run ahead of authenticate() (see the comment at the top of this file), so there is
// no req.user yet to key on; keyed by IP instead.
// Login: blunts scripted credential stuffing while tolerating a person mistyping their password a
// few times. 10 attempts per 15 minutes is tight enough that a guessing script gets nowhere
// against an 8+ character scrypt-hashed password before hitting the wall.
const loginRateLimit = createRateLimiter({
    name: 'auth-login',
    max: Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX) || 10,
    windowMs: Number(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    getUserId: (req) => req.ip,
});
// Signup: a person signs up once, so 5 per hour mirrors meetingCreateRateLimit's reasoning for a
// rarely-repeated action, while still blocking bulk account creation (a way to route around the
// per-user caps on /meetings and /chat).
const signupRateLimit = createRateLimiter({
    name: 'auth-signup',
    max: Number(process.env.AUTH_SIGNUP_RATE_LIMIT_MAX) || 5,
    windowMs: Number(process.env.AUTH_SIGNUP_RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
    getUserId: (req) => req.ip,
});

let issue = null;
function issuer() {
    if (!issue) {
        const { jwtSecret, issuer: iss, audience } = config.auth.supabase;
        issue = createTokenIssuer({ secret: jwtSecret, issuer: iss, audience });
    }
    return issue;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function credentials(req, res) {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!EMAIL.test(email)) {
        res.status(400).json({ error: 'A valid email is required.' });
        return null;
    }
    if (password.length < MIN_LENGTH) {
        res.status(400).json({ error: `Password must be at least ${MIN_LENGTH} characters.` });
        return null;
    }
    return { email, password };
}

router.post('/signup', signupRateLimit, async (req, res) => {
    const creds = credentials(req, res);
    if (!creds) return undefined;

    try {
        if (await findUserByEmail(creds.email)) {
            return res.status(409).json({ error: 'That email is already registered.' });
        }
        const user = await createUser(creds.email, await hashPassword(creds.password));
        const { token } = await issuer()(user);
        logger.info('Account created', { userId: user.id });
        return res.status(201).json({ success: true, token, user: { id: user.id, email: user.email } });
    } catch (error) {
        logger.error('Signup failed', { error: error.message });
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

router.post('/login', loginRateLimit, async (req, res) => {
    const creds = credentials(req, res);
    if (!creds) return undefined;

    try {
        const user = await findUserByEmail(creds.email);
        // One message for both a missing account and a wrong password: saying which tells an
        // attacker whose email is registered here.
        // verifyPassword always runs, against a dummy hash when there is no user, so a missing
        // account doesn't also return faster than a wrong password -- that would leak the same
        // thing through response time instead of the response body.
        const passwordOk = await verifyPassword(creds.password, user ? user.passwordHash : DUMMY_HASH);
        if (!user || !passwordOk) return res.status(401).json({ error: 'Incorrect email or password.' });

        const { token } = await issuer()(user);
        return res.status(200).json({ success: true, token, user: { id: user.id, email: user.email } });
    } catch (error) {
        logger.error('Login failed', { error: error.message });
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

/** Test seam. */
function _resetForTests() { issue = null; }

module.exports = router;
module.exports._resetForTests = _resetForTests;
