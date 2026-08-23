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
            this.stopping = false;
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
                    // Every connection is a fresh gateway session that expects seq to start at 0
                    // (backend/src/realtime/session.js derives t0Ms from startOffsetMs + seq*frameMs,
                    // with startOffsetMs coming from the stored transcript's watermark, not from how
                    // long the client was offline). Whatever is still queued from before this
                    // connection existed goes first, renumbered to hold that place.
                    this.#renumberPending();
                    this.#drain();
                    if (this.stopping) this.#sendStop();
                }
                this.onEvent(msg);
            };

            socket.onclose = (evt) => {
                this.ready = false;
                this.onStatus({ state: 'closed', code: evt && evt.code });
                if (this.stopped) return;
                const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
                this.attempt += 1;
                this.setTimeoutImpl(() => this.start(), delay);
            };

            socket.onerror = () => this.onStatus({ state: 'error' });
        }

        /** Hand it captured samples at whatever rate the capture graph runs. */
        pushAudio(samples, inputRate) {
            if (this.stopped || this.stopping) return;
            this.frames.push(samples, inputRate, (frame) => this.#queue(frame));
        }

        /** Ends the meeting: flush the tail, say stop, and stay closed.
         * A meeting can end while the socket is down, and may never get another connection --
         * that is exactly when the tail matters most, so this does not give up on delivering it.
         * If a connection is live right now the stop goes out immediately; otherwise it waits,
         * queued, for whatever `start()`/reconnect already has in flight to eventually succeed. */
        stop() {
            if (this.stopped || this.stopping) return;
            this.stopping = true;
            this.frames.flush((frame) => this.#queue(frame));
            if (this.ready && this.socket && this.socket.readyState === this.WebSocketImpl.OPEN) {
                this.#drain();
                this.#sendStop();
            }
        }

        #sendStop() {
            this.socket.send(JSON.stringify({ event: 'stop' }));
            this.stopped = true;
        }

        // Rewrites the queued frames' seq prefix to their position in line, then carries the
        // count into the live sequencer so anything built after continues it without a gap.
        // A no-op when nothing is queued, so it is safe to call on every session.ready, not just
        // a reconnect.
        #renumberPending() {
            for (let i = 0; i < this.pending.length; i += 1) {
                new DataView(this.pending[i]).setUint32(0, i, false);
            }
            this.frames.seq = this.pending.length;
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
