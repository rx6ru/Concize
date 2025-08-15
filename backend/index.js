//index.js
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser"); // Import cookie-parser
const { connectToMongo } = require("./db/mongoutils/transcription.db");
const { startWorker } = require("./controllers/worker"); // Import the worker startup function

const audioRoutes = require("./routes/audioRoutes");
const meetingRoutes = require("./routes/meetingRoutes");
const transcRoutes = require("./routes/transcRoutes");
const chatRoutes = require("./routes/chatRoutes");

const app = express();

// --- START OF CORS FIX ---
// Define a whitelist of allowed origins.
// This is necessary because requests with 'credentials: true' cannot use a wildcard '*'.
const allowedOrigins = [
    'chrome-extension://ehgklfhpooihffchjkmlfenndjnjkejp', // Your Chrome Extension ID
    'http://localhost:3000' // For local development/testing if needed
];

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true, // This is crucial. It allows the browser to send/receive cookies.
    optionsSuccessStatus: 200 // Some legacy browsers (IE11) choke on 204
};

app.use(cors(corsOptions));
// --- END OF CORS FIX ---

app.use(express.json());
app.use(cookieParser()); // Use the cookie-parser middleware

// Connect to MongoDB once when the server starts
connectToMongo();

app.use("/api/audios", audioRoutes);
app.use("/api/meeting/", meetingRoutes)
app.use("/api/transcription",transcRoutes);
app.use("/api/chat/",chatRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    // KEY CHANGE: Start the worker once when the server boots up.
    // The worker will now run as a persistent background process.
    try {
        await startWorker();
        console.log('Worker: Persistent worker started successfully.');
    } catch (error) {
        console.error('Worker: Failed to start persistent worker:', error);
        // Depending on the severity, you might want to exit the process here
    }
});