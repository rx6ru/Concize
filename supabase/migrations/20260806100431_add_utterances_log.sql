-- Append-only transcript log — the system of record for real-time meetings.
--
-- Never UPDATE a row here. Streaming ASR rewrites its own output and diarizers retro-correct
-- speaker labels once later audio disambiguates a voice, so a correction is a NEW revision that
-- supersedes the old one. Keeping both is what lets us answer "what did the system believe at
-- 14:32, and what changed?", and lets every derived artefact be rebuilt by replay.
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
CREATE INDEX IF NOT EXISTS utterances_current_idx ON utterances (meeting_id, seq)
    WHERE superseded_by IS NULL;

ALTER TABLE utterances ENABLE ROW LEVEL SECURITY;
