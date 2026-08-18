# Overlapped speech detection, the parallel lane to speaker attribution.
#
# Why a model rather than the free signal: a clustering backend like CAM++ assigns exactly one speaker per segment by construction, so two people talking at once inside a segment is invisible to it and there is nothing to intersect.
# Measured frame-wise at 10ms against AMI word-level ground truth, deriving overlap from intersecting speaker intervals scores F1 23.6% against 69.2% for pyannote segmentation-3.0 on the same three meetings.
#
# segmentation-3.0 emits a powerset over which speakers are active in a window, the classes are (none), (spk1), (spk2), (spk3), (spk1+spk2), (spk1+spk3), (spk2+spk3), so overlap is a first class output.
# It is 1.5M parameters and runs comfortably on CPU, which matters when the box has 4GB of VRAM and the diarizer is already resident.

import logging
import os

import numpy as np

log = logging.getLogger("speaker-service.overlap")

FRAME_MS = 10

# Below this an "overlap" is two boundaries disagreeing by a few frames rather than two people speaking; flagging those would mark most of a meeting and make the signal worthless.
MIN_OVERLAP_MS = 120

# A speaker counts as active above this.
# Measured on AMI, 0.5 and 0.3 produce byte-identical spans: a powerset softmax read as multilabel leaves almost nothing in between.
ACTIVATION = 0.5

# Share of the covering windows that must agree before an instant is called contested.
# Swept on ES2004a and checked on two held-out meetings: F1 rises to roughly 69% as this falls, and 0.2 is taken over 0.1 because F1 is level there while precision is four points better.
# A false flag makes us hedge clean speech, which is the more expensive mistake for us.
VOTE = 0.2

# The model's own window.
# An instant is voted on by every window covering it, so an instant needs this much audio on BOTH sides to collect the full set of votes.
WINDOW_S = 10.0

# Run inference once this much has accumulated.
# Nothing within one model-window of the buffer's right edge is emitted; it waits for the audio that follows it.
# Emitting to the edge instead cost 12 points of recall measured on ES2004a, those frames were voted on by a handful of windows rather than ten, so they faced a far higher bar than the threshold intends.
#
# The cost is that overlap lags the transcript by ten to twenty seconds.
# That is acceptable here and nowhere else in the pipeline: fusion applies late overlap data as a revision rather than holding text back for it, and chunks stay open far longer than this.
BUFFER_S = 30.0


def load_model(token=None):
    """The model, or None if it cannot be had. Overlap is advisory; the service runs without it."""
    token = token or os.environ.get("HF_TOKEN")
    if not token:
        log.warning("no HF_TOKEN, overlap detection disabled")
        return None
    try:
        from pyannote.audio import Model

        model = Model.from_pretrained("pyannote/segmentation-3.0", token=token)
        model.eval()
        log.info("overlap model ready (%d params)", sum(p.numel() for p in model.parameters()))
        return model
    except Exception as err:                                      # noqa: BLE001
        log.warning("overlap detection disabled: %s", err)
        return None


def vote_fractions(model, waveform, sample_rate):
    """Per 10ms fraction of covering windows that saw two or more speakers at once.

    The powerset output cannot be averaged across windows, "speaker#1" in one window is not the same person as "speaker#1" in the next, which is why pyannote refuses to aggregate it and hands back one matrix per window. How *many* people are talking does not depend on what they are called, so that is what gets aggregated.
    """
    import torch
    from pyannote.audio.core.inference import Inference

    audio = {"waveform": torch.as_tensor(waveform).reshape(1, -1), "sample_rate": sample_rate}
    scores = Inference(model, step=1.0)(audio)

    windows = scores.sliding_window
    frames = model.receptive_field
    contested = (scores.data > ACTIVATION).sum(axis=-1) >= 2

    n = int(windows[len(scores.data) - 1].end * 1000 / FRAME_MS) + 1
    votes = np.zeros(n, dtype=np.float32)
    seen = np.zeros(n, dtype=np.float32)

    for w in range(contested.shape[0]):
        base = windows[w].start
        for f in range(contested.shape[1]):
            idx = int((base + frames[f].middle) * 1000 / FRAME_MS)
            if 0 <= idx < n:
                seen[idx] += 1
                if contested[w, f]:
                    votes[idx] += 1

    return np.divide(votes, seen, out=np.zeros_like(votes), where=seen > 0)


def spans_from_mask(mask, offset_ms=0, min_ms=MIN_OVERLAP_MS):
    """Contiguous runs of the mask as spans on the session timeline."""
    spans = []
    start = None
    for i, on in enumerate(mask):
        if on and start is None:
            start = i
        elif not on and start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(mask)))

    out = []
    for a, b in spans:
        t0_ms, t1_ms = a * FRAME_MS, b * FRAME_MS
        if t1_ms - t0_ms >= min_ms:
            out.append({
                "event": "overlap",
                "t0_ms": int(t0_ms + offset_ms),
                "t1_ms": int(t1_ms + offset_ms),
            })
    return out


class OverlapSession:
    """Feed it the same PCM the diarizer gets, get back contested spans on the session clock."""

    def __init__(self, model, sample_rate=16000):
        self.model = model
        self.sample_rate = sample_rate
        self.buffer = np.zeros(0, dtype=np.float32)
        self.buffer_start_ms = 0    # where the buffer sits on the session clock
        self.emitted_ms = 0         # how far spans have already been reported

    @property
    def enabled(self):
        return self.model is not None

    def add_audio(self, pcm_bytes):
        if not self.enabled:
            return []

        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self.buffer = np.concatenate([self.buffer, samples])

        if len(self.buffer) < int(BUFFER_S * self.sample_rate):
            return []
        return self._drain(final=False)

    def flush(self):
        """Whatever is left, on the way out, including the tail that was waiting for context."""
        if not self.enabled or len(self.buffer) < self.sample_rate:
            return []
        return self._drain(final=True)

    def _buffer_ms(self):
        return len(self.buffer) * 1000 / self.sample_rate

    def _drain(self, final):
        buffered_ms = self._buffer_ms()
        # On the way out there is no more audio coming, so the tail is emitted as it stands.
        end_rel = buffered_ms if final else buffered_ms - WINDOW_S * 1000
        start_rel = self.emitted_ms - self.buffer_start_ms

        if end_rel <= start_rel:
            return []

        try:
            fractions = vote_fractions(self.model, self.buffer, self.sample_rate)
        except Exception as err:                                  # noqa: BLE001
            # A failed window costs this stretch's overlap flags, not the session.
            # The timeline still has to move: leaving emitted_ms behind while the buffer advances would make the next drain slice from a negative offset and mis-time every span after it.
            log.warning("overlap inference failed: %s", err)
            self.emitted_ms = self.buffer_start_ms + end_rel
            self._trim(end_rel)
            return []

        mask = fractions[int(start_rel / FRAME_MS):int(end_rel / FRAME_MS)] > VOTE
        spans = spans_from_mask(mask, offset_ms=self.emitted_ms)

        self.emitted_ms = self.buffer_start_ms + end_rel
        self._trim(end_rel)
        return spans

    def _trim(self, end_rel):
        """Keep one model window behind what was emitted, as left context for the next pass."""
        keep_from = max(0, end_rel - WINDOW_S * 1000)
        drop = int(keep_from * self.sample_rate / 1000)
        if drop <= 0:
            return
        self.buffer = self.buffer[drop:]
        self.buffer_start_ms += keep_from
