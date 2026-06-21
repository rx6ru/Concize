// index.js

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createLogger } = require("./utils/logger");
const requestLogger = require("./middlewares/requestLogger");
const { initialiseCloudinary } = require("./db/cloudinary-utils/audio.db");
const { connectPg } = require("./db/pg");
const { performSystemCheck } = require("./utils/systemCheck");
const { startWorker, shutdown: workerShutdown } = require("./workers/transcriptionWorker");
const v1Routes = require("./routes/v1");
const { authenticate } = require("./middlewares/auth");

const logger = createLogger('server');

// Initialize Cloudinary before starting the server.
// This is a crucial step for our audio storage and retrieval functions.
try {
  initialiseCloudinary();
  logger.info('Cloudinary SDK and services initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Cloudinary SDK', { error: error.message });
  process.exit(1);
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
app.use(requestLogger);

// Apply authentication globally: every request must carry a valid Supabase JWT
// or (transitionally) a legacy x-auth-code. Sets req.user. Authorization (ownership)
// is enforced per-resource by requireMeetingAccess on the meeting routes.
app.use(authenticate);

// Verify Postgres connectivity at startup.
connectPg().catch(err => {
  logger.error('Initial Postgres connection failed', { error: err.message });
  process.exit(1);
});

// --- Versioned API ---
app.use("/api/v1", v1Routes);

// Backward compatibility: redirect unversioned /api/* → /api/v1/*
// 307 preserves the HTTP method (POST stays POST)
app.use("/api", (req, res, next) => {
  if (!req.path.startsWith('/v1')) {
    return res.redirect(307, `/api/v1${req.path}`);
  }
  next();
});

const PORT = process.env.PORT || 3000;

// Startup Sequence
const startServer = async () => {
  try {
    // 1. Run System Checks
    await performSystemCheck();

    // 2. Start HTTP Server
    const serverInstance = app.listen(PORT, async () => {
      logger.info(`Server is running on port ${PORT}`);

      // 3. Start Background Worker
      try {
        await startWorker();
      } catch (error) {
        logger.error('Failed to start persistent worker', { error: error.message });
        // Decide if this should be fatal or not. For now, log and continue.
      }
    });

    // assign to global variable for shutdown handling
    global.server = serverInstance;

  } catch (error) {
    logger.error('❌ system check failed. Server will not start.', { error: error.message });
    process.exit(1);
  }
};

startServer();


// Graceful Shutdown Logic
let isShuttingDown = false;
let forceExitTimer = null;

const gracefulShutdown = async () => {
  // Prevent multiple invocations (e.g., Ctrl+C pressed twice)
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress');
    return;
  }
  isShuttingDown = true;

  logger.info('Received kill signal, shutting down gracefully');

  // Force close if it takes too long (e.g. hung connections)
  forceExitTimer = setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);

  // 1. Close the server (stops accepting new requests)
  if (global.server) {
    global.server.close(async () => {
      logger.info('HTTP server closed');

      // 2. Close Worker (RabbitMQ)
      try {
        await workerShutdown();
      } catch (err) {
        logger.error('Error during worker shutdown', { error: err.message });
      }

      // 3. Clear force timer and exit cleanly
      if (forceExitTimer) {
        clearTimeout(forceExitTimer);
      }
      logger.info('Process termination complete');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
