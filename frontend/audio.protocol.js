// Turning captured audio into what the realtime gateway accepts.
//
// The wire format is a 4-byte big-endian sequence number followed by raw little-endian 16-bit
// mono PCM at 16kHz. The server derives every timestamp from seq * frameMs rather than from
// arrival time, so a frame that is not exactly one frameMs of audio does not lose a moment of
// speech, it shifts the whole transcript after it.
//
// Kept free of browser APIs so it can be tested without one. offscreen.js supplies the samples.

(function (root) {
    const SAMPLE_RATE = 16000;
    const FRAME_MS = 100;
    const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
    const FRAME_BYTES = FRAME_SAMPLES * 2;

    /** Float samples in [-1, 1] to signed 16-bit, clamping rather than wrapping at full scale. */
    function floatToPcm16(samples) {
        const out = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    /**
     * Linear resample to 16kHz. A capture graph runs at the device rate, commonly 48kHz, and the
     * gateway accepts one rate only.
     */
    function resampleTo16k(samples, inputRate) {
        if (inputRate === SAMPLE_RATE) return samples;
        const ratio = inputRate / SAMPLE_RATE;
        const out = new Float32Array(Math.round(samples.length / ratio));
        for (let i = 0; i < out.length; i += 1) {
            const at = i * ratio;
            const low = Math.floor(at);
            const high = Math.min(low + 1, samples.length - 1);
            out[i] = samples[low] + (samples[high] - samples[low]) * (at - low);
        }
        return out;
    }

    /** Accumulates samples and hands out whole frames, each carrying its own sequence number. */
    class FrameSequencer {
        constructor() {
            this.seq = 0;
            this.pending = new Float32Array(0);
        }

        push(samples, inputRate, emit) {
            const resampled = resampleTo16k(samples, inputRate);
            const merged = new Float32Array(this.pending.length + resampled.length);
            merged.set(this.pending);
            merged.set(resampled, this.pending.length);

            let offset = 0;
            while (merged.length - offset >= FRAME_SAMPLES) {
                emit(this._frame(merged.subarray(offset, offset + FRAME_SAMPLES)));
                offset += FRAME_SAMPLES;
            }
            this.pending = merged.slice(offset);
        }

        /** Sends whatever is left as one frame, padded with silence. The tail of a meeting is speech too. */
        flush(emit) {
            if (!this.pending.length) return;
            const padded = new Float32Array(FRAME_SAMPLES);
            padded.set(this.pending);
            emit(this._frame(padded));
            this.pending = new Float32Array(0);
        }

        _frame(samples) {
            const pcm = floatToPcm16(samples);
            const buf = new ArrayBuffer(4 + FRAME_BYTES);
            new DataView(buf).setUint32(0, this.seq, false);
            new Uint8Array(buf, 4).set(new Uint8Array(pcm.buffer, pcm.byteOffset, FRAME_BYTES));
            this.seq += 1;
            return buf;
        }
    }

    const api = {
        floatToPcm16, resampleTo16k, FrameSequencer,
        SAMPLE_RATE, FRAME_MS, FRAME_SAMPLES, FRAME_BYTES,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) Object.assign(root, { ConcizeAudioProtocol: api });
}(typeof self !== 'undefined' ? self : null));
