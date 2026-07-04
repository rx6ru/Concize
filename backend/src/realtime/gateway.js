// WebSocket gateway for live meetings.
// Auth happens on the HTTP upgrade, before the socket exists, so bad or non-owning clients
// never get a WebSocket. Ownership mismatch returns 404, not 403, so we don't confirm to a
// stranger that the meeting exists.

'use strict';

const { WebSocketServer } = require('ws');
const { createLogger } = require('../core/logger');
const { createSession } = require('./session');
const { createFusion } = require('./fusion');

const logger = createLogger('gateway');

const CLOSE = {
    UNAUTHORIZED: 4401,
    NOT_FOUND: 4404,
    BAD_REQUEST: 4400,
    SERVER_ERROR: 4500,
};

function parseUpgrade(req) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/rt') return null;

    // browsers can't set headers on a WS handshake, so the token rides the query string.
    // it's single-use and short-lived; meeting id gets validated separately.
    return {
        token: url.searchParams.get('token'),
        meetingId: url.searchParams.get('meetingId'),
    };
}

function reject(socket, status, message) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

/**
 * @param {object} deps
 * @param {import('http').Server} deps.server
 * @param {(token: string) => Promise<object>} deps.verifyAccessToken
 * @param {(meetingId: string) => Promise<string|null>} deps.getMeetingOwner
 * @param {function} deps.createLane      builds the words lane for a session
 * @param {function} [deps.onUtterance]   called with each finalised utterance
 * @param {function} [deps.onSessionEnd]  called once per session after its lanes are closed
 */
function attachGateway({
    server, verifyAccessToken, getMeetingOwner, createLane,
    createSpeakerLane = null,
    onUtterance = () => {}, onRevision = () => {}, onSessionEnd = () => {},
}) {
    const wss = new WebSocketServer({ noServer: true });
    const sessions = new Map();

    server.on('upgrade', async (req, socket, head) => {
        const params = parseUpgrade(req);
        if (!params) return reject(socket, 404, 'Not Found');
        if (!params.meetingId) return reject(socket, 400, 'Bad Request');

        let claims;
        try {
            claims = await verifyAccessToken(params.token);
        } catch (err) {
            logger.warn('WS upgrade rejected', { reason: err.message });
            return reject(socket, 401, 'Unauthorized');
        }

        const userId = claims.sub;
        const owner = await getMeetingOwner(params.meetingId);
        if (!owner || owner !== userId) {
            logger.warn('WS upgrade denied', { meetingId: params.meetingId, userId });
            return reject(socket, 404, 'Not Found');
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            attachSession(ws, params.meetingId, userId);
        });
    });

    function attachSession(ws, meetingId, ownerId) {
        const send = (payload) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
        };

        const fusion = createFusion();

        const emit = (type, u) => send({
            type,
            turnId: u.turnId,
            text: u.text,
            t0: u.t0Ms,
            t1: u.t1Ms,
            speaker: u.speakerLabel ?? null,
            confidence: u.speakerConfidence ?? 'unknown',
            overlap: u.overlap ?? false,
            overlapRatio: u.overlapRatio ?? 0,
        });

        const persist = (fn, ...args) => Promise.resolve(fn(...args)).catch((err) =>
            logger.error('Persist failed', { meetingId, error: err.message })
        );

        // late speaker or overlap data can re-attribute turns already on screen, so we send
        // a revision instead of holding the text back until attribution is known.
        const flushRevisions = () => {
            for (const revised of fusion.revise()) {
                emit('revision', revised);
                persist(onRevision, meetingId, revised);
            }
        };

        const session = createSession({
            meetingId,
            ownerId,
            onEvent: (event) => {
                if (event.lane === 'speaker') {
                    fusion.addSpeakerInterval(event);
                    return flushRevisions();
                }
                if (event.lane === 'overlap') {
                    fusion.addOverlapInterval(event);
                    return flushRevisions();
                }

                // partials are volatile and never attributed, just there to make the
                // overlay feel live until the final replaces them.
                if (event.kind === 'partial') {
                    return emit('partial', { ...event, speakerLabel: null });
                }

                const utterance = fusion.fuse(event);
                emit('final', utterance);
                send({ type: 'watermark', ...session.freshness() });
                persist(onUtterance, meetingId, utterance);
            },
            onLaneStatus: (status) => send({ type: 'lane.status', ...status }),
        });

        try {
            session.registerLane('words', createLane({
                sessionId: meetingId,
                onEvent: (e) => session.handleLaneEvent('words', e),
                onError: (err, meta) => session.handleLaneError('words', err, meta),
            }));
        } catch (err) {
            logger.error('Lane setup failed', { meetingId, error: err.message });
            send({ type: 'error', code: 'lane_unavailable', fatal: true });
            return ws.close(CLOSE.SERVER_ERROR, 'lane unavailable');
        }

        // speaker lane is optional: if the service is missing or fails to start, the
        // meeting just runs unattributed.
        if (createSpeakerLane) {
            try {
                session.registerLane('speaker', createSpeakerLane({
                    sessionId: meetingId,
                    onEvent: (e) => session.handleLaneEvent('speaker', e),
                    onError: (err, meta) => session.handleLaneError('speaker', err, meta),
                }));
            } catch (err) {
                logger.warn('Speaker lane unavailable, continuing without attribution',
                    { meetingId, error: err.message });
                send({ type: 'lane.status', lane: 'speaker', status: 'down', reason: err.message });
            }
        }

        // a meeting can end by the client closing, a stop message, or shutdown, all three land
        // here and the hook only runs once. the last chunk is still open at this point and
        // would otherwise never get stored.
        let ended = false;
        const endSession = async () => {
            if (ended) return;
            ended = true;
            await session.close();
            try {
                await onSessionEnd(meetingId);
            } catch (err) {
                logger.error('Session end hook failed', { meetingId, error: err.message });
            }
        };

        sessions.set(ws, endSession);
        send({ type: 'session.ready', meetingId });
        logger.info('Session started', { meetingId, ownerId });

        ws.on('message', (raw, isBinary) => {
            // Audio arrives as binary frames; JSON is reserved for control messages.
            if (isBinary) {
                const seq = readSeq(raw);
                if (seq === null) return;
                session.pushAudio(raw.subarray(4), seq);
                return;
            }
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return send({ type: 'error', code: 'bad_message', fatal: false });
            }
            if (msg.event === 'stop') endSession();
        });

        ws.on('close', () => {
            sessions.delete(ws);
            endSession();
        });

        ws.on('error', (err) => logger.warn('Socket error', { meetingId, error: err.message }));
    }

    // every audio frame is prefixed with a uint32 sequence number, so the session clock
    // survives reordering and can detect loss.
    function readSeq(buf) {
        if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
        return buf.readUInt32BE(0);
    }

    return {
        wss,
        sessionCount: () => sessions.size,
        async closeAll() {
            for (const endSession of sessions.values()) await endSession();
            sessions.clear();
            wss.close();
        },
    };
}

module.exports = { attachGateway, CLOSE };
