-- Canonical Postgres schema for Concize (Supabase Postgres).
-- owner_id (Supabase user id) is the source of ownership; chats and meeting_summaries derive
-- theirs via the job_id FK instead of storing it directly.
--
-- Apply locally: psql "$POSTGRES_URL" -f src/infra/schema.sql
-- Or via Supabase CLI: put it under supabase/migrations/ and run `supabase db push`.

CREATE TABLE IF NOT EXISTS meetings (
    job_id     text PRIMARY KEY,
    owner_id   text NOT NULL,
    status     text NOT NULL DEFAULT 'in-progress'
                  CHECK (status IN ('in-progress', 'completed', 'completed_with_errors')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_owner_id_idx ON meetings (owner_id);

-- Transcript chunks, normalized (one row per chunk) and ordered by chunk_index.
CREATE TABLE IF NOT EXISTS transcription_chunks (
    job_id      text NOT NULL REFERENCES meetings (job_id) ON DELETE CASCADE,
    chunk_index integer NOT NULL,
    text        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS chats (
    id         text PRIMARY KEY,                 -- app-generated uuid (crypto.randomUUID)
    job_id     text NOT NULL REFERENCES meetings (job_id) ON DELETE CASCADE,
    user_chat  text NOT NULL,
    ai_chat    text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chats_job_id_created_idx ON chats (job_id, created_at);

CREATE TABLE IF NOT EXISTS meeting_summaries (
    job_id                     text PRIMARY KEY REFERENCES meetings (job_id) ON DELETE CASCADE,
    title                      text NOT NULL DEFAULT '',
    content                    text NOT NULL DEFAULT '',
    word_limit                 integer NOT NULL DEFAULT 500,
    last_processed_chunk_index integer NOT NULL DEFAULT -1,
    version                    integer NOT NULL DEFAULT 0,
    status                     text NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'updating', 'complete', 'error')),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- Append-only transcript log, the system of record for real-time meetings.
--
-- Never UPDATE a row here. Streaming ASR rewrites its own output, and diarizers retro-correct
-- speaker labels once later audio disambiguates a voice, so a correction is a new revision that
-- supersedes the old one instead of replacing it. Keeping both means we can answer "what did
-- the system believe at 14:32, and what changed", and any derived table can be rebuilt by replay.
CREATE TABLE IF NOT EXISTS utterances (
    meeting_id         text NOT NULL REFERENCES meetings (job_id) ON DELETE CASCADE,
    turn_id            text NOT NULL,               -- stable across revisions of the same turn
    rev                integer NOT NULL DEFAULT 0,
    seq                bigint  NOT NULL,            -- append order, monotonic per meeting
    t0_ms              integer NOT NULL,            -- session-relative, from the frame clock
    t1_ms              integer NOT NULL,
    text               text NOT NULL,
    speaker_label      text,                        -- null = no attribution; never invent one
    speaker_confidence text NOT NULL DEFAULT 'unknown'
                          CHECK (speaker_confidence IN ('confident', 'provisional', 'unknown')),
    overlap            boolean NOT NULL DEFAULT false,
    overlap_ratio      real    NOT NULL DEFAULT 0,
    source             text    NOT NULL DEFAULT 'live-fusion'
                          CHECK (source IN ('live-fusion', 'batch', 'manual')),
    superseded_by      integer,                     -- rev that replaced this row; null = current
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, turn_id, rev)
);
-- Reading the current transcript in order is the hot path.
-- Composite rather than partial (`WHERE superseded_by IS NULL`): pg-mem, which the DB tests
-- run against, applies a partial index without its predicate and returns wrong rows with no
-- error. A composite index is portable and nearly as selective here.
CREATE INDEX IF NOT EXISTS utterances_current_idx ON utterances (meeting_id, superseded_by, seq);

-- Derived retrievable chunks. Rebuildable from `utterances` by replay, so nothing here is
-- precious, but a chunk is never mutated in place. A correction bumps `rev` and re-embeds,
-- since a reader mid-query needs to see one consistent version.
--
-- `layer`: 1 = verbatim speaker-labelled, 2 = narrative rewrite, 3 = topic node.
CREATE TABLE IF NOT EXISTS chunks (
    meeting_id     text NOT NULL REFERENCES meetings (job_id) ON DELETE CASCADE,
    layer          integer NOT NULL CHECK (layer BETWEEN 1 AND 3),
    ordinal        integer NOT NULL,
    rev            integer NOT NULL DEFAULT 0,
    t0_ms          integer NOT NULL,
    t1_ms          integer NOT NULL,
    text           text NOT NULL,
    context_prefix text NOT NULL DEFAULT '',   -- situating context, prepended before embedding
    turn_ids       text[] NOT NULL DEFAULT '{}',
    speakers       text[] NOT NULL DEFAULT '{}',
    has_overlap    boolean NOT NULL DEFAULT false,
    tokens         integer NOT NULL DEFAULT 0,
    vector_id      text,                       -- null until embedded
    dirty          boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, layer, ordinal, rev)
);
CREATE INDEX IF NOT EXISTS chunks_current_idx ON chunks (meeting_id, layer, ordinal);

-- Lexical search index, the sparse half of retrieval. Embeddings smear exact tokens (names,
-- numbers, product codes) and this is what finds them.
-- 'simple' rather than 'english': the transcript is code-mixed, English stemming mangles Hindi
-- words, and exact tokens are the whole point here. The context prefix is indexed alongside the
-- text because it is also part of what gets embedded, and using it in only one lane loses recall.
CREATE INDEX IF NOT EXISTS chunks_text_idx ON chunks
    USING GIN (to_tsvector('simple', context_prefix || ' ' || text));
CREATE INDEX IF NOT EXISTS chunks_dirty_idx ON chunks (meeting_id, dirty);

-- Row-Level Security, required, not optional.
-- Supabase auto-exposes every `public` table through its PostgREST API to the anon/authenticated
-- roles, i.e. to anyone holding the PUBLISHABLE key (which we ship publicly in the extension).
-- With RLS off, that key could read/write these tables directly, bypassing the backend's ownership
-- checks. We enable RLS with no policies, which defaults to deny for anon/authenticated. The
-- backend connects as the `postgres` role (BYPASSRLS), so it's unaffected; the public key is
-- denied all direct access. (If we ever let the client talk to Postgres directly, add
-- owner-scoped policies then.)
ALTER TABLE meetings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats                ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_summaries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE utterances           ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks               ENABLE ROW LEVEL SECURITY;

-- What a speaker is called, per meeting. The diarizer only ever produces S0, S1, S2: which
-- human that is cannot be known from audio, so it is supplied here and applied when a
-- transcript is read. Nothing upstream of this table knows or cares about names.
CREATE TABLE IF NOT EXISTS speaker_names (
    meeting_id    TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, speaker_label)
);

