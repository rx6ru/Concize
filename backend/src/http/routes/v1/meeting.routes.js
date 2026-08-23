// Canonical RESTful, ownership-rooted resource tree:
//   GET    /api/v1/meetings                       the caller's meetings
//   POST   /api/v1/meetings                       create a meeting (owner = caller)
//   DELETE /api/v1/meetings/:meetingId            delete it, and its vectors
//   GET    /api/v1/meetings/:meetingId/transcript flat legacy transcript
//   GET    /api/v1/meetings/:meetingId/utterances speaker-attributed turns, paged
//   POST   /api/v1/meetings/:meetingId/chat       RAG chat (SSE)
//   GET    /api/v1/meetings/:meetingId/summary    fetch the running summary
//   GET    /api/v1/meetings/:meetingId/speakers   who each S-label is
//   PUT    /api/v1/meetings/:meetingId/speakers/:label  name one of them
//
// Auth travels in Authorization: Bearer; the resource id travels in the path.
// Every :meetingId route is gated by requireMeetingAccess (ownership → 404 on mismatch).

const express = require('express');
const router = express.Router();

const { requireMeetingAccess } = require('../../middleware/auth.wiring');
const { startMeeting, fetchMeetingSummary } = require('../../../meetings/meeting.controller');
const { getLLMStreamResponse } = require('../../../chat/chat.controller');
const { getTranscription, listMeetings } = require('../../../meetings/meeting.repository');
const { purgeMeeting } = require('../../../meetings/meeting.purge.wiring');
const { getTranscript } = require('../../../transcript/utterance.repository');
const { namesFor, setName, displayFor } = require('../../../transcript/speaker.names');
const { query } = require('../../../infra/postgres');
const { createLogger } = require('../../../core/logger');

const logger = createLogger('meetingsRoutes');

// Create a new meeting owned by the authenticated caller.
router.post('/', startMeeting);

// The caller's own meetings. A collection route, so there is no :meetingId to gate, the owner filter lives in the query itself.
router.get('/', async (req, res) => {
    if (!req.user?.id) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 100);
        return res.status(200).json({ success: true, meetings: await listMeetings(req.user.id, { limit }) });
    } catch (error) {
        logger.error('Failed to list meetings', { ownerId: req.user.id, error: error.message });
        return res.status(500).json({ success: false, error: 'An internal server error occurred.' });
    }
});

// Delete an owned meeting, its derived rows, and its vectors.
router.delete('/:meetingId', requireMeetingAccess, async (req, res) => {
    const { meetingId } = req.meeting;
    try {
        const { deleted } = await purgeMeeting(meetingId);
        // The gate already proved it exists, so a false here is a race with another delete.
        return deleted ? res.status(204).end() : res.status(404).json({ error: 'Meeting not found.' });
    } catch (error) {
        // Never report success on a partial delete: the caller must be able to retry.
        logger.error('Failed to delete meeting', { meetingId, error: error.message });
        return res.status(500).json({ error: 'Failed to delete the meeting. Nothing was removed.' });
    }
});

// Fetch the full transcript for an owned meeting.
router.get('/:meetingId/transcript', requireMeetingAccess, async (req, res) => {
    try {
        const document = await getTranscription(req.meeting.meetingId);
        if (!document) {
            return res.status(404).json({ error: 'Transcript not found.' });
        }
        return res.status(200).json(document);
    } catch (error) {
        logger.error('Failed to fetch transcript', { meetingId: req.meeting.meetingId, error: error.message });
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// The speaker-attributed transcript, paged. /transcript above is the flat legacy text with no speakers or timings; this serves the utterance log instead, which is what a post-meeting view needs.
router.get('/:meetingId/utterances', requireMeetingAccess, async (req, res) => {
    const { meetingId } = req.meeting;
    try {
        const limit = Math.min(Number(req.query.limit) || 200, 500);
        const afterSeq = req.query.after === undefined ? null : Number(req.query.after);
        const rows = await getTranscript(meetingId, { limit, afterSeq });
        // Names are decoration on top of the log. Losing them costs the reader nothing they cannot
        // work around; losing the transcript because of them would be absurd.
        const names = await namesFor(meetingId).catch((error) => {
            logger.warn('Speaker names unavailable', { meetingId, error: error.message });
            return new Map();
        });

        return res.status(200).json({
            success: true,
            utterances: rows.map((u) => ({
                turnId: u.turnId,
                seq: u.seq,
                t0: u.t0Ms,
                t1: u.t1Ms,
                text: u.text,
                speaker: u.speakerLabel ?? null,
                // The label stays, so a client can still group by speaker after a rename.
                speakerName: displayFor(names, u.speakerLabel ?? null),
                confidence: u.speakerConfidence ?? 'unknown',
                overlap: u.overlap ?? false,
                overlapRatio: u.overlapRatio ?? 0,
            })),
            // Null rather than absent, so a client can tell "no more" from "field missing".
            nextCursor: rows.length === limit && rows.length ? rows[rows.length - 1].seq : null,
        });
    } catch (error) {
        logger.error('Failed to fetch utterances', { meetingId, error: error.message });
        return res.status(500).json({ success: false, error: 'An internal server error occurred.' });
    }
});

// Who each S-label is. Labels present in the transcript but never named come back unnamed rather
// than omitted, so a client can offer every speaker for naming without a second query.
router.get('/:meetingId/speakers', requireMeetingAccess, async (req, res) => {
    const { meetingId } = req.meeting;
    try {
        const [names, { rows }] = await Promise.all([
            namesFor(meetingId),
            query(
                `SELECT DISTINCT speaker_label FROM utterances
                 WHERE meeting_id = $1 AND speaker_label IS NOT NULL AND superseded_by IS NULL
                 ORDER BY speaker_label`,
                [meetingId]
            ),
        ]);
        return res.status(200).json({
            success: true,
            speakers: rows.map((r) => ({
                label: r.speaker_label,
                name: names.get(r.speaker_label) ?? null,
            })),
        });
    } catch (error) {
        logger.error('Failed to fetch speakers', { meetingId, error: error.message });
        return res.status(500).json({ success: false, error: 'An internal server error occurred.' });
    }
});

// Name a speaker, or clear the name with an empty string.
router.put('/:meetingId/speakers/:label', requireMeetingAccess, async (req, res) => {
    const { meetingId } = req.meeting;
    const { label } = req.params;
    try {
        const name = await setName(meetingId, label, req.body?.name);
        return res.status(200).json({ success: true, label, name });
    } catch (error) {
        logger.error('Failed to name speaker', { meetingId, label, error: error.message });
        return res.status(500).json({ success: false, error: 'An internal server error occurred.' });
    }
});

// RAG chat over an owned meeting, streamed via SSE.
router.post('/:meetingId/chat', requireMeetingAccess, async (req, res) => {
    try {
        const { userPrompt } = req.body;
        if (!userPrompt) {
            return res.status(400).json({ error: 'userPrompt is required.' });
        }
        await getLLMStreamResponse(res, userPrompt, req.meeting.meetingId, req.meeting.ownerId);
    } catch (error) {
        logger.error('Chat stream error', { meetingId: req.meeting.meetingId, error: error.message });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
});

// Fetch the running summary for an owned meeting.
router.get('/:meetingId/summary', requireMeetingAccess, fetchMeetingSummary);

module.exports = router;
