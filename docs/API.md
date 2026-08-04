# API

Everything a client needs to build against Concize. Two surfaces: a REST/SSE API for meeting
management and chat, and a WebSocket for the live audio session.

Nothing here requires reading backend source. If something is ambiguous, that is a bug in this
document — raise it rather than reading the implementation.

- Base URL: `http://localhost:3000` in development
- All request and response bodies are JSON unless stated otherwise
- All timestamps in payloads are **milliseconds from session start**, not wall clock

---

## Authentication

A Supabase access token, sent as `Authorization: Bearer <token>`.

The same token authenticates the WebSocket, where it travels as a `token` query parameter because
browsers cannot set headers on a WebSocket handshake.

> **Note for whoever owns auth:** the WebSocket token is the full-lifetime access token in a URL
> query string, which lands in server logs, proxy logs and browser history. A short-lived
> single-use ticket minted by a REST endpoint would be better. Not built yet — flagged so nobody
> assumes the current behaviour is deliberate.

Meetings are owned. A request for a meeting you do not own returns **404**, never 403 — the API
never confirms that another user's meeting exists. Treat 404 on a meeting route as "gone or not
yours" and do not distinguish the two in the UI.

---

## REST

### `POST /api/v1/meetings`

Create a meeting owned by the caller. Call this first; everything else needs the `meetingId`.

**Request:** no body.

**201**
```json
{
  "success": true,
  "meetingId": "a3f1c9e2-...",
  "jobId": "a3f1c9e2-...",
  "message": "New meeting session initiated."
}
```

`jobId` is a deprecated alias for `meetingId` and will be removed. Use `meetingId`.

**401** if unauthenticated. **500** on failure.

---

### `GET /api/v1/meetings`

The caller's own meetings, newest first. Everything needed for a list view.

**Query:** `limit` (default 50, max 100).

**200**
```json
{
  "success": true,
  "meetings": [
    {
      "meetingId": "a3f1c9e2-...",
      "status": "completed",
      "createdAt": "2026-08-09T14:02:11.000Z",
      "title": "Q3 pricing review"
    }
  ]
}
```

`title` comes from the summary and is `null` until one has been generated — expect `null` for a
meeting that has just started, and render a placeholder rather than an empty string.

**401** if unauthenticated.

---

### `DELETE /api/v1/meetings/:meetingId`

Permanently deletes a meeting and everything derived from it: transcript, chunks, chat history,
summary, and the search index entries. **Not reversible, and there is no soft delete** — confirm in
the UI before calling.

**204** with no body on success.

**404** if the meeting is gone or is not yours.

**500** `{"error": "Failed to delete the meeting. Nothing was removed."}` — the delete is atomic
enough to retry: it removes the search index first and only then the database rows, so a failure
leaves the meeting intact rather than half-deleted. Safe to call again.

---

### `GET /api/v1/meetings/:meetingId/transcript`

The stored transcript. Useful for a post-meeting view; during a live meeting the WebSocket is the
source of truth and is far ahead of this.

**200** — the transcript document. **404** if the meeting has no transcript, or is not yours.

---

### `GET /api/v1/meetings/:meetingId/summary`

The rolling summary. It updates continuously during the meeting, so poll it (every 20–30s is
plenty) or refresh it on demand.

**200**
```json
{
  "success": true,
  "summary": {
    "title": "Q3 pricing review",
    "content": "The team agreed to ...",
    "status": "updating",
    "updatedAt": "2026-08-09T14:02:11.000Z"
  }
}
```

`status` is one of `updating`, `done`. A summary that does not exist yet returns **404** with
`{"success": false, "error": "Summary not found for this meeting"}` — expected early in a meeting,
so render an empty state rather than an error.

---

### `POST /api/v1/meetings/:meetingId/chat`

Ask a question about the meeting. **Responds with Server-Sent Events, not JSON** — see below.

**Request**
```json
{ "userPrompt": "What did they decide about pricing?" }
```

**400** `{"error": "userPrompt is required."}` if missing.

#### Errors arrive two different ways

This is the one part of the contract that needs care.

**Before the stream opens**, failures are a normal JSON response with an HTTP status:

