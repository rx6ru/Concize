// middlewares/auth.js
//
// Bootstraps the auth middlewares from config + DB and exports ready-to-use instances.
// This is the single composition point that wires the injectable seams to real dependencies,
// keeping the middleware modules themselves pure and unit-testable.

const config = require('../configs/appConfig');
const { createTokenVerifier } = require('../utils/auth/tokenVerifier');
const { createAuthenticate } = require('./authenticate');
const { createRequireMeetingAccess } = require('./requireMeetingAccess');
const { getMeetingOwner } = require('../db/mongoutils/transcription.db');

// Verifier is lazy: with no JWKS URI it only throws if a Bearer token actually arrives,
// so legacy traffic keeps working before Supabase is provisioned.
const verifyAccessToken = createTokenVerifier(config.auth.supabase);

const authenticate = createAuthenticate({
    verifyAccessToken,
    legacy: config.auth.legacy,
});

const requireMeetingAccess = createRequireMeetingAccess({ getMeetingOwner });

// Same ownership gate for the legacy compat-shim routes, which carry the meeting id in the
// cookie or body rather than the path. Closes cross-tenant access on the legacy surface.
const requireLegacyMeetingAccess = createRequireMeetingAccess({
    getMeetingOwner,
    getMeetingId: (req) =>
        (req.cookies && req.cookies.jobId) || (req.body && req.body.jobId) || req.params.jobId,
});

module.exports = { authenticate, requireMeetingAccess, requireLegacyMeetingAccess };
