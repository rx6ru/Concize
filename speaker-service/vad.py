# Voice activity detection for the speaker lane.
#
# The service shipped with FunASR's fsmn-vad, which is speech_fsmn_vad_zh-cn-16k-common: a
# Chinese model. On English meetings that was merely unremarkable. On Hindi it under-segments by
# five to ten times — measured on five Indic DiarBench clips it returned 5 to 11 speech regions
# where the reference has 18 to 66 turns, so almost every segment it produced spanned several
# speakers. Since attribution assigns one speaker per segment, that alone put a 53.8% floor under
# speaker error on Hindi against 27.8% on English, and no amount of better clustering can reach
# below a floor.
#
# Silero finds 24 to 68 regions on the same five clips, which is the reference turn count give or
# take. It is also what every production streaming stack surveyed defaults to (Pipecat, LiveKit,
# whisper-streaming, WhisperLive), it is MIT, a couple of megabytes, and genuinely causal — which
# matters, because SpeakerSession trims its audio buffer as segments close and cannot wait on a
# detector that needs to see the future.
#
# NOT ENABLED YET, AND THE MEASUREMENTS SAY WHY. Swapping the VAD does exactly what it should to
# segmentation and still does not improve the number that matters:
#
#                       speaker error        segmentation floor
#     Hindi   fsmn      61.0%                53.8%
#     Hindi   silero    63.6%                37.5%
#     ES2004a fsmn      38.0%                27.0%
#     ES2004a silero    33.2%                18.6%
#     IS1003b fsmn      28.7%                25.0%
#     IS1003b silero    42.1%                16.9%
#
# The floor falls every time, by 8 to 16 points. Actual error moves either way. The reason is
# visible in the speaker counts: ES2004a goes from 10 hypothesis speakers to 18, IS1003b from 5
# to 15. Shorter segments mean shorter embeddings, and the embedding model is CAM++, which is
# speech_campplus_sv_zh-cn_16k-common — Chinese, like the VAD it replaces. Give it less audio per
# segment and it invents speakers.
#
# So the binding constraint was never the VAD alone. Fixing segmentation only exposes the next
# one, and shipping this by itself would regress two of the three sets. It pairs with a
# multilingual embedding model — pyannote's wespeaker-voxceleb-resnet34-LM is the obvious
# candidate and is reachable with the token already configured. Measure that together, then
# switch both, or neither.
#
# The interface is FunASR's, so SpeakerSession does not know or care which one it got.

import logging

import numpy as np

log = logging.getLogger("speaker-service.vad")

SAMPLE_RATE = 16000

# Silero's window is fixed at 512 samples at 16kHz; the constructor argument that looks like it
# changes this is marked deprecated upstream and ignored.
WINDOW = 512


class SileroVad:
    """Speech boundaries in absolute session milliseconds, reported as FunASR reports them."""

    def __init__(self, model, sample_rate=SAMPLE_RATE, threshold=0.5,
                 min_silence_ms=250, speech_pad_ms=60):
        from silero_vad import VADIterator

        self.iterator = VADIterator(
            model,
            threshold=threshold,
            sampling_rate=sample_rate,
            min_silence_duration_ms=min_silence_ms,
            speech_pad_ms=speech_pad_ms,
        )
        self.sample_rate = sample_rate
        self.leftover = np.zeros(0, dtype=np.float32)
        self.consumed = 0          # samples fed to the iterator, for absolute timing
        self.open = False          # a start has been reported without its end

    def generate(self, input=None, cache=None, is_final=False, chunk_size=None):  # noqa: A002
        """FunASR's contract: [{'value': [[start_ms, end_ms], ...]}] with -1 for a missing side."""
        samples = np.asarray(input, dtype=np.float32).reshape(-1)
        if samples.size and np.abs(samples).max() > 1.5:
            # FunASR hands float arrays already scaled; be tolerant of raw int16 ranges too.
            samples = samples / 32768.0

        buf = np.concatenate([self.leftover, samples])
        events = []

        usable = (len(buf) // WINDOW) * WINDOW
        for i in range(0, usable, WINDOW):
            out = self.iterator(buf[i:i + WINDOW], return_seconds=False)
            self.consumed += WINDOW
            if not out:
                continue
            if "start" in out:
                events.append([self._ms(out["start"]), -1])
                self.open = True
            if "end" in out:
                events.append([-1, self._ms(out["end"])])
                self.open = False

        self.leftover = buf[usable:]

        # A stream that ends mid-utterance still has to close it, or the tail is never attributed.
        if is_final and self.open:
            events.append([-1, self._ms(self.consumed)])
            self.open = False
            self.iterator.reset_states()

        return [{"value": events}] if events else []

    def _ms(self, sample_index):
        return int(sample_index * 1000 / self.sample_rate)


def load_silero(sample_rate=SAMPLE_RATE):
    """The model, or None. A missing VAD is fatal to attribution, so the caller decides."""
    try:
        from silero_vad import load_silero_vad

        model = load_silero_vad()
        log.info("silero vad ready")
        return model
    except Exception as err:                                      # noqa: BLE001
        log.warning("silero unavailable, falling back to fsmn-vad: %s", err)
        return None
