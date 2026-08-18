// Live meeting session. Owns the clock, sends audio to each lane, collects their events.
// Clock comes from frame sequence numbers rather than arrival time, so all lanes agree on timestamps even with network jitter.

'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('session');

const LANE_STATES = { UP: 'up', DEGRADED: 'degraded', DOWN: 'down' };

function createSession({
    meetingId,
    ownerId,
    sampleRate = 16000,
    frameMs = 100,
    // Where this session's clock starts. Non-zero when resuming a meeting whose transcript already reaches this far: the client's sequence restarts at 0 on reconnect, so without the offset a resumed session rewrites the timeline instead of continuing it.
    startOffsetMs = 0,
    onEvent,
    onFrame = null,          // every audio frame, used to spool the recording
    onLaneStatus = () => {},
}) {
    if (!meetingId) throw new Error('meetingId is required');
    if (!ownerId) throw new Error('ownerId is required');
    if (typeof onEvent !== 'function') throw new Error('onEvent is required');

    const lanes = new Map();
    const state = {
        closed: false,
        framesReceived: 0,
        lastSeq: -1,
        gaps: 0,
        watermarkMs: 0,
    };

    const laneStatus = (name, next, reason) => {
        const entry = lanes.get(name);
        if (!entry || entry.status === next) return;
        entry.status = next;
        logger.warn('Lane status change', { meetingId, lane: name, status: next, reason });
        onLaneStatus({ lane: name, status: next, reason });
    };

    return {
        meetingId,
        ownerId,

        // a lane is anything with sendAudio/flush/close/health, could be a remote provider or a local service.
        registerLane(name, lane) {
            if (state.closed) throw new Error('Session is closed');
            lanes.set(name, { lane, status: LANE_STATES.UP });
            return this;
        },

        // lane events arrive already normalised; session just stamps provenance and advances the watermark, never reshapes the payload.
        handleLaneEvent(name, event) {
            if (state.closed) return;
            const entry = lanes.get(name);
            if (entry && entry.status !== LANE_STATES.UP) laneStatus(name, LANE_STATES.UP, 'event received');

            if (event.kind === 'final' && typeof event.t1Ms === 'number') {
                state.watermarkMs = Math.max(state.watermarkMs, event.t1Ms);
            }
            onEvent({ ...event, meetingId, ownerId });
        },

        handleLaneError(name, err, { fatal = false } = {}) {
            laneStatus(name, fatal ? LANE_STATES.DOWN : LANE_STATES.DEGRADED, err.message);
        },

        /**
         * Stamp a frame with session time and fan it to every lane. Returns the session-relative start time of this frame.
         * A lane that throws gets marked degraded instead of stopping the others, since words outrank speakers outrank overlap.
         */
        pushAudio(frame, seq) {
            if (state.closed) return null;

            if (state.lastSeq >= 0 && seq > state.lastSeq + 1) {
                state.gaps += seq - state.lastSeq - 1;
                logger.warn('Audio sequence gap', { meetingId, from: state.lastSeq, to: seq });
            }
            state.lastSeq = Math.max(state.lastSeq, seq);
            state.framesReceived += 1;

            const t0Ms = startOffsetMs + seq * frameMs;
            if (onFrame) {
                try { onFrame(frame); } catch { /* recording is best effort */ }
            }

            for (const [name, entry] of lanes) {
                if (entry.status === LANE_STATES.DOWN) continue;
                try {
                    entry.lane.sendAudio(frame);
                } catch (err) {
                    laneStatus(name, LANE_STATES.DEGRADED, err.message);
                }
            }
            return t0Ms;
        },

        // how far behind live the indexed transcript is; feeds the staleness indicator.
        // a value that keeps growing is the first sign ingestion is falling behind.
        freshness() {
            const elapsedMs = startOffsetMs + (state.lastSeq + 1) * frameMs;
            return {
                watermarkMs: state.watermarkMs,
                elapsedMs,
                lagMs: Math.max(0, elapsedMs - state.watermarkMs),
            };
        },

        health() {
            return {
                meetingId,
                closed: state.closed,
                framesReceived: state.framesReceived,
                gaps: state.gaps,
                sampleRate,
                lanes: Object.fromEntries(
                    [...lanes].map(([name, e]) => [name, { status: e.status, ...e.lane.health?.() }])
                ),
                ...this.freshness(),
            };
        },

        async close() {
            if (state.closed) return;
            state.closed = true;
            for (const [name, entry] of lanes) {
                try {
                    entry.lane.flush?.();
                    entry.lane.close?.();
                } catch (err) {
                    logger.warn('Lane close failed', { meetingId, lane: name, error: err.message });
                }
            }
            logger.info('Session closed', {
                meetingId, framesReceived: state.framesReceived, gaps: state.gaps,
            });
        },
    };
}

module.exports = { createSession, LANE_STATES };
