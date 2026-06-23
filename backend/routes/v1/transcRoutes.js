// transcRoutes.js
const express = require('express');
const router = express.Router();
const { getTranscription } = require('../../db/queries/transcription.db');
const { requireLegacyMeetingAccess } = require('../../middlewares/auth');

// Route to get a full transcription by the jobId in the cookie
// GET /api/transcription  (legacy; ownership enforced via requireLegacyMeetingAccess)
router.get('/', requireLegacyMeetingAccess, async (req, res) => {
  const jobId = req.meeting.meetingId;

  try {
    const document = await getTranscription(jobId);

    if (!document) {
      return res.status(404).json({ error: `Transcription with jobId ${jobId} not found.` });
    }

    // Return the full transcription document
    res.status(200).json(document);
  } catch (error) {
    console.error('Error fetching transcription:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

module.exports = router;
