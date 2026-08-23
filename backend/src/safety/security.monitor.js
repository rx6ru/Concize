

/**
 * Security Monitor - Tracks violations and provides operational visibility
 */

const { getContext } = require('../core/request.context');

// In-memory violation tracking (could be replaced with Redis for production)
const violationStore = new Map();

const VIOLATION_THRESHOLD = 10; // Block after this many violations

// Callers (chat.controller.js) pass a meeting id as `identifier`. Keying on that alone means a
// meeting's owner and any shared reader of it share one counter, so one of them tripping it
// blocks the other from that meeting too.
// Keyed on the authenticated caller instead, read from the per-request context that
// authenticate.js stamps with the caller's user id. Global per user rather than per
// (user, meeting) pair: a user who racks up violations in one meeting is blocked everywhere for
// them, not just in that one meeting, and can't reset the count by moving to another meeting they
// can reach.
// Falls back to the raw identifier when there is no request context, e.g. a direct call with no
// authenticated caller.
function keyFor(identifier) {
    const userId = getContext()?.userId;
    return userId ? `violations:user:${userId}` : `violations:${identifier}`;
}

/**
 * Records a security violation for a given context
 * @param {string} identifier - User ID, Job ID, or IP address
 * @param {string} type - Type of violation (banned_keyword, off_topic, etc.)
 * @param {Object} details - Additional details for logging
 */
function recordViolation(identifier, type, details = {}) {
    const key = keyFor(identifier);
    const now = Date.now();

    if (!violationStore.has(key)) {
        violationStore.set(key, []);
    }

    const violations = violationStore.get(key);

    violations.push({
        type,
        timestamp: now,
        details
    });

    // Keep only last 24 hours of violations
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const recentViolations = violations.filter(v => v.timestamp > dayAgo);
    violationStore.set(key, recentViolations);

    console.warn(`SECURITY_VIOLATION: [${identifier}] Type: ${type}`, {
        count: recentViolations.length,
        ...details
    });

    return recentViolations.length;
}

/**
 * Checks if an identifier should be blocked due to too many violations
 * @param {string} identifier 
 * @returns {Object} { blocked: boolean, violationCount: number }
 */
function checkBlocked(identifier) {
    const key = keyFor(identifier);
    const violations = violationStore.get(key) || [];

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const recentViolations = violations.filter(v => v.timestamp > dayAgo);

    return {
        blocked: recentViolations.length >= VIOLATION_THRESHOLD,
        violationCount: recentViolations.length
    };
}

/**
 * Clears violations for an identifier (for testing or admin actions)
 */
function clearViolations(identifier) {
    const key = keyFor(identifier);
    violationStore.delete(key);
}

function getViolationSummary() {
    const summary = {};
    for (const [key, violations] of violationStore.entries()) {
        const id = key.replace('violations:', '');
        summary[id] = violations.length;
    }
    return summary;
}

module.exports = {
    recordViolation,
    checkBlocked,
    clearViolations,
    getViolationSummary,
    VIOLATION_THRESHOLD
};
