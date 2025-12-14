// index.js

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
// We now import the correct function to initialize our Cloudinary service
const { initialiseCloudinary } = require("./db/cloudinary-utils/audio.db");
const { connectToMongo } = require("./db/mongoutils/transcription.db");
const { startWorker, shutdown: workerShutdown } = require("./controllers/worker");
const audioRoutes = require("./routes/audioRoutes");
const meetingRoutes = require("./routes/meetingRoutes");
const transcRoutes = require("./routes/transcRoutes");
const chatRoutes = require("./routes/chatRoutes");
const tempAuthCheck = require("./middlewares/tempAuthCheck");

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

// Apply temporary authentication middleware globally
app.use(tempAuthCheck);

// Connect to MongoDB once when the server starts.
connectToMongo();

app.use("/api/audios", audioRoutes);
app.use("/api/meeting/", meetingRoutes);
app.use("/api/transcription", transcRoutes);
app.use("/api/chat/", chatRoutes);

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // Start the worker once when the server boots up.
  try {
    await startWorker();
  } catch (error) {
    console.error('Worker: Failed to start persistent worker:', error);
  }
});


// Graceful Shutdown Logic
let isShuttingDown = false;
let forceExitTimer = null;

const gracefulShutdown = async () => {
  // Prevent multiple invocations (e.g., Ctrl+C pressed twice)
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;

  console.log('Received kill signal, shutting down gracefully...');

  // Force close if it takes too long (e.g. hung connections)
  forceExitTimer = setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);

  // 1. Close the server (stops accepting new requests)
  server.close(async () => {
    console.log('HTTP server closed.');

    // 2. Close Worker (RabbitMQ)
    try {
      await workerShutdown();
    } catch (err) {
      console.error('Error during worker shutdown:', err);
    }

    // 3. Clear force timer and exit cleanly
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
    }
    console.log('Process termination complete.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
