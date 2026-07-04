-- Derived retrievable chunks. Rebuildable from `utterances` by replay, so nothing here is
-- precious — but a chunk is never mutated in place: a correction bumps `rev` and re-embeds,
-- because a reader mid-query must see one consistent version.
--
-- `layer` follows the retrieval design: 1 = verbatim speaker-labelled, 2 = narrative rewrite,
-- 3 = topic node.
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
CREATE INDEX IF NOT EXISTS chunks_dirty_idx ON chunks (meeting_id, dirty);

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
