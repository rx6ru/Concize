// Streaming ASR lane over Sarvam's realtime WebSocket.
// Only saaras:v3-realtime is accepted and it never returns a speaker field, so speaker labels come from a separate lane (confirmed against the live API on 2026-08-06).
// Server echoes the config it actually applied in session.begin, since bad query params just get dropped, no error thrown.

'use strict';

const WebSocket = require('ws');
const config = require('../../core/config');
const { createLogger } = require('../../core/logger');

const logger = createLogger('sarvamRealtime');

const ENDPOINT = 'wss://api.sarvam.ai/speech-to-text-realtime/ws';
const MODEL = 'saaras:v3-realtime';

// same shape for every lane, so fusion never has to learn a provider's own format.
function normalise(msg, offsetMs) {
    const toMs = (s) => (typeof s === 'number' ? Math.round(s * 1000) + offsetMs : null);

    if (msg.event === 'transcript.partial' || msg.event === 'transcript.final') {
        return {
            lane: 'words',
            kind: msg.event === 'transcript.final' ? 'final' : 'partial',
            t0Ms: toMs(msg.start_s),
            t1Ms: toMs(msg.end_s),
            text: msg.text ?? '',
            confidence: msg.confidence ?? null,
            turnId: msg.utterance_idx ?? null,
            raw: msg,
        };
    }
    return null;
}

/**
 * Opens a Sarvam realtime session.
 * @param {number} [opts.sampleRate]        8000 or 16000
 * @param {string} [opts.languageCode]      'auto' or e.g. 'hi-IN'
 * @param {string} [opts.streamType]        fast | balanced | simulated
 * @param {number} [opts.silenceDurationMs] dominates time-to-final
 * @param {number} [opts.offsetMs]          added to provider timestamps to reach session time
 * @param {function} opts.onEvent           normalised lane events
 * @param {function} [opts.wsFactory]       injectable for tests
 */
function createSarvamRealtimeLane(opts) {
    const {
        sessionId,
        sampleRate = 16000,
        languageCode = 'auto',
        streamType = 'balanced',
        mode = 'transcribe',
        silenceDurationMs,
        offsetMs = 0,
        onEvent,
        onError = () => {},
        onClose = () => {},
        wsFactory,
    } = opts;

    if (typeof onEvent !== 'function') throw new Error('onEvent is required');

    const apiKey = (config.inference.sarvamKeys || [])[0];
    if (!apiKey) throw new Error('No Sarvam API key configured');

    const params = new URLSearchParams({
        model: MODEL,
        language_code: languageCode,
        stream_type: streamType,
        mode,
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        return_timestamps: 'true',
    });
    if (silenceDurationMs != null) params.set('silence_duration_ms', String(silenceDurationMs));

    const open = wsFactory || ((url, o) => new WebSocket(url, o));
    const ws = open(`${ENDPOINT}?${params}`, { headers: { 'api-subscription-key': apiKey } });

    let ready = false;
    let closed = false;
    let endRequested = false;   // true once close() was called, so an unexpected drop can be told apart from a normal end
    const pending = [];
    const state = { framesSent: 0, finals: 0, lastEventAt: null, appliedConfig: null };

    const send = (payload) => {
        const data = JSON.stringify(payload);
        if (ready && ws.readyState === WebSocket.OPEN) ws.send(data);
        else pending.push(data);
    };

    ws.on('open', () => {
        ready = true;
        while (pending.length && ws.readyState === WebSocket.OPEN) ws.send(pending.shift());
    });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            logger.warn('Non-JSON frame from Sarvam', { sessionId });
            return;
        }
        state.lastEventAt = Date.now();

        if (msg.event === 'session.begin') {
            state.appliedConfig = msg.config || null;
            logger.info('Sarvam realtime session open', { sessionId, requestId: msg.request_id });
            return;
        }
        if (msg.event === 'error') {
            onError(new Error(msg.message || 'Sarvam realtime error'), { fatal: msg.is_fatal !== false, raw: msg });
            return;
        }

        const event = normalise(msg, offsetMs);
        if (event) {
            if (event.kind === 'final') state.finals += 1;
            onEvent(event);
        }
    });

    ws.on('error', (err) => onError(err, { fatal: false }));

    ws.on('close', (code, reason) => {
        closed = true;
        // this lane never reconnects (unlike speaker), so a drop nobody asked for ends live transcription
        // for the rest of the meeting; that needs to be loud, not an info line indistinguishable from a normal end.
        const unexpected = !endRequested;
        logger[unexpected ? 'warn' : 'info'](
            unexpected ? 'Sarvam realtime session dropped unexpectedly, no reconnect' : 'Sarvam realtime session closed',
            { sessionId, code, framesSent: state.framesSent, finals: state.finals },
        );
        onClose({ code, reason: reason?.toString() || '', unexpected });
    });

    return {
        // pcmFrame: raw little-endian 16-bit mono at sampleRate
        sendAudio(pcmFrame) {
            if (closed) return false;
            send({ event: 'audio_input', audio: Buffer.from(pcmFrame).toString('base64') });
            state.framesSent += 1;
            return true;
        },

        // force-finalise buffered audio without waiting for the VAD silence window
        flush() {
            if (!closed) send({ event: 'flush' });
        },

        keepalive() {
            if (!closed) send({ event: 'ping' });
        },

        close() {
            if (closed) return;
            endRequested = true;
            send({ event: 'end' });
            setTimeout(() => ws.readyState === WebSocket.OPEN && ws.close(), 2000);
        },

        health() {
            return {
                lane: 'words',
                open: ready && !closed,
                framesSent: state.framesSent,
                finals: state.finals,
                lastEventAt: state.lastEventAt,
                appliedConfig: state.appliedConfig,
            };
        },
    };
}

module.exports = { createSarvamRealtimeLane, normalise, MODEL, ENDPOINT };
