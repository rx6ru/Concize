// Bridges the AudioWorklet's fixed 128-sample render quantum to buffers worth a postMessage.
// Posting every quantum would be ~375 messages/sec at 48kHz; batching keeps the port quiet.
// offscreen.js hands each batch to liveClient.pushAudio, which does the resampling and framing.
//
// SampleBatcher is plain array arithmetic, kept separate from AudioWorkletProcessor so it can be
// tested with node:test, which has no AudioWorkletGlobalScope.

const BATCH_SAMPLES = 4096;

/** Accumulates input into a fixed-size buffer, calling emit with a copy each time it fills. */
class SampleBatcher {
    constructor(size = BATCH_SAMPLES) {
        this.buffer = new Float32Array(size);
        this.offset = 0;
    }

    push(input, emit) {
        let read = 0;
        while (read < input.length) {
            const room = this.buffer.length - this.offset;
            const take = Math.min(room, input.length - read);
            this.buffer.set(input.subarray(read, read + take), this.offset);
            this.offset += take;
            read += take;
            if (this.offset === this.buffer.length) {
                emit(this.buffer.slice());
                this.offset = 0;
            }
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SampleBatcher, BATCH_SAMPLES };
}

// Only present inside an AudioWorkletGlobalScope, so this block is a no-op under node:test.
if (typeof AudioWorkletProcessor !== 'undefined') {
    class CaptureProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.batcher = new SampleBatcher();
        }

        process(inputs) {
            const input = inputs[0] && inputs[0][0];
            if (input) this.batcher.push(input, (frame) => this.port.postMessage(frame));
            return true; // keep the processor alive for the life of the node
        }
    }

    registerProcessor('capture-processor', CaptureProcessor);
}
