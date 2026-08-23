# Concize

Real-time meeting intelligence for Indian-language and code-mixed speech. Audio streams in over a WebSocket, comes back as an attributed transcript while the meeting is still running, and can be queried by chat with citations back to who said what and when.

Built for the case most meeting tools handle badly: several people, Hinglish, long sessions, and speakers talking over each other. Leading English ASR models score 28-51% word error rate on Indian-language benchmarks, which makes the downstream summary and chat unusable no matter how good the LLM is.

Two parts live here: the Node backend (`backend/`) and a Chrome extension that captures tab and microphone audio (`frontend/`). Speaker attribution runs as a separate Python service (`speaker-service/`) and is optional.

## How it works

One audio stream is fanned out to independent recognisers and their output is joined on a shared timeline. A slow or dead recogniser costs one capability, not the meeting.

```
  chrome extension
        │  16 kHz mono PCM, 100 ms frames, uint32 sequence prefix
        ▼
  ws /rt ──► gateway ──┬──► words lane     Sarvam saaras:v3-realtime
   (auth on the        │
    HTTP upgrade)      └──► speaker lane   FunASR CAM++  (optional)
                                 │
                          timeline fusion
                                 │  words outrank speakers
                                 ▼
                  utterances  (append-only, Postgres)
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
              chunking      summary worker   watermark
                  │
              embedding ──► Qdrant ──► retrieval ──► chat (SSE)
```

Text is emitted the moment it is final, with `speaker: null` if attribution is not known yet. When the speaker lane catches up, the client gets a `revision` rather than the text having been delayed. Nothing is updated in place: a correction writes a new revision of the utterance and supersedes the old one in the same transaction, so a reader always sees exactly one current row per turn and every derived artefact can be rebuilt by replaying the log.

After the meeting a batch pass re-transcribes the recording, which sees the whole thing at once and beats the streaming pass, and corrects the live record.

## Status

A working system, not a deployed product. There are no users and no uptime to report.

| Area | State |
|---|---|
| Live capture, streaming ASR, timeline fusion | working |
| Append-only transcript log, revisions | working |
| Chunking, embedding, vector search | working |
| Retrieval, citations, injection screening | working |
| Speaker attribution service | working, wants a GPU to be useful |
| Incremental summarisation | working |
| Session audio retention | working, opt in via RECORDING_DIR |
| Accounts, sign up and sign in | working, tokens issued locally or by Supabase |
| Rate limits, session cap, daily cost breaker | working |
| Post-meeting reconciliation | modules built, not scheduled |
| Indic speaker models | not built, and this is the main gap |
| One-to-one sharing, grant and revoke | working |
| Teams, billing, per-user quotas | not built |
| Extension UI: summary, transcript, chat, share, delete | working |
| Hybrid retrieval (dense + lexical, RRF fused) | working |
| Cross-encoder reranking | not built |
| Layer 2 narrative chunks | working |
| Layer 3 topic chunks | not built |
| Overlapping-speech detection | working, pyannote segmentation in the speaker service |

## Quick start

Needs Node 20+, Docker, and keys for Sarvam (transcription), Groq or Cerebras (chat) and Gemini (embeddings).

```sh
git clone https://github.com/rx6ru/Concize.git
cd Concize

# postgres, qdrant and rabbitmq, on offset ports so they do not clash
docker compose -f docker-compose.dev.yml up -d
docker cp backend/src/infra/schema.sql concize-pg:/tmp/schema.sql
docker exec concize-pg psql -U postgres -d concize -f /tmp/schema.sql

cd backend
npm install
cp .env.example .env      # fill in the keys, see Configuration
npm start
```

The server refuses to start if Postgres, RabbitMQ or Qdrant are unreachable, so a clean boot means the stack is actually wired up:

```
info [systemCheck] Binaries verified (ffmpeg: .../ffmpeg)
info [systemCheck] Postgres connection verified
info [systemCheck] RabbitMQ connection verified
info [systemCheck] Qdrant connection verified
info [server]      Server is running on port 3000
info [chunkSearch] Chunk collection created {"collection":"concize_chunks"}
```

