//index.js
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser"); // Import cookie-parser
const { connectToMongo } = require("./db/mongoutil");

const audioRoutes = require("./routes/audioRoutes");
const meetingRoutes = require("./routes/meetingRoutes");
const transcRoutes = require("./routes/transcRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.use(cookieParser()); // Use the cookie-parser middleware

// Connect to MongoDB once when the server starts
connectToMongo();

app.use("/api/audios", audioRoutes);
app.use("/api/meeting/", meetingRoutes)
app.use("/api/transcription",transcRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
