// index.js

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
// We now import the correct function to initialize our Cloudinary service
const { initialiseCloudinary } = require("./db/cloudinary-utils/audio.db");
const { connectToMongo } = require("./db/mongoutils/transcription.db");
const { startWorker } = require("./controllers/worker");
const audioRoutes = require("./routes/audioRoutes");
const meetingRoutes = require("./routes/meetingRoutes");
const transcRoutes = require("./routes/transcRoutes");
const chatRoutes = require("./routes/chatRoutes");

// Initialize Cloudinary before starting the server.
// This is a crucial step for our audio storage and retrieval functions.
try {
  initialiseCloudinary();
  console.log('Cloudinary: SDK and services initialized successfully.');
} catch (error) {
  console.error('Cloudinary: Failed to initialize SDK:', error);
  process.exit(1); // Exit the process if initialization fails
}

const app = express();

// --- START OF CORS FIX ---
// Define a whitelist of allowed origins.
// This is now configured using an environment variable for better security and flexibility.
// It falls back to a default list for local development.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [
      'chrome-extension://bdjgabpcncgafmgaommcofiaciigigmm',
      'chrome-extension://ehgklfhpooihffchjkmlfenndjnjkejp',
      'http://localhost:3000',
      'http://127.0.0.1:5500'
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
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
// --- END OF CORS FIX ---

app.use(express.json());
app.use(cookieParser());

// Connect to MongoDB once when the server starts.
connectToMongo();

app.use("/api/audios", audioRoutes);
app.use("/api/meeting/", meetingRoutes);
app.use("/api/transcription", transcRoutes);
app.use("/api/chat/", chatRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // Start the worker once when the server boots up.
  try {
    await startWorker();
    console.log('Worker: Persistent worker started successfully.');
  } catch (error) {
    console.error('Worker: Failed to start persistent worker:', error);
  }
});
