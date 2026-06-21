-- db/schema.sql
-- Canonical Postgres schema for Concize application data (Supabase Postgres).
-- Identity lives in Supabase auth; `owner_id` holds the Supabase user id (text) and is the
-- single source of ownership. chats & meeting_summaries derive ownership via the job_id FK.
--
-- Apply locally with: psql "$POSTGRES_URL" -f db/schema.sql
-- Or via Supabase CLI: place under supabase/migrations/ and `supabase db push`.

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

-- Row-Level Security: the backend connects with a privileged role and enforces ownership in
-- the application layer (requireMeetingAccess). RLS policies are defense-in-depth for any future
-- direct-from-client access; enable + define them when that path exists.
