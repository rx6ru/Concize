# Throwaway benchmark. NOT part of the service, not imported anywhere.
#
# Measures wall-clock cost of SpeakerSession.add_audio() per 200ms chunk of real audio, in
# process, with the real models loaded (no websocket, no event loop involved — this isolates
# exactly the call that app.py serialises behind the process-wide asyncio.Lock).
#
# Usage: .venv/bin/python bench_add_audio.py <path-to-wav> [--device cuda:0|cpu]

import argparse
import time
import wave

import numpy as np

from speaker import SpeakerSession, build_tracker, SAMPLE_RATE

CHUNK_MS = 200


def load_chunks(wav_path):
    w = wave.open(wav_path, "rb")
    assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
    chunk_frames = 16000 * CHUNK_MS // 1000
    chunks = []
    while True:
        data = w.readframes(chunk_frames)
        if not data:
            break
        chunks.append(data)
    return chunks, w.getnframes() / 16000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--device", default="cuda:0")
    args = ap.parse_args()

    print(f"loading models on {args.device} ...")
    t0 = time.time()
    from funasr import AutoModel
    from funasr.bin.realtime_ws import HybridSpeakerTracker

    spk_model = AutoModel(
        model="iic/speech_campplus_sv_zh-cn_16k-common", device=args.device, disable_update=True
    )
    vad = AutoModel(model="fsmn-vad", disable_update=True)
    load_s = time.time() - t0
    print(f"models loaded in {load_s:.1f}s")

    tracker = build_tracker(spk_model, args.device, HybridSpeakerTracker)
    session = SpeakerSession("bench", tracker, vad, SAMPLE_RATE)

    chunks, total_s = load_chunks(args.wav)
    print(f"{len(chunks)} chunks of {CHUNK_MS}ms ({total_s:.1f}s of audio) from {args.wav}")

    # Warm up: first call pays for CUDA context / cudnn algo selection, exclude it from the
    # steady-state number.
    warm = chunks[0]
    t0 = time.time()
    session.add_audio(warm)
    warm_s = time.time() - t0
    print(f"first (warmup) chunk: {warm_s*1000:.1f}ms")

    per_chunk_ms = []
    for c in chunks[1:]:
        t0 = time.time()
        session.add_audio(c)
        per_chunk_ms.append((time.time() - t0) * 1000)
    session.flush()

    arr = np.array(per_chunk_ms)
    print(f"\n{len(arr)} steady-state chunks (excludes warmup)")
    print(f"mean:   {arr.mean():.2f} ms")
    print(f"median: {np.median(arr):.2f} ms")
    print(f"p95:    {np.percentile(arr, 95):.2f} ms")
    print(f"p99:    {np.percentile(arr, 99):.2f} ms")
    print(f"max:    {arr.max():.2f} ms")
    heavy = arr[arr > 50]
    print(f"chunks > 50ms: {len(heavy)} of {len(arr)}, values: "
          f"{[round(x, 1) for x in sorted(heavy, reverse=True)]}")

    cost_per_chunk_s = arr.mean() / 1000
    cost_per_audio_s = cost_per_chunk_s / (CHUNK_MS / 1000)
    print(f"\nmean inference cost per second of audio: {cost_per_audio_s:.4f} s/s")
    if cost_per_audio_s > 0:
        print(f"implied concurrent-meeting ceiling (1 / cost-per-second-of-audio), mean-based: "
              f"{1 / cost_per_audio_s:.2f}")

    max_lock_hold_s = arr.max() / 1000
    print(f"max single lock hold observed: {max_lock_hold_s*1000:.1f} ms "
          f"(a concurrent session's chunk queues behind this when it lands mid-hold)")


if __name__ == "__main__":
    main()