Load `frontend/` as an unpacked extension from `chrome://extensions` to capture audio, or drive the WebSocket directly (see Protocol).

With `AUTH_MODE=hs256` the backend issues its own tokens, so `POST /api/v1/auth/signup` is all that stands between a fresh checkout and a recorded meeting. `AUTH_MODE=jwks` delegates to Supabase instead and those routes are not mounted, because two sources of identity is worse than one.

### Speaker attribution

Separate and optional, because it wants a GPU:

```sh
cd speaker-service
python -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python app.py --device cuda:0 --port 8765
```

Then set `SPEAKER_SERVICE_URL=ws://127.0.0.1:8765/speaker`. Without it, meetings transcribe normally and every turn comes back unattributed rather than guessed.

## Configuration

Provider and model are chosen per task, so transcription can run on Sarvam while chat runs on Groq without touching code.

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_URL` | - | required |
| `QDRANT_URL`, `QDRANT_API_KEY` | - | required |
| `CLOUDAMQP_URL` | - | required, summary worker queue |
| `TRANSCRIPTION_PROVIDER` / `_MODEL` | `sarvam` / `saaras:v1` | `groq` also supported |
| `CHAT_PROVIDER` / `CHAT_MODEL` | `cerebras` / `llama3.1-8b` | `groq`, `openrouter`, `sarvam` also supported |
| `CHAT_CONTEXT_TOKENS` | derived from the model | pin it, or a million-token model hands retrieval a million-token budget |
| `SUMMARY_PROVIDER`, `CLEAN_PROVIDER` | `cerebras` | same set |
| `SPEAKER_SERVICE_URL` | unset | unset disables attribution |
| `HF_TOKEN` | unset | unset disables overlap detection |
| `AUTH_MODE` | `jwks` | `hs256` issues tokens here and needs no identity provider |
| `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER` | - | required in `hs256` mode |
| `SUPABASE_JWKS_URI`, `SUPABASE_JWT_ISSUER` | - | required in `jwks` mode |
| `REDIS_URL` | unset | rate limits fail open without it |
| `PGSSL` | on | set to `disable` for a local container |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | |

API keys accept a comma-separated list (`GROQ_API_KEYS`, `GEMINI_API_KEYS`, `SARVAM_API_KEYS`) and are rotated per call. See `backend/.env.example` for the full set.

## Protocol

### WebSocket

```
ws://host:3000/rt?token=<supabase jwt>&meetingId=<id>
```

Authorisation happens on the HTTP upgrade, before a socket exists. A meeting owned by someone else is rejected with 404 rather than 403, so the API never confirms that it exists.

The client sends binary frames of 16 kHz mono little-endian PCM, each prefixed with a big-endian uint32 sequence number. The session clock comes from that sequence rather than arrival time, so the lanes agree on timestamps under network jitter.

```jsonc
{"type":"session.ready","meetingId":"..."}
{"type":"partial","turnId":12,"text":"we should revisit"}       // volatile, never attributed
{"type":"final","turnId":12,"text":"we should revisit pricing","t0":65000,"t1":70000,
 "speaker":null,"confidence":"unknown","overlap":false}
{"type":"revision","turnId":12,"speaker":"S3","confidence":"confident"}
{"type":"watermark","watermarkMs":70000,"lagMs":420}
{"type":"lane.status","lane":"speaker","status":"down","reason":"..."}
```

Send `{"event":"stop"}` to end the meeting cleanly and flush the trailing chunk.

### REST

Everything is under `/api/v1` and needs a bearer token. Ownership is enforced per resource.

```
POST /auth/signup                 create an account, returns a token   (hs256 mode only)
POST /auth/login                  exchange credentials for a token     (hs256 mode only)
POST /meetings                    create a meeting
GET  /meetings/:id/transcript     current transcript
POST /meetings/:id/chat           ask a question, answer streams back over SSE
GET  /meetings/:id/summary        running summary
GET  /health
GET  /metrics                     prometheus, mounted before auth
```

Chat and meeting creation are rate limited per user, and a daily cost breaker refuses calls once the day's recorded provider spend crosses what `provider.limits.json` says the account has. Limits fail open if Redis is unreachable; the cost breaker refuses.

## Layout

```
backend/src/
  realtime/      gateway, session clock, timeline fusion
  transcript/    utterance log, chunk boundaries, derive and embed workers, reconciliation
  chat/          retrieval pipeline, vector search, context assembly, chat controller
  meetings/      meeting lifecycle
  summary/       incremental summarisation
  providers/     llm/ stt/ speaker/ embedding/, one adapter per vendor
  safety/        guardrails, relevance filter, prompt-injection screening
  infra/         postgres, redis, queue, storage, qdrant, schema.sql
  http/          middleware and versioned routes
  core/          config, logger, metrics, request context
