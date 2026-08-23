// What each speaker in a meeting is called.
//
// Diarization produces S0, S1, S2 and cannot do better: which human a voice belongs to is not
// recoverable from audio alone. A name is supplied by whoever was in the room and applied when a
// transcript is read, so nothing upstream has to know about it and a rename never rewrites the log.

'use strict';

const { query } = require('../infra/postgres');

// Long enough for a full name, short enough that the label stays readable in a transcript line.
const MAX_NAME = 60;

/** Every naming for one meeting, as label -> display name. */
async function namesFor(meetingId) {
    const { rows } = await query(
        'SELECT speaker_label, display_name FROM speaker_names WHERE meeting_id = $1',
        [meetingId]
    );
    return new Map(rows.map((r) => [r.speaker_label, r.display_name]));
}

/**
 * Names a speaker, or clears the name when given an empty one.
 * @returns {Promise<?string>} the stored name, or null if it was cleared
 */
async function setName(meetingId, speakerLabel, displayName) {
    const name = String(displayName ?? '').trim().slice(0, MAX_NAME);
    if (!name) {
        await query('DELETE FROM speaker_names WHERE meeting_id = $1 AND speaker_label = $2',
            [meetingId, speakerLabel]);
        return null;
    }
    await query(
        `INSERT INTO speaker_names (meeting_id, speaker_label, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (meeting_id, speaker_label)
         DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
        [meetingId, speakerLabel, name]
    );
    return name;
}

/** The name for a label, falling back to the label itself so a caller always has something to show. */
function displayFor(names, speakerLabel) {
    if (!speakerLabel) return speakerLabel;
    return names.get(speakerLabel) || speakerLabel;
}

module.exports = { namesFor, setName, displayFor, MAX_NAME };
