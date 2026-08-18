# Buffering and timeline arithmetic without the model. A stub stands in for inference so the thing that actually went wrong once, which stretch of audio a span's timestamps refer to, can be checked in milliseconds.
#
# Run with pytest, or directly: python test_overlap.py

import numpy as np

import overlap
from overlap import FRAME_MS, OverlapSession, WINDOW_S, spans_from_mask


class StubModel:
    """Stands in for segmentation-3.0 so no weights are needed."""


def pcm(seconds, sample_rate=16000):
    return np.zeros(int(seconds * sample_rate), dtype="<i2").tobytes()


def session_with(fractions_for):
    """A session whose inference returns whatever the caller dictates, per buffer length."""
    session = OverlapSession(StubModel(), 16000)
    overlap.vote_fractions = lambda model, buf, sr: fractions_for(len(buf) / sr)
    return session


def test_spans_need_a_minimum_duration():
    # A 50ms blip is two boundaries disagreeing, not two people talking.
    mask = np.zeros(200, dtype=bool)
    mask[10:15] = True
    assert spans_from_mask(mask) == []


def test_spans_carry_the_session_offset():
    mask = np.zeros(200, dtype=bool)
    mask[10:60] = True                       # 500ms, comfortably over the floor
    [span] = spans_from_mask(mask, offset_ms=30000)

    assert span["event"] == "overlap"
    assert span["t0_ms"] == 30000 + 10 * FRAME_MS
    assert span["t1_ms"] == 30000 + 60 * FRAME_MS


def test_nothing_emitted_before_the_buffer_fills():
    session = session_with(lambda secs: np.ones(int(secs * 1000 / FRAME_MS), dtype=np.float32))
    assert session.add_audio(pcm(10)) == []
    assert session.add_audio(pcm(10)) == []


def test_holds_back_the_last_window_until_it_has_context():
    # Everything is contested, so whatever comes back marks exactly the region considered settled.
    session = session_with(lambda secs: np.ones(int(secs * 1000 / FRAME_MS), dtype=np.float32))
    session.add_audio(pcm(20))
    [span] = session.add_audio(pcm(10))       # buffer now 30s

    # One model window at the right edge is left for next time: emitting to the edge cost 12
    # points of recall, because those frames were voted on by a handful of windows, not ten.
    assert span["t0_ms"] == 0
    assert span["t1_ms"] == int((30 - WINDOW_S) * 1000)


def test_successive_drains_are_contiguous_and_do_not_repeat():
    session = session_with(lambda secs: np.ones(int(secs * 1000 / FRAME_MS), dtype=np.float32))
    session.add_audio(pcm(20))
    [first] = session.add_audio(pcm(10))
    [second] = session.add_audio(pcm(10))

    assert second["t0_ms"] == first["t1_ms"]
    assert second["t1_ms"] > second["t0_ms"]


def test_flush_releases_the_tail_that_was_waiting():
    session = session_with(lambda secs: np.ones(int(secs * 1000 / FRAME_MS), dtype=np.float32))
    session.add_audio(pcm(20))
    [first] = session.add_audio(pcm(10))
    [tail] = session.flush()

    assert tail["t0_ms"] == first["t1_ms"]
    assert tail["t1_ms"] == 30000              # all 30s accounted for, nothing dropped


def test_a_failed_window_costs_its_flags_not_the_session():
    def explode(model, buf, sr):
        raise RuntimeError("inference blew up")

    session = OverlapSession(StubModel(), 16000)
    overlap.vote_fractions = explode
    session.add_audio(pcm(20))
    assert session.add_audio(pcm(10)) == []

    # And the timeline still advances, so the next drain is not stuck reprocessing this audio.
    overlap.vote_fractions = lambda m, b, s: np.ones(int(len(b) / s * 1000 / FRAME_MS), np.float32)
    assert session.add_audio(pcm(10))[0]["t0_ms"] >= int((30 - WINDOW_S) * 1000)


def test_disabled_without_a_model():
    session = OverlapSession(None, 16000)
    assert session.enabled is False
    assert session.add_audio(pcm(60)) == []
    assert session.flush() == []


if __name__ == "__main__":
    import sys

    original = overlap.vote_fractions
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            overlap.vote_fractions = original
            fn()
            passed += 1
            print("ok", name)
    print(f"\n{passed} passed")
    sys.exit(0)
