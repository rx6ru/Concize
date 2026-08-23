// Violation counters are keyed by the authenticated caller (the per-request context that
// authenticate.js stamps with the caller's user id), not by whatever identifier a caller passes
// in. Sharing a meeting must not let one principal's violations block another's access to it.

const { runWithContext } = require('../src/core/request.context');
const securityMonitor = require('../src/safety/security.monitor');

function asUser(userId, fn) {
    return runWithContext({ userId }, fn);
}

describe('security.monitor keying', () => {
    it("a shared reader's violations do not block the owner in the same meeting", () => {
        const meetingId = 'meeting-shared-1';

        asUser('reader-1', () => {
            for (let i = 0; i < 10; i++) securityMonitor.recordViolation(meetingId, 'off_topic', {});
        });
        expect(asUser('reader-1', () => securityMonitor.checkBlocked(meetingId)).blocked).toBe(true);

        const ownerStatus = asUser('owner-1', () => securityMonitor.checkBlocked(meetingId));
        expect(ownerStatus.blocked).toBe(false);
        expect(ownerStatus.violationCount).toBe(0);
    });

    it('the owner is still blocked by their own violations', () => {
        const meetingId = 'meeting-shared-2';

        asUser('owner-2', () => {
            for (let i = 0; i < 10; i++) securityMonitor.recordViolation(meetingId, 'off_topic', {});
        });

        expect(asUser('owner-2', () => securityMonitor.checkBlocked(meetingId)).blocked).toBe(true);
    });

    it('a violation count follows the user across meetings, not the meeting', () => {
        asUser('bad-actor-1', () => {
            for (let i = 0; i < 5; i++) securityMonitor.recordViolation('meeting-a', 'off_topic', {});
            for (let i = 0; i < 5; i++) securityMonitor.recordViolation('meeting-b', 'off_topic', {});
        });

        // Never touched meeting-c, but the same user's ten violations elsewhere still block them.
        expect(asUser('bad-actor-1', () => securityMonitor.checkBlocked('meeting-c')).blocked).toBe(true);
    });

    it('falls back to the raw identifier when there is no request context', () => {
        securityMonitor.clearViolations('no-context-id');
        for (let i = 0; i < 10; i++) securityMonitor.recordViolation('no-context-id', 'off_topic', {});
        expect(securityMonitor.checkBlocked('no-context-id').blocked).toBe(true);
    });
});
