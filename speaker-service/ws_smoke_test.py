# Throwaway smoke test client. NOT part of the service, not imported anywhere.
# Streams real 16kHz mono PCM from a wav file to the running speaker-service over the real
# websocket protocol and reports what comes back, plus per-chunk timing for session.add_audio
# (read from the server's own log line format is not available here, so this measures wall
# clock round trip per 200ms chunk sent while a response is pending vs not — see README note
# printed at the end for how the per-chunk *inference* cost was isolated separately).
#
# Usage: .venv/bin/python ws_smoke_test.py <path-to-wav> [ws://host:port/speaker]

import asyncio
import json
import sys
import time
import wave

import websockets

CHUNK_MS = 200


async def main():
    wav_path = sys.argv[1]
    url = sys.argv[2] if len(sys.argv) > 2 else "ws://127.0.0.1:8765/speaker"

    w = wave.open(wav_path, "rb")
    assert w.getframerate() == 16000, f"expected 16kHz, got {w.getframerate()}"
    assert w.getnchannels() == 1, f"expected mono, got {w.getnchannels()} channels"
    assert w.getsampwidth() == 2, f"expected 16-bit PCM, got {w.getsampwidth()*8}-bit"

    chunk_frames = 16000 * CHUNK_MS // 1000
    chunks = []
    while True:
        data = w.readframes(chunk_frames)
        if not data:
            break
        chunks.append(data)
    print(f"loaded {len(chunks)} chunks of {CHUNK_MS}ms from {wav_path} "
          f"({w.getnframes() / 16000:.1f}s total)")

    session_url = f"{url}?session=smoke-{int(time.time())}&sample_rate=16000"
    events = []
    chunk_send_times = []

    async with websockets.connect(session_url, max_size=2 ** 22) as ws:
        ready = json.loads(await ws.recv())
        assert ready.get("event") == "ready", ready
        print("ready:", ready)

        async def receiver():
            async for msg in ws:
                data = json.loads(msg)
                data["_recv_wall"] = time.time()
                events.append(data)
                if data.get("event") == "speaker":
                    print("speaker event:", json.dumps({k: v for k, v in data.items() if not k.startswith("_")}))
                elif data.get("event") == "overlap":
                    print("overlap event:", json.dumps({k: v for k, v in data.items() if not k.startswith("_")}))
                elif data.get("event") == "error":
                    print("ERROR event:", data)

        recv_task = asyncio.create_task(receiver())

        stream_start = time.time()
        for chunk in chunks:
            t0 = time.time()
            await ws.send(chunk)
            chunk_send_times.append(t0)
            await asyncio.sleep(0)  # yield, do not throttle to real time — push as fast as accepted

        await ws.send(json.dumps({"event": "end"}))

        # Drain until the server closes the connection after "end".
        try:
            await asyncio.wait_for(recv_task, timeout=60)
        except asyncio.TimeoutError:
            recv_task.cancel()
        stream_end = time.time()

    speaker_events = [e for e in events if e.get("event") == "speaker"]
    overlap_events = [e for e in events if e.get("event") == "overlap"]
    error_events = [e for e in events if e.get("event") == "error"]

    print(f"\nsent {len(chunks)} chunks ({len(chunks) * CHUNK_MS / 1000:.1f}s of audio) "
          f"in {stream_end - stream_start:.2f}s wall clock")
    print(f"received {len(speaker_events)} speaker events, {len(overlap_events)} overlap events, "
          f"{len(error_events)} error events")

    if speaker_events:
        first = speaker_events[0]
        print(f"\nfirst speaker event: t0_ms={first['t0_ms']} t1_ms={first['t1_ms']} "
              f"speaker={first['speaker']!r} confidence={first['confidence']}")
        plausible = 0 <= first["t0_ms"] < first["t1_ms"]
        print(f"plausible t0/t1: {plausible}")

    if error_events:
        print("\nerrors seen:")
        for e in error_events:
            print(" ", e)


if __name__ == "__main__":
    asyncio.run(main())
