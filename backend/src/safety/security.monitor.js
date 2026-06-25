

/**
 * Security Monitor - Tracks violations and provides operational visibility
 */

// In-memory violation tracking (could be replaced with Redis for production)
const violationStore = new Map();

const VIOLATION_THRESHOLD = 10; // Block after this many violations

/**
 * Records a security violation for a given context
 * @param {string} identifier - User ID, Job ID, or IP address
 * @param {string} type - Type of violation (banned_keyword, off_topic, etc.)
 * @param {Object} details - Additional details for logging
 */
function recordViolation(identifier, type, details = {}) {
    const key = `violations:${identifier}`;
    const now = Date.now();

    if (!violationStore.has(key)) {
        violationStore.set(key, []);
    }

    const violations = violationStore.get(key);

    // Add new violation
    violations.push({
        type,
        timestamp: now,
        details
    });

    // Keep only last 24 hours of violations
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const recentViolations = violations.filter(v => v.timestamp > dayAgo);
    violationStore.set(key, recentViolations);

    // Log structured violation
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
    const key = `violations:${identifier}`;
    const violations = violationStore.get(key) || [];

    // Filter to recent violations only
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
    const key = `violations:${identifier}`;
    violationStore.delete(key);
}

/**
 * Gets violation summary for monitoring
 */
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
