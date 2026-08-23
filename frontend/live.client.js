// The realtime client the extension was missing.
//
// The backend has always expected a WebSocket at /rt carrying 4-byte-sequenced 16kHz PCM
// (backend/src/realtime/gateway.js). offscreen.js was POSTing WebM to an HTTP route that was
// deleted on 2026-08-06, so no audio has reached the pipeline since. This speaks the real protocol.
//
// Deliberately free of browser APIs beyond WebSocket, which is injectable, so the lifecycle can be
// tested without a browser. offscreen.js owns capture and hands samples to pushAudio.

(function (root) {
    const proto = (typeof require === 'function' && typeof module !== 'undefined')
        ? require('./audio.protocol.js')
        : root.ConcizeAudioProtocol;

    // Long enough to ride out a sleeping laptop or a lift, bounded so a dead network cannot grow
    // the tab until it dies. 600 frames is a minute of audio.
    const MAX_BUFFERED_FRAMES = 600;
    const BACKOFF_MS = [500, 1000, 2000, 5000, 10000, 30000];

    class LiveClient {
        constructor({
            backendUrl, meetingId, token,
            onEvent = () => {},
            onStatus = () => {},
            WebSocketImpl = (typeof WebSocket !== 'undefined' ? WebSocket : null),
            setTimeoutImpl = (typeof setTimeout !== 'undefined' ? setTimeout : null),
            maxBufferedFrames = MAX_BUFFERED_FRAMES,
        }) {
            this.url = `${String(backendUrl).replace(/^http/, 'ws').replace(/\/$/, '')}/rt`
                + `?meetingId=${encodeURIComponent(meetingId)}&token=${encodeURIComponent(token)}`;
            this.onEvent = onEvent;
            this.onStatus = onStatus;
            this.WebSocketImpl = WebSocketImpl;
            this.setTimeoutImpl = setTimeoutImpl;
            this.maxBufferedFrames = maxBufferedFrames;

            this.socket = null;
            this.ready = false;
            this.stopped = false;
            this.attempt = 0;
            this.pending = [];
            this.frames = new proto.FrameSequencer();
        }

        start() {
            if (this.stopped) return;
            const socket = new this.WebSocketImpl(this.url);
            socket.binaryType = 'arraybuffer';
            this.socket = socket;
            this.ready = false;

            socket.onopen = () => this.onStatus({ state: 'open' });

            socket.onmessage = (evt) => {
                let msg;
                try { msg = JSON.parse(evt.data); } catch { return; }
                if (msg.type === 'session.ready') {
                    this.ready = true;
                    this.attempt = 0;
                    this.#drain();
                }
                this.onEvent(msg);
            };

            socket.onclose = (evt) => {
                this.ready = false;
                this.onStatus({ state: 'closed', code: evt && evt.code });
                if (this.stopped) return;
                // Every reconnect starts a fresh sequence: the gateway resumes a meeting by adding
                // its own offset to a client that counts from zero again. Continuing the count
                // would rewrite the timeline from the beginning.
                this.frames = new proto.FrameSequencer();
                const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
                this.attempt += 1;
                this.setTimeoutImpl(() => this.start(), delay);
            };

            socket.onerror = () => this.onStatus({ state: 'error' });
        }

        /** Hand it captured samples at whatever rate the capture graph runs. */
        pushAudio(samples, inputRate) {
            if (this.stopped) return;
            this.frames.push(samples, inputRate, (frame) => this.#queue(frame));
        }

        /** Ends the meeting: flush the tail, say stop, and stay closed. */
        stop() {
            if (this.stopped) return;
            this.frames.flush((frame) => this.#queue(frame));
            this.#drain();
            if (this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
                this.socket.send(JSON.stringify({ event: 'stop' }));
            }
            this.stopped = true;
        }

        #queue(frame) {
            if (this.ready && this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
                this.socket.send(frame);
                return;
            }
            this.pending.push(frame);
            // Keeping the newest is the right trade: on reconnect the server resumes from its own
            // watermark, so stale audio would land in the wrong place anyway.
            if (this.pending.length > this.maxBufferedFrames) {
                this.pending.splice(0, this.pending.length - this.maxBufferedFrames);
            }
        }

        #drain() {
            if (!this.ready || !this.socket) return;
            while (this.pending.length) this.socket.send(this.pending.shift());
        }
    }

    const api = { LiveClient, MAX_BUFFERED_FRAMES };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) Object.assign(root, { ConcizeLiveClient: api });
}(typeof self !== 'undefined' ? self : null));
