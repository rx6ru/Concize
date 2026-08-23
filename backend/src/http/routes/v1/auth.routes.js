// Sign up and sign in, for deployments that issue their own tokens.
//
// Mounted ahead of the authenticate middleware in server.js, for the same reason /health is:
// a caller asking for a token cannot be expected to already hold one.

const express = require('express');
const router = express.Router();

const config = require('../../../core/config');
const { hashPassword, verifyPassword, MIN_LENGTH } = require('../../../auth/password');
const { createTokenIssuer } = require('../../../auth/token.issuer');
const { createUser, findUserByEmail } = require('../../../auth/user.repository');
const { createLogger } = require('../../../core/logger');

const logger = createLogger('authRoutes');

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

router.post('/signup', async (req, res) => {
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

router.post('/login', async (req, res) => {
    const creds = credentials(req, res);
    if (!creds) return undefined;

    try {
        const user = await findUserByEmail(creds.email);
        // One message for both a missing account and a wrong password: saying which tells an
        // attacker whose email is registered here.
        const ok = user && await verifyPassword(creds.password, user.passwordHash);
        if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });

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
