# speaker-service

Speaker attribution for live meetings. Takes PCM over a WebSocket, returns speaker intervals.

The backend treats this as optional. If it is not running, meetings still transcribe, they just
come out unattributed. See `backend/src/providers/speaker/funasr.lane.js` for the client side,
which is the contract this implements.

## Running it

```bash
python -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python app.py --device cuda:0 --port 8765
```

Models download on first run (CAM++ speaker verification, ~28MB, and fsmn-vad, ~2MB). CPU works
but is slow enough that you will notice; the numbers below are from an L40S.

Point the backend at it with `SPEAKER_SERVICE_URL=ws://host:8765/speaker`.

## Protocol

```
connect   ws://host:8765/speaker?session=<id>&sample_rate=16000
client ->  binary frames of little endian 16 bit mono PCM
client ->  {"event":"flush"} | {"event":"end"} | {"event":"ping"}
server ->  {"event":"ready"}
           {"event":"speaker","t0_ms":0,"t1_ms":1500,"speaker":"3","confidence":"confident"}
           {"event":"error","message":"...","fatal":true}
```

`confidence` is one of `confident`, `provisional`, `unknown`. It is not decoration: the backend
carries it through retrieval and the chat prompt hedges rather than naming someone on a weak
attribution.

## Why the constants are what they are

`speaker.py` holds them with the measurements attached. The short version, from sweeps on an
L40S against LibriSpeech ground truth with 40 speaker sessions:

| Setting | Value | Why |
|---|---|---|
| `THRESHOLD` | 0.70 | 0.60 scored 0.854 turn accuracy, 0.70 scored 0.942, and latency was flat across the whole sweep |
| `MAX_SPEAKERS` | 500 | when the roster fills, the matcher stops applying the threshold and force matches to the nearest centroid (cosine 0.3185 accepted against 0.6), silently merging two people into one id |
| `MAX_NUM_SPKS` | 30 | per window clustering hint |
| `MAX_HISTORY_CHUNKS` | 384 | embedding history kept per session |
| `COLD_START_MS` | 15000 | the tracker needs ~20 chunks before its assignment means anything, measured at 8.6 to 15.0s of speech |

Adaptive score normalisation (AS-norm) was tested across 6 tau values and 2 scenarios and was
worse than the plain threshold every time (0.9240 against 0.9417), for about 30ms more p95. It
is not used.

At the shipped settings, 40 speakers gives 0.942 turn accuracy with 34 distinct ids, and 6 ids
still hold more than one person. That residual is why `confidence` exists.

## Tests

```bash
python test_speaker.py      # or: pytest
```

Covers segment handling, confidence banding, and buffer trimming with fakes in place of the
models, so it runs anywhere in a second.
