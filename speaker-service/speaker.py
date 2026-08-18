# Per-session speaker tracking: VAD finds the speech segments, FunASR's tracker decides who each one belongs to.
# No websocket code here so the logic can be driven from a test.

import numpy as np

SAMPLE_RATE = 16000
VAD_CHUNK_MS = 200

# Measured on an L40S against LibriSpeech ground truth, 40 speaker sessions.
# threshold 0.60 -> 0.70 moved turn accuracy 0.854 -> 0.942 and halved the number of ids holding more than one person, with no latency cost across the whole sweep.
# The roster cap is deliberately far above any real meeting: when it fills, the matcher stops applying the threshold and force matches to the nearest centroid (cosine 0.3185 accepted against 0.6), which merges two people into one id with nothing downstream able to tell.
THRESHOLD = 0.70
MAX_SPEAKERS = 500
MAX_NUM_SPKS = 30
MAX_HISTORY_CHUNKS = 384

# The tracker needs about 20 chunks of history before its cluster assignment means anything.
# Measured as 8.6 to 15.0 seconds of speech, consistent across 39 runs.
# Segments before that get an id, but it is not trustworthy, so they go out as unknown.
COLD_START_MS = 15000

# Short segments give noisy embeddings. Long enough to get an id, not long enough to bet on.
MIN_CONFIDENT_MS = 1000

# A segment longer than this is almost certainly two people the VAD ran together.
# Splitting it would be guessing, so it is passed through and flagged instead.
MAX_TRUSTED_SEGMENT_MS = 30000


class SpeakerSession:
    
    """
    Feed it PCM, get back speaker intervals.

    Audio is buffered only as far back as the currently open segment, otherwise a five hour meeting holds five hours of float32 in memory.
    """

    def __init__(self, session_id, tracker, vad, sample_rate=SAMPLE_RATE):
        self.session_id = session_id
        self.tracker = tracker
        self.vad = vad
        self.sample_rate = sample_rate

        self.vad_cache = {}
        self.buffer = np.zeros(0, dtype=np.float32)
        self.buffer_start_ms = 0          # session time of buffer[0]
        self.total_ms = 0                 # session time of the end of the buffer
        self.pending = None               # start ms of an open segment, if any
        self.speech_ms = 0                # speech seen so far, drives the cold start guard
        self.leftover = np.zeros(0, dtype=np.float32)   # under one VAD chunk

    def add_audio(self, pcm_bytes):
        """PCM is little endian 16 bit mono. Returns a list of finished speaker intervals."""
        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self.buffer = np.concatenate([self.buffer, samples])
        self.total_ms += len(samples) * 1000 // self.sample_rate

        work = np.concatenate([self.leftover, samples])
        step = self.sample_rate * VAD_CHUNK_MS // 1000

        events = []
        offset = 0
        while offset + step <= len(work):
            events.extend(self._run_vad(work[offset:offset + step], is_final=False))
            offset += step
        self.leftover = work[offset:]

        return self._handle(events)

    def flush(self):
        """Close whatever is open. Called when the client pauses or the meeting ends."""
        events = []
        if len(self.leftover):
            events.extend(self._run_vad(self.leftover, is_final=True))
            self.leftover = np.zeros(0, dtype=np.float32)

        intervals = self._handle(events)
        if self.pending is not None:
            intervals.extend(self._emit(self.pending, self.total_ms))
            self.pending = None
        return intervals

    def _run_vad(self, chunk, is_final):
        result = self.vad.generate(
            input=chunk, cache=self.vad_cache, is_final=is_final, chunk_size=VAD_CHUNK_MS
        )
        if not result or not result[0].get("value"):
            return []
        return result[0]["value"]

    def _handle(self, events):
        """VAD reports boundaries as [start, -1], [-1, end], or [start, end]."""
        intervals = []
        for start, end in events:
            if start != -1 and end != -1:
                intervals.extend(self._emit(start, end))
            elif start != -1:
                self.pending = start
            elif end != -1 and self.pending is not None:
                intervals.extend(self._emit(self.pending, end))
                self.pending = None
        return intervals

    def _emit(self, t0_ms, t1_ms):
        if t1_ms <= t0_ms:
            return []

        audio = self._slice(t0_ms, t1_ms)
        if audio is None or len(audio) < self.sample_rate // 10:   # under 100ms, not speech
            self._trim(t1_ms)
            return []

        sentence = {"text": "", "start": int(t0_ms), "end": int(t1_ms)}
        self.tracker.assign_streaming(audio, t0_ms / 1000.0, t1_ms / 1000.0, sentence)
        speaker = sentence.get("spk")

        self.speech_ms += t1_ms - t0_ms
        self._trim(t1_ms)

        return [{
            "event": "speaker",
            "t0_ms": int(t0_ms),
            "t1_ms": int(t1_ms),
            "speaker": None if speaker is None else str(speaker),
            "confidence": self._confidence(t0_ms, t1_ms),
        }]

    def _confidence(self, t0_ms, t1_ms):
        duration = t1_ms - t0_ms
        if self.speech_ms < COLD_START_MS:
            return "unknown"
        if duration < MIN_CONFIDENT_MS or duration > MAX_TRUSTED_SEGMENT_MS:
            return "provisional"
        return "confident"

    def _slice(self, t0_ms, t1_ms):
        start = int((t0_ms - self.buffer_start_ms) * self.sample_rate / 1000)
        end = int((t1_ms - self.buffer_start_ms) * self.sample_rate / 1000)
        if start < 0 or end > len(self.buffer):
            return None
        return self.buffer[start:end]

    def _trim(self, up_to_ms):
        keep_from = self.pending if self.pending is not None else up_to_ms
        drop = int((keep_from - self.buffer_start_ms) * self.sample_rate / 1000)
        if drop <= 0:
            return
        self.buffer = self.buffer[drop:]
        self.buffer_start_ms = keep_from

    def stats(self):
        return {
            "session": self.session_id,
            "total_ms": self.total_ms,
            "speech_ms": self.speech_ms,
            "buffered_ms": self.total_ms - self.buffer_start_ms,
            "speakers": len(getattr(self.tracker, "speaker_centers", [])),
        }


def build_tracker(spk_model, device, HybridSpeakerTracker):
    tracker = HybridSpeakerTracker(
        spk_model,
        device,
        threshold=THRESHOLD,
        max_history_chunks=MAX_HISTORY_CHUNKS,
        max_speakers=MAX_SPEAKERS,
    )
    tracker.cluster_backend.spectral_cluster.max_num_spks = MAX_NUM_SPKS
    return tracker
