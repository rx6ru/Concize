// Bootstraps the auth middlewares from config + DB and exports ready-to-use instances.
// This is the single composition point that wires the injectable seams to real dependencies,
// keeping the middleware modules themselves pure and unit-testable.

const config = require('../../core/config');
const { createTokenVerifier } = require('./token.verifier');
const { createAuthenticate } = require('./authenticate');
const { createRequireMeetingAccess, requireMeetingOwner } = require('./meeting.access');
const { getMeetingOwner } = require('../../meetings/meeting.repository');
const { isSharedWith } = require('../../meetings/meeting.share.repository');

// Verifier is lazy: with no JWKS URI it only throws once a Bearer token actually arrives.
const verifyAccessToken = createTokenVerifier(config.auth.supabase);

const authenticate = createAuthenticate({
    verifyAccessToken,
});

const requireMeetingAccess = createRequireMeetingAccess({ getMeetingOwner, hasSharedAccess: isSharedWith });

module.exports = { authenticate, requireMeetingAccess, requireMeetingOwner };