```json
{ "error": { "type": "off_topic", "code": "QUERY_NOT_RELEVANT", "message": "..." } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `PROMPT_INJECTION` | The question looks like an attempt to change how the assistant works |
| 400 | `QUERY_NOT_RELEVANT` | Not a question about this meeting |
| 400 | *(input guard)* | Failed input validation |
| 429 | `TEMPORARILY_BLOCKED` | Too many blocked requests on this meeting |
| 429 | `RATE_LIMIT_EXCEEDED` | Upstream model is rate limited |
| 401 | `UNAUTHORIZED` | |
| 503 | `SERVICE_TIMEOUT` | Upstream unreachable |
| 500 | `INTERNAL_SERVER_ERROR` | |

**After the stream opens**, the status is already 200, so a failure arrives as an SSE `error`
event instead. Handle both paths or a mid-stream failure will look like a silent truncation.

#### The SSE stream

Headers: `text/event-stream`, `X-Accel-Buffering: no`.

**Answer text** — the normal case, many of these:
```
data: {"text":"They agreed to "}
```
Concatenate `text` in arrival order.

**Blocked output** — the answer tripped an output guard mid-stream:
```
data: {"blocked":true,"replace":"I apologize, but I couldn't generate a helpful response. ..."}
```
**Discard everything already rendered** for this answer and show `replace` instead. Some of the
offending text has already reached you by the time this arrives; that is inherent to streaming.

**Error**:
```
event: error
data: {"code":"RATE_LIMIT_EXCEEDED","message":"..."}
```

**Heartbeat** — a comment line, sent while waiting on the model so proxies do not time the
connection out. `EventSource` ignores it; a hand-rolled parser must too:
```
:heartbeat
```

**End of stream:** the connection closes. There is **no `[DONE]` sentinel** — treat close as the
terminator.

> `EventSource` cannot send a POST body, so use `fetch` with a streaming reader, or an SSE client
> that supports POST.

---

## WebSocket — live meeting

```
ws://localhost:3000/rt?meetingId=<meetingId>&token=<supabase access token>
```

Rejection happens at the HTTP upgrade, before a socket exists, so it arrives as an ordinary HTTP
response, not a close code: **401** bad token, **404** meeting missing or not yours, **400** no
`meetingId`. Once connected, the only close code the server originates is **4500** (a lane failed
and the session cannot continue).

### Client → server

**Audio: binary frames, each one a 4-byte big-endian uint32 sequence number followed by the PCM.**

```
[ uint32 BE sequence ][ raw little-endian 16-bit mono PCM @ 16 kHz ]
```

The sequence number is not optional — a frame shorter than 5 bytes, or without it, is **silently
dropped**. It exists so the session clock survives reordering and can detect loss. Start at 0 and
increment by one per frame.

The payload is raw PCM: not Opus, not WebM. Capture with an `AudioWorkletProcessor`;
`MediaRecorder` output will not work. Send roughly 100 ms per frame. A sample-rate mismatch does
not error — it produces garbled transcription, so resample to exactly 16 kHz client-side.

**Do not drop the opening frames.** Losing the first ~300 ms of a session was measured to collapse
speaker tracking from 15 distinct speakers to 1, because the diarizer's internal chunking is
aligned to the start of the stream. Begin sending as soon as the socket opens.

**Control:** JSON text frames. Exactly one is understood:
```json
{ "event": "stop" }
```
Anything else parses and is ignored. Malformed JSON returns
`{"type":"error","code":"bad_message","fatal":false}` and the session continues.

Closing the socket also ends the session cleanly, so `stop` is a courtesy rather than a
requirement — but send it, because it lets the server finalise before the socket drops.

### Server → client

Every message is JSON with a `type`.

| `type` | When | Payload |
|---|---|---|
| `session.ready` | Once, on connect | `{ meetingId }` |
| `partial` | Continuously, volatile | Live text for the overlay |
| `final` | Utterance finished | The authoritative utterance |
| `revision` | Late attribution arrived | Replaces an earlier `final` |
| `watermark` | After each `final` | How far the indexed transcript reaches |
| `lane.status` | A lane went up or down | `{ lane, status, reason? }` |
| `error` | Something failed | `{ code, fatal }` |

`partial`, `final` and `revision` share one shape:

```json
{
  "type": "final",
  "turnId": "1723200412345",
  "text": "we should revisit pricing before the next cycle",
  "t0": 65000,
  "t1": 70000,
  "speaker": "S2",
  "confidence": "confident",
  "overlap": false,
  "overlapRatio": 0
}
```

- `speaker` is `null` when unattributed. **On `partial` it is always `null`** — partials are never
  attributed. Do not render a speaker on a partial.
- `confidence` is `confident` | `provisional` | `unknown`. Consider showing `provisional` and
  `unknown` differently; the label may change.
- `overlap` means people were talking over each other. `overlapRatio` is how much of the span was
  contested. Worth surfacing, because attribution is least reliable exactly there.

### The three behaviours a client must get right

**1. `revision` rewrites history.** Text is never held back waiting for speaker attribution — it is
emitted immediately with `speaker: null` or a provisional label, and corrected afterwards. Key your
rendered transcript by `turnId` and replace in place when a `revision` arrives for a `turnId`
already on screen. A client that appends revisions will duplicate lines.

**2. `partial` is replaced, not appended.** Each `partial` supersedes the previous one for the
in-progress utterance. When the `final` arrives, drop the partial and render the final.

**3. `lane.status` is not fatal.** The speaker lane can go down while transcription continues
perfectly — words outrank speakers by design. On `{ lane: "speaker", status: "down" }`, keep
rendering text and stop showing speaker labels. Do not tear down the session.

### Typical flow

```
GET  /api/v1/meetings                    → list view
POST /api/v1/meetings                    → meetingId
open ws /rt?meetingId=…&token=…          → session.ready
stream PCM frames (seq-prefixed)         ← partial / final / revision / watermark
poll GET …/summary every ~30s            → running summary
POST …/chat  (SSE)                       ← answer text
send {"event":"stop"}, close socket
GET  …/transcript                        → the stored transcript, after the meeting
DELETE /api/v1/meetings/:meetingId       → permanent
```

---

## Not built yet

So nobody builds UI against something that does not exist:

- **No transcript pagination** — `GET …/transcript` returns the whole document. A three-hour
  meeting is a large response; assume it is slow and do not call it on a timer.
- **No WebSocket resume.** Reconnecting starts a new session; audio buffered during a drop is not
  replayed, and speaker attribution degrades after a reconnect.
- **No overlap lane.** `overlap` and `overlapRatio` are in the contract and currently always
  `false` / `0`. The field is stable; the data is not there yet.
- **No speaker naming.** Speakers are `S1`, `S2`, … and cannot be renamed.
