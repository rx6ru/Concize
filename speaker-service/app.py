# WebSocket server for speaker attribution. The contract lives in
# backend/src/providers/speaker/funasr.lane.js, this implements it.
#
#   connect   ws://host:8765/speaker?session=<id>&sample_rate=16000
#   client ->  binary frames of little endian 16 bit mono PCM
#   client ->  {"event":"flush"} | {"event":"end"} | {"event":"ping"}
#   server ->  {"event":"ready"}
#              {"event":"speaker","t0_ms":..,"t1_ms":..,"speaker":"3","confidence":"confident"}
#              {"event":"error","message":"..","fatal":true}

import argparse
import asyncio
import json
import logging
import os
import time
from urllib.parse import urlparse, parse_qs

import websockets

from speaker import SpeakerSession, build_tracker, SAMPLE_RATE

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("speaker-service")

# One GPU, one model. Inference runs in a worker thread so a slow segment does not block the
# event loop, and the lock keeps concurrent sessions from interleaving on the same model.
_lock = asyncio.Lock()
_models = {}


def load_models(device):
    from funasr import AutoModel
    from funasr.bin.realtime_ws import HybridSpeakerTracker

    log.info("loading models on %s", device)
    _models["spk"] = AutoModel(
        model="iic/speech_campplus_sv_zh-cn_16k-common", device=device, disable_update=True
    )
    _models["vad_factory"] = lambda: AutoModel(model="fsmn-vad", disable_update=True)
    _models["vad"] = _models["vad_factory"]()
    _models["tracker_cls"] = HybridSpeakerTracker
    _models["device"] = device
    log.info("models ready")


async def handle(ws):
    params = parse_qs(urlparse(ws.request.path).query)
    session_id = (params.get("session") or ["anon"])[0]
    sample_rate = int((params.get("sample_rate") or [SAMPLE_RATE])[0])

    if sample_rate != SAMPLE_RATE:
        await ws.send(json.dumps({
            "event": "error",
            "message": f"only {SAMPLE_RATE} Hz is supported, got {sample_rate}",
            "fatal": True,
        }))
        return

    tracker = build_tracker(_models["spk"], _models["device"], _models["tracker_cls"])
    session = SpeakerSession(session_id, tracker, _models["vad_factory"](), sample_rate)

    await ws.send(json.dumps({"event": "ready"}))
    log.info("session open: %s", session_id)
    started = time.time()

    try:
        async for message in ws:
            if isinstance(message, bytes):
                intervals = await run(session.add_audio, message)
            else:
                try:
                    event = json.loads(message).get("event")
                except json.JSONDecodeError:
                    continue
                if event == "ping":
                    continue
                if event in ("flush", "end"):
                    intervals = await run(session.flush)
                else:
                    continue
                if event == "end":
                    for i in intervals:
                        await ws.send(json.dumps(i))
                    break

            for interval in intervals:
                await ws.send(json.dumps(interval))

    except websockets.ConnectionClosed:
        pass
    except Exception as err:                                  # noqa: BLE001
        log.exception("session %s failed", session_id)
        try:
            await ws.send(json.dumps({"event": "error", "message": str(err), "fatal": True}))
        except websockets.ConnectionClosed:
            pass
    finally:
        log.info("session closed: %s after %.1fs %s",
                 session_id, time.time() - started, session.stats())


async def run(fn, *args):
    """Tracker inference is blocking and GPU bound, so it goes to a thread behind the lock."""
    async with _lock:
        return await asyncio.to_thread(fn, *args)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("SPEAKER_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("SPEAKER_PORT", 8765)))
    ap.add_argument("--device", default=os.environ.get("SPEAKER_DEVICE", "cuda:0"))
    args = ap.parse_args()

    load_models(args.device)

    async with websockets.serve(handle, args.host, args.port, max_size=2 ** 22):
        log.info("listening on ws://%s:%d/speaker", args.host, args.port)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
