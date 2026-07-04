// Speaker lane, talks to the local FunASR diarization service.
//
// PROTOCOL (this file is the contract; the Python service implements it)
//
//   connect   ws://<host>/speaker?session=<id>&sample_rate=16000
//   client →  binary frames: raw little-endian 16-bit mono PCM
//   client →  {"event":"flush"} | {"event":"end"} | {"event":"ping"}
//   server →  {"event":"ready"}
//             {"event":"speaker","t0_ms":0,"t1_ms":1500,"speaker":"0","confidence":"confident"}
//             {"event":"error","message":"...","fatal":true}
//
// Speaker intervals are advisory: fusion joins them to words by timestamp and emits text
// either way. A dead speaker service costs attribution, not transcription, so this lane
// reconnects quietly in the background instead of failing loud.

'use strict';

const WebSocket = require('ws');
const { createLogger } = require('../../core/logger');

const logger = createLogger('speakerLane');

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10000;

// Audio that arrives before the socket first opens is held, not dropped. Measured: losing the
// first 300ms of a meeting took the tracker from 15 speaker centres to 1 and put every segment
// on the same id, because its internal chunking is aligned to the start of the stream.
// 10 seconds is far more than a connect takes, and bounds the memory if the service is down.
const PRECONNECT_MAX_FRAMES = 100;

function normalise(msg) {
    if (msg.event !== 'speaker') return null;
    return {
        lane: 'speaker',
        kind: 'interval',
        t0Ms: msg.t0_ms,
        t1Ms: msg.t1_ms,
        // The service returns bare integers. They get an S prefix here because a line reading
        // "#t2 0:17 8: ..." in the chat context is unreadable, the model takes 8 for part of
        // the timestamp and reports the transcript as unattributed.
        speakerLabel: msg.speaker == null ? null : `S${msg.speaker}`,
        confidence: msg.confidence || 'unknown',
        raw: msg,
    };
}

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.endpoint]      defaults to SPEAKER_SERVICE_URL or localhost
 * @param {number} [opts.sampleRate]
 * @param {function} opts.onEvent
 * @param {function} [opts.onError]
 * @param {function} [opts.onClose]
 * @param {boolean} [opts.reconnect]    disable in tests that assert a single connection
 * @param {function} [opts.wsFactory]
 */
function createFunasrSpeakerLane(opts) {
    const {
        sessionId,
        endpoint = process.env.SPEAKER_SERVICE_URL || 'ws://127.0.0.1:8765/speaker',
        sampleRate = 16000,
        onEvent,
        onError = () => {},
        onClose = () => {},
        reconnect = true,
        wsFactory = (url) => new WebSocket(url),
    } = opts;

    if (typeof onEvent !== 'function') throw new Error('onEvent is required');

    const url = `${endpoint}?session=${encodeURIComponent(sessionId)}&sample_rate=${sampleRate}`;
    const state = {
        closed: false,
        ready: false,
        connectedOnce: false,
        attempts: 0,
        framesSent: 0,
        framesDropped: 0,
        framesBuffered: 0,
        intervals: 0,
        lastEventAt: null,
    };

    let preconnect = [];

    let ws = null;
    let timer = null;

    function connect() {
        if (state.closed) return;
        ws = wsFactory(url);

        ws.on('open', () => {
            state.ready = true;
            state.attempts = 0;

            if (!state.connectedOnce) {
                state.connectedOnce = true;
                for (const frame of preconnect) {
                    ws.send(frame);
                    state.framesSent += 1;
                }
                if (preconnect.length) {
                    logger.info('Flushed audio held during connect',
                        { sessionId, frames: preconnect.length });
                }
                preconnect = [];
            }
            logger.info('Speaker service connected', { sessionId });
        });

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return;
            }
            state.lastEventAt = Date.now();

            if (msg.event === 'error') {
                onError(new Error(msg.message || 'speaker service error'), { fatal: !!msg.fatal });
                return;
            }
            const event = normalise(msg);
            if (event) {
                state.intervals += 1;
                onEvent(event);
            }
        });

        ws.on('error', (err) => {
            state.ready = false;
            onError(err, { fatal: false });
        });

        ws.on('close', (code, reason) => {
            state.ready = false;
            if (state.closed) return onClose({ code, reason: reason?.toString() || '' });
            if (!reconnect) return onClose({ code, reason: reason?.toString() || '' });

            // audio sent while disconnected gets dropped, not queued: buffering it would replay
            // stale audio into a fresh session and corrupt the timeline fusion depends on.
            // losing attribution for those seconds is the cheaper failure.
            const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** state.attempts);
            state.attempts += 1;
            logger.warn('Speaker service dropped, reconnecting', { sessionId, delay, code });
            timer = setTimeout(connect, delay);
        });
    }

    connect();

    return {
        sendAudio(pcmFrame) {
            if (state.closed) return false;

            // Before the first connect, hold the audio. After it, drop: on a reconnect the
            // service has a fresh session and replaying old audio would corrupt its timeline.
            if (!state.connectedOnce) {
                if (preconnect.length >= PRECONNECT_MAX_FRAMES) {
                    state.framesDropped += 1;
                    return false;
                }
                preconnect.push(pcmFrame);
                state.framesBuffered += 1;
                return true;
            }

            if (!state.ready || ws.readyState !== WebSocket.OPEN) {
                state.framesDropped += 1;
                return false;
            }
            ws.send(pcmFrame);
            state.framesSent += 1;
            return true;
        },

        flush() {
            if (!state.closed && state.ready) ws.send(JSON.stringify({ event: 'flush' }));
        },

        close() {
            if (state.closed) return;
            state.closed = true;
            if (timer) clearTimeout(timer);
            try {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ event: 'end' }));
                    ws.close();
                }
            } catch { /* already gone */ }
        },

        health() {
            return {
                lane: 'speaker',
                open: state.ready && !state.closed,
                framesSent: state.framesSent,
                framesDropped: state.framesDropped,
                framesBuffered: state.framesBuffered,
                intervals: state.intervals,
                reconnects: state.attempts,
                lastEventAt: state.lastEventAt,
            };
        },
    };
}

module.exports = { createFunasrSpeakerLane, normalise };
