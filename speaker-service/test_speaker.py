# Session logic without the models. Fakes stand in for the VAD and the tracker so segment
# handling, confidence and buffer trimming can be checked in milliseconds.
#
# Run with pytest, or directly: python test_speaker.py

import numpy as np

from speaker import SpeakerSession, SAMPLE_RATE, COLD_START_MS


class FakeVad:
    """
    Emits the queued events on the next generate() call, then stays quiet until requeued.

    One add_audio() of N seconds calls generate() N*5 times, so a script consumed per call
    would be spent by the first batch.
    """

    def __init__(self, events=None):
        self.pending = list(events or [])
        self.calls = 0

    def queue(self, events):
        self.pending = list(events)

    def generate(self, **kwargs):
        self.calls += 1
        if not self.pending:
            return []
        events, self.pending = self.pending, []
        return [{"value": events}]


class FakeTracker:
    def __init__(self, ids=None):
        self.ids = list(ids or [])
        self.seen = []
        self.speaker_centers = []

    def assign_streaming(self, audio, t0_s, t1_s, sentence):
        self.seen.append((round(t0_s, 3), round(t1_s, 3), len(audio)))
        sentence["spk"] = self.ids.pop(0) if self.ids else 0


def pcm(ms):
    return (np.random.rand(SAMPLE_RATE * ms // 1000) * 1000).astype("<i2").tobytes()


def make(events=None, ids=None):
    return SpeakerSession("s1", FakeTracker(ids), FakeVad(events))


def test_open_and_close_produces_one_interval():
    s = make([[0, -1]])
    assert s.add_audio(pcm(200)) == []

    s.vad.queue([[-1, 400]])
    out = s.add_audio(pcm(200))

    assert len(out) == 1
    assert out[0]["t0_ms"] == 0 and out[0]["t1_ms"] == 400


def test_closed_segment_in_one_event():
    s = make([[0, 400]])
    out = s.add_audio(pcm(400))
    assert len(out) == 1 and out[0]["t0_ms"] == 0


def test_speaker_id_comes_from_the_tracker():
    s = make([[0, 400]], ids=[7])
    assert s.add_audio(pcm(400))[0]["speaker"] == "7"


def test_no_id_is_reported_as_null_not_invented():
    class NoId(FakeTracker):
        def assign_streaming(self, audio, t0_s, t1_s, sentence):
            sentence["spk"] = None

    s = SpeakerSession("s1", NoId(), FakeVad([[0, 400]]))
    assert s.add_audio(pcm(400))[0]["speaker"] is None


def test_the_tracker_gets_the_audio_for_that_span():
    s = make([[100, 300]])
    s.add_audio(pcm(400))

    t0, t1, samples = s.tracker.seen[0]
    assert (t0, t1) == (0.1, 0.3)
    assert samples == SAMPLE_RATE * 200 // 1000


def test_early_segments_are_unknown_not_guessed():
    s = make([[0, 1500]])
    assert s.add_audio(pcm(1500))[0]["confidence"] == "unknown"


def test_confidence_becomes_confident_after_the_cold_start_window():
    long_ms = COLD_START_MS + 2000
    s = make([[0, long_ms]])
    s.add_audio(pcm(long_ms))

    s.vad.queue([[long_ms, long_ms + 2000]])
    out = s.add_audio(pcm(2000))

    assert out[0]["confidence"] == "confident"


def test_a_very_short_segment_stays_provisional():
    long_ms = COLD_START_MS + 2000
    s = make([[0, long_ms]])
    s.add_audio(pcm(long_ms))

    s.vad.queue([[long_ms, long_ms + 300]])
    out = s.add_audio(pcm(300))

    assert out[0]["confidence"] == "provisional"


def test_a_very_long_segment_is_flagged_rather_than_split():
    # 40s of continuous speech is almost certainly two people run together by the VAD
    s = make([[0, 20000]])
    s.add_audio(pcm(20000))

    s.vad.queue([[20000, 60000]])
    out = s.add_audio(pcm(40000))

    assert out[0]["confidence"] == "provisional"


def test_flush_closes_an_open_segment():
    s = make([[0, -1]])
    s.add_audio(pcm(500))
    assert s.pending == 0

    out = s.flush()
    assert len(out) == 1 and out[0]["t0_ms"] == 0
    assert s.pending is None


def test_flush_with_nothing_open_returns_nothing():
    s = make()
    s.add_audio(pcm(200))
    assert s.flush() == []


def test_a_segment_under_100ms_is_dropped_rather_than_embedded():
    s = make([[0, 50]])
    assert s.add_audio(pcm(200)) == []
    assert s.tracker.seen == []


def test_buffer_is_trimmed_so_a_long_meeting_does_not_hold_all_its_audio():
    s = make([[0, 1000]])
    s.add_audio(pcm(1000))
    s.vad.queue([[1000, 2000]])
    s.add_audio(pcm(1000))
    s.vad.queue([[2000, 3000]])
    s.add_audio(pcm(1000))

    # only what is needed for the next segment is kept, not all three seconds
    assert len(s.buffer) < SAMPLE_RATE
    assert s.stats()["total_ms"] == 3000


def test_an_open_segment_is_not_trimmed_away():
    s = make([[0, 500]])
    s.add_audio(pcm(1000))
    s.vad.queue([[600, -1]])
    s.add_audio(pcm(1000))
    s.add_audio(pcm(1000))

    assert s.pending == 600
    assert s.buffer_start_ms <= 600          # the open segment's audio survives

    out = s.flush()
    assert len(out) == 1 and out[0]["t0_ms"] == 600


def test_audio_shorter_than_a_vad_chunk_is_carried_not_dropped():
    s = make()
    s.add_audio(pcm(50))
    s.add_audio(pcm(50))

    assert s.vad.calls == 0                  # 100ms total, under the 200ms chunk
    assert len(s.leftover) == SAMPLE_RATE * 100 // 1000
    assert s.stats()["total_ms"] == 100


if __name__ == "__main__":
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            passed += 1
            print("ok", name)
    print(f"\n{passed} passed")
