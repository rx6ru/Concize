// transcRoutes.js
const express = require('express');
const router = express.Router();
const { getTranscription } = require('../db/mongoutil');

// Route to get a full transcription by the jobId in the cookie
// GET /api/transcription
router.get('/', async (req, res) => {
  // Get the jobId from the request cookies
  const { jobId } = req.cookies;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required in the cookie' });
  }

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
