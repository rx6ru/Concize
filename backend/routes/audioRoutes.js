const express = require("express");

const router = express.Router();

router.post("/audio/upload", (req, res) => {
    res.send("Audio");
});

router.post("/audio/transcibe", (req, res) => {
    res.send("Transcibe");
});

module.exports = router;