speaker-service/ python diarization service
frontend/        chrome extension (MV3)
```

Files are named `<subject>.<role>.js`, so a directory listing tells you what each thing is.

## Design notes

The decisions worth knowing about, and the measurements behind them.

**Chunk boundaries are rules, not an LLM call.** A chunk closes on speaker turn + silence gap + semantic shift, with a token and duration cap as backstop. It runs on every utterance on the live path, and it has to be deterministic or replaying the log stops rebuilding the same chunks.

**Retrieval fuses on rank, not score.** Cosine similarity and lexical rank live on incompatible scales, and normalising them to combine quietly favours one engine. Reciprocal rank fusion only uses each engine's ordering. Recent speech is retrieved as its own lane and never trimmed by `topN`, because during a live meeting most questions are about what was just said.

**The lexical lane is Postgres full text search, indexed `simple` rather than `english`.** Stemming mangles code-mixed speech, and exact tokens are the point: names, ticket ids, product codes are what dense embeddings smear. It also contributes something dense retrieval cannot, which is absence. Asked for a ticket id that was never mentioned, the dense lane still returns its nearest chunk at cosine 0.52 while the lexical lane correctly returns nothing.

**Uncertainty reaches the prompt.** Every turn carries whether its speaker is `confident`, `provisional` or `unknown`, and overlapping audio is marked. The context block renders both inline and the instructions tell the model to hedge rather than name someone. Incomplete answers are acceptable, confidently wrong ones are not.

**Retrieved transcript is flagged, not dropped.** Anyone in a meeting can say "ignore your previous instructions" out loud and it lands verbatim in retrieved context. Measured on `llama-prompt-guard-2-86m`, a benign meeting line ("so the fix is to ignore untrusted instructions from the transcript") scores 0.9995 and a real attack scores 0.9996. No threshold separates them, so screening marks lines and the defence lives in the prompt structure instead. User questions are still blocked outright, where the same model is clean.

**The speaker threshold is 0.70, not the library default of 0.60.** Measured on an L40S against LibriSpeech ground truth with 40-speaker sessions: 0.60 gives 0.854 turn accuracy, 0.70 gives 0.942, and latency is flat across the sweep. The roster cap is set far above any real meeting because when it fills the matcher stops applying its threshold and force-matches to the nearest centroid (cosine 0.3185 accepted against 0.6), merging two people into one id with nothing downstream able to tell. Adaptive score normalisation measured worse at every setting and is not used.

## What the measurements say

Numbers come from AMI meeting audio with human transcripts, and from Indic DiarBench for Hindi. The harness lives outside this repo. Every design note above that cites a number cites one of these.

| Measured | Consequence |
|---|---|
| Overlap derived from diarization segments scores 23.6% F1. A dedicated model scores 69.2%. | Deriving it was abandoned. A clustering backend puts one speaker on a segment, so two people talking at once inside a segment is invisible and there is nothing to intersect. |
| The streaming detector scores 63.3% F1 against 63.4% for the same model run offline. | What ships is what was measured. Holding back one model window at the buffer edge costs latency but recovers 12 points of recall. |
| Live speaker attribution: 34.4% word-weighted error. Sarvam's batch diarization on the same audio: 55.0%. | The batch pass corrects wording but no longer overwrites speakers. It used to. |
| 16 speakers across 91 minutes: 30.9% error, against 34.4% on four-speaker meetings. | Accuracy does not fall off with speaker count. Over-segmentation is cheap; confusing two people is not. |
| Hindi speaker error is 61.0% against 34.4% on English, and 65.9% on genuinely code-mixed audio. | The VAD and the embedding model are both Chinese (`fsmn-vad`, `campplus_sv_zh-cn`). The 61.0% was measured on a formal literary interview that is only 8.5% code-mixed; the product records something closer to 26%, where this pipeline does worse, not better. |
| Two identical runs, nothing changed, differ by 11.1 points of claim coverage. | This is the noise floor, measured on one model. Any result smaller than it is resampling, and several earlier conclusions were. |
| Changing the answering model is worth 15.1 points. A human transcript, corrected speaker attribution and supplied speaker roles all moved less than that. | Whether they moved less than *noise* is unproven: the floor was measured on a different model and provider than those three were. Re-deriving it is blocked on a daily embedding quota, not on effort. |
| Evidence coverage in retrieved context: 72.7% for wrong answers, 72.1% for right ones. | Retrieval is not the bottleneck. A reranker was planned and then dropped on this result. |
| The grading judge agreed with itself on 29.2% of identical answers before it was rebuilt; claim-level grading with a per-claim majority now agrees 24/24. | Every number above is only as good as the instrument. An unvalidated judge produced two wrong conclusions here. |
| Layer 2 summaries took 68% of the context budget on a 71-minute meeting. | Capped per layer. They rank well because they read like the question, and cost three times a verbatim chunk. |

An earlier version of this table claimed a human transcript was worth 21 to 36 points of answer accuracy. That came from comparing two gradings by an instrument that did not agree with itself. Re-graded it fell to -0.4, and that figure is not trustworthy either: the arm it was measured on could not run, because a whole transcript plus an answer allowance exceeds an 8k model's request ceiling and 27 of 48 requests returned 413.

On a model large enough to hold the transcript, pasting it whole scores 66.6% claim coverage against retrieval's 58.3%, a gap that sits under the noise floor. **The honest position is that the transcript question is open**, and that pasting a whole meeting does not scale past a short one on any normal-context model regardless.

The Hindi row is the one that changed plans. Swapping only the VAD drops the segmentation floor by 8 to 16 points on every corpus tested and still makes speaker error worse, because shorter segments hand the Chinese embedding model less audio per segment and it starts inventing speakers. On ES2004a it goes from 10 hypothesis speakers to 18. Both models have to be replaced in one step. A Silero adapter is committed and deliberately left switched off for that reason, with the numbers in its header.

## Limitations

- Answers cover 58.3% of the claims in a human reference, 7 of 23 fully. That is the number to
judge this on, and it is not yet good enough to sell.
- The extension records end to end in a real browser: Chrome, the offscreen AudioWorklet, the
WebSocket, and utterances persisted, with live text in the popup. What is still unproven is real
*tab* audio, since chrome.tabCapture cannot open a device in a headless environment; that run
proves the microphone half of the same mixing graph.
- Summary quality has never been measured. A harness exists and is waiting on a complete summary.

- About one turn in seventeen is still attributed to the wrong speaker at 40 speakers, and 6 of
40 identities hold more than one person. That is why confidence travels with the data.
- The speaker tracker is sensitive to where the stream starts. Losing the first 300 ms took it
from 15 speaker centres to 1 in testing. The lane holds audio until the service connects now, but the underlying fragility is upstream.
- Sarvam's realtime API does not diarize, which is why speakers are a separate lane at all.
- Batch transcription caps a file at 2 hours, so longer meetings are cut into overlapping
segments and stitched. A speaker silent through an overlap window appears as a new identity in the following segment.

## Tests

```sh
cd backend && npm test                                # 933 tests, no network or GPU needed
cd backend && npm run test:pg                         # 18 more, needs the docker-compose Postgres
node --test 'frontend/tests/*.test.js'                # 60, the capture protocol and the sanitizer
cd speaker-service && .venv/bin/python test_speaker.py && .venv/bin/python test_overlap.py   # 23
```

CI runs the first three on every push; the speaker tests load real models and stay local.

Database tests run against `pg-mem`, and the live pipeline test drives a real WebSocket through the gateway, fusion, the transcript log and chunk derivation. Note that pg-mem applies a partial index without its predicate, which is why the schema uses composite indexes instead.
