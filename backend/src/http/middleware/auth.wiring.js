// Bootstraps the auth middlewares from config + DB and exports ready-to-use instances.
// This is the single composition point that wires the injectable seams to real dependencies,
// keeping the middleware modules themselves pure and unit-testable.

const config = require('../../core/config');
const { createTokenVerifier } = require('./token.verifier');
const { createAuthenticate } = require('./authenticate');
const { createRequireMeetingAccess } = require('./meeting.access');
const { getMeetingOwner } = require('../../meetings/meeting.repository');

// Verifier is lazy: with no JWKS URI it only throws once a Bearer token actually arrives.
const verifyAccessToken = createTokenVerifier(config.auth.supabase);

const authenticate = createAuthenticate({
    verifyAccessToken,
    legacy: config.auth.legacy,
});

const requireMeetingAccess = createRequireMeetingAccess({ getMeetingOwner });

module.exports = { authenticate, requireMeetingAccess };