ALTER TABLE speaker_names        ENABLE ROW LEVEL SECURITY;

-- Accounts, when this deployment issues its own tokens rather than delegating to Supabase.
-- A deployment using Supabase auth never writes here; ownership keys on the JWT subject either
-- way, so both paths produce the same owner_id shape.
CREATE TABLE IF NOT EXISTS users (
    id            text PRIMARY KEY,               -- app-generated uuid (crypto.randomUUID)
    email         text NOT NULL,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive: nobody expects Alice@ and alice@ to be two accounts.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- One meeting shared with one other account. The owner grants and revokes; a shared account
-- gets read + chat access, nothing else (see requireMeetingOwner).
CREATE TABLE IF NOT EXISTS meeting_shares (
    id          text NOT NULL PRIMARY KEY,   -- app-generated uuid (crypto.randomUUID), like chats.id
    meeting_id  text NOT NULL REFERENCES meetings (job_id) ON DELETE CASCADE,
    shared_with text NOT NULL,               -- account granted access
    granted_by  text NOT NULL,               -- account that granted it
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_shares_meeting_shared_with_key ON meeting_shares (meeting_id, shared_with);
CREATE INDEX IF NOT EXISTS meeting_shares_shared_with_idx ON meeting_shares (shared_with);

ALTER TABLE meeting_shares ENABLE ROW LEVEL SECURITY;

