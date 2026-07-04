// Append-only transcript log.
// A correction (diarizer relabel, or the post-meeting batch pass) writes a new revision
// and supersedes the old one in one transaction, so readers always see one current row per turn.

'use strict';

const { query, withTransaction } = require('../infra/postgres');
const { createLogger } = require('../core/logger');

const logger = createLogger('utteranceRepository');

const COLUMNS = `meeting_id, turn_id, rev, seq, t0_ms, t1_ms, text,
                 speaker_label, speaker_confidence, overlap, overlap_ratio,
                 source, superseded_by, created_at`;

function toUtterance(row) {
    return {
        meetingId: row.meeting_id,
        turnId: row.turn_id,
        rev: row.rev,
        seq: Number(row.seq),
        t0Ms: row.t0_ms,
        t1Ms: row.t1_ms,
        text: row.text,
        speakerLabel: row.speaker_label,
        speakerConfidence: row.speaker_confidence,
        overlap: row.overlap,
        overlapRatio: row.overlap_ratio,
        source: row.source,
        supersededBy: row.superseded_by,
        createdAt: row.created_at,
    };
}

/**
 * Appends a finalised utterance. `seq` is assigned server-side from the current max so
 * append order is monotonic per meeting even if callers race.
 */
async function appendUtterance(meetingId, utterance) {
    const {
        turnId, t0Ms, t1Ms, text,
        speakerLabel = null, speakerConfidence = 'unknown',
        overlap = false, overlapRatio = 0, source = 'live-fusion',
    } = utterance;

    const { rows } = await query(
        `INSERT INTO utterances
           (meeting_id, turn_id, rev, seq, t0_ms, t1_ms, text,
            speaker_label, speaker_confidence, overlap, overlap_ratio, source)
         VALUES ($1, $2, 0,
                 COALESCE((SELECT MAX(seq) FROM utterances WHERE meeting_id = $1), -1) + 1,
                 $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLUMNS}`,
        [meetingId, turnId, t0Ms, t1Ms, text,
         speakerLabel, speakerConfidence, overlap, overlapRatio, source]
    );
    return toUtterance(rows[0]);
}

/**
 * Records a correction: writes rev+1 and marks the previous revision superseded.
 * Both writes share a transaction so no reader ever sees zero or two current rows.
 */
async function reviseUtterance(meetingId, turnId, changes) {
    return withTransaction(async (client) => {
        const { rows: current } = await client.query(
            `SELECT ${COLUMNS} FROM utterances
              WHERE meeting_id = $1 AND turn_id = $2 AND superseded_by IS NULL
              FOR UPDATE`,
            [meetingId, turnId]
        );
        if (current.length === 0) return null;

        const prev = current[0];
        const nextRev = prev.rev + 1;

        await client.query(
            `UPDATE utterances SET superseded_by = $3
              WHERE meeting_id = $1 AND turn_id = $2 AND rev = $4`,
            [meetingId, turnId, nextRev, prev.rev]
        );

        const merged = { ...toUtterance(prev), ...changes };
        const { rows } = await client.query(
            `INSERT INTO utterances
               (meeting_id, turn_id, rev, seq, t0_ms, t1_ms, text,
                speaker_label, speaker_confidence, overlap, overlap_ratio, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING ${COLUMNS}`,
            [meetingId, turnId, nextRev, prev.seq, merged.t0Ms, merged.t1Ms, merged.text,
             merged.speakerLabel, merged.speakerConfidence, merged.overlap,
             merged.overlapRatio, merged.source]
        );

        logger.info('Utterance revised', { meetingId, turnId, rev: nextRev, source: merged.source });
        return toUtterance(rows[0]);
    });
}

/** The current transcript, in spoken order. Superseded revisions are excluded. */
async function getTranscript(meetingId, { limit = null } = {}) {
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM utterances
          WHERE meeting_id = $1 AND superseded_by IS NULL
          ORDER BY seq ASC${limit ? ' LIMIT ' + Number(limit) : ''}`,
        [meetingId]
    );
    return rows.map(toUtterance);
}

/**
 * The tail of the transcript, measured back from the watermark rather than wall clock:
 * "what was just said" means recent in the meeting, and a paused meeting hasn't moved on.
 *
 * Watermark is read separately instead of as a subquery, pg-mem (used in the DB tests)
 * doesn't handle the correlated form.
 */
async function getRecentTurns(meetingId, { windowMs = 60000 } = {}) {
    const watermarkMs = await getWatermarkMs(meetingId);
    const sinceMs = Math.max(0, watermarkMs - windowMs);

    const { rows } = await query(
        `SELECT ${COLUMNS} FROM utterances
          WHERE meeting_id = $1 AND superseded_by IS NULL AND t1_ms >= $2
          ORDER BY seq ASC`,
        [meetingId, sinceMs]
    );
    return rows.map(toUtterance);
}

/** Every revision of one turn, oldest first. The provenance trail. */
async function getTurnHistory(meetingId, turnId) {
    const { rows } = await query(
        `SELECT ${COLUMNS} FROM utterances
          WHERE meeting_id = $1 AND turn_id = $2
          ORDER BY rev ASC`,
        [meetingId, turnId]
    );
    return rows.map(toUtterance);
}

/** How far the durable transcript reaches, in session time. Drives the staleness indicator. */
async function getWatermarkMs(meetingId) {
    const { rows } = await query(
        `SELECT COALESCE(MAX(t1_ms), 0) AS watermark FROM utterances
          WHERE meeting_id = $1 AND superseded_by IS NULL`,
        [meetingId]
    );
    return Number(rows[0].watermark);
}

module.exports = {
    appendUtterance,
    reviseUtterance,
    getTranscript,
    getRecentTurns,
    getTurnHistory,
    getWatermarkMs,
};
