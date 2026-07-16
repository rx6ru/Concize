// Spools live meeting audio to disk as WAV so reconciliation can batch-transcribe it later.
// One write stream per meeting holds a placeholder header; close() patches in the real
// sizes once the byte count is known, so the meeting is never held in memory.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { createLogger } = require('../core/logger');

const logger = createLogger('recorder');

const HEADER_BYTES = 44;

// Strips anything that could escape the spool directory. The hash keeps two ids that sanitise
// to the same slug (a/b and a_b) from writing to one file and corrupting each other.
function safeName(meetingId) {
    const id = String(meetingId);
    const slug = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    const hash = createHash('sha1').update(id).digest('hex').slice(0, 8);
    return `rec-${slug}-${hash}.wav`;
}

function durationMsFor(dataBytes, sampleRate) {
    return Math.round((dataBytes / (sampleRate * 2)) * 1000);
}

function wavHeader(dataBytes, sampleRate = 16000) {
    const header = Buffer.alloc(HEADER_BYTES);
    const byteRate = sampleRate * 2;
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);      // fmt chunk size
    header.writeUInt16LE(1, 20);       // PCM
    header.writeUInt16LE(1, 22);       // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);       // block align, 16-bit mono
    header.writeUInt16LE(16, 34);      // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);
    return header;
}

// slices a WAV buffer by time and returns a new self-contained WAV, since each
// segment is uploaded to the batch API as its own file.
function sliceAudio(buffer, t0Ms, t1Ms, sampleRate = 16000) {
    const samplesPerMs = sampleRate / 1000;
    const dataBytes = Math.max(0, buffer.length - HEADER_BYTES);
    const totalMs = durationMsFor(dataBytes, sampleRate);

    const start = Math.min(Math.max(0, t0Ms), totalMs);
    const end = Math.min(Math.max(0, t1Ms), totalMs);
    if (end <= start) return wavHeader(0, sampleRate);

    const startByte = Math.round(start * samplesPerMs) * 2;
    const endByte = Math.round(end * samplesPerMs) * 2;
    const data = buffer.subarray(HEADER_BYTES + startByte, HEADER_BYTES + endByte);
    return Buffer.concat([wavHeader(data.length, sampleRate), data]);
}

function createRecorder({ dir = os.tmpdir(), sampleRate = 16000 } = {}) {
    const spools = new Map();

    const filePath = (meetingId) => path.join(dir, safeName(meetingId));

    return {
        write(meetingId, pcmFrame) {
            try {
                let entry = spools.get(meetingId);
                if (!entry) {
                    // a frame arriving after close would otherwise open a fresh stream and
                    // truncate the finished recording
                    if (fs.existsSync(filePath(meetingId))) return;
                    const stream = fs.createWriteStream(filePath(meetingId));
                    stream.on('error', (err) =>
                        logger.warn('Spool stream error', { meetingId, error: err.message }));
                    stream.write(wavHeader(0, sampleRate)); // placeholder, patched on close
                    entry = { stream, bytes: 0 };
                    spools.set(meetingId, entry);
                }
                entry.stream.write(pcmFrame);
                entry.bytes += pcmFrame.length;
            } catch (err) {
                logger.warn('Recorder write failed', { meetingId, error: err.message });
            }
        },

        async close(meetingId) {
            const entry = spools.get(meetingId);
            if (!entry) return null;
            spools.delete(meetingId);

            try {
                await new Promise((resolve, reject) => {
                    entry.stream.end((err) => (err ? reject(err) : resolve()));
                });

                const fd = await fsp.open(filePath(meetingId), 'r+');
                try {
                    await fd.write(wavHeader(entry.bytes, sampleRate), 0, HEADER_BYTES, 0);
                } finally {
                    await fd.close();
                }

                return { path: filePath(meetingId), durationMs: durationMsFor(entry.bytes, sampleRate), bytes: entry.bytes };
            } catch (err) {
                logger.warn('Recorder close failed', { meetingId, error: err.message });
                return null;
            }
        },

        async load(meetingId) {
            try {
                const buffer = await fsp.readFile(filePath(meetingId));
                if (buffer.length < HEADER_BYTES) return null;
                return { buffer, durationMs: durationMsFor(buffer.length - HEADER_BYTES, sampleRate) };
            } catch (err) {
                if (err.code !== 'ENOENT') logger.warn('Recorder load failed', { meetingId, error: err.message });
                return null;
            }
        },

        async discard(meetingId) {
            try {
                await fsp.unlink(filePath(meetingId));
                return true;
            } catch (err) {
                if (err.code !== 'ENOENT') logger.warn('Recorder discard failed', { meetingId, error: err.message });
                return false;
            }
        },

        active() {
            return spools.size;
        },
    };
}

module.exports = { createRecorder, sliceAudio, wavHeader };
