const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createLogger } = require("./core/logger");
const requestId = require("./http/middleware/request.id");
const requestLogger = require("./http/middleware/request.logger");
const { initialiseCloudinary } = require("./infra/storage");
const { connectPg } = require("./infra/postgres");
const { performSystemCheck } = require("./infra/system.check");
const v1Routes = require("./http/routes/v1");
const { authenticate } = require("./http/middleware/auth.wiring");
const { attachGateway } = require("./realtime/gateway");
const { createSarvamRealtimeLane } = require("./providers/stt/sarvam.realtime");
const { createFunasrSpeakerLane } = require("./providers/speaker/funasr.lane");
const transcriptPipeline = require("./transcript/pipeline.wiring");
const { getMeetingOwner } = require("./meetings/meeting.repository");
const { getWatermarkMs } = require("./transcript/utterance.repository");
const { createTokenVerifier } = require("./http/middleware/token.verifier");
const appConfig = require("./core/config");

const verifyAccessToken = createTokenVerifier(appConfig.auth.supabase);
const { shutdown: inferenceShutdown } = require("./providers/llm/resilient.inference");
const { closeAmqp } = require("./infra/queue");
const { closeRedis } = require("./infra/redis");
const { register: metricsRegister, httpMetricsMiddleware } = require("./core/metrics");

const logger = createLogger('server');

// Cloudinary backs audio storage/retrieval; must succeed before the server starts.
try {
  initialiseCloudinary();
  logger.info('Cloudinary SDK and services initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Cloudinary SDK', { error: error.message });
  process.exit(1);
}

const app = express();

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

app.use(express.json());
app.use(cookieParser());
app.use(requestId); // correlation id first, so all downstream logs carry it
app.use(httpMetricsMiddleware);
app.use(requestLogger);

// Metrics scrape endpoint: mounted BEFORE auth so monitoring needs no token.
// Restrict at the network layer in production (internal-only).
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metricsRegister.contentType);
    res.end(await metricsRegister.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// Liveness, mounted BEFORE auth for the same reason /metrics is: a platform health checker holds
// no token, and a health endpoint that answers 401 marks a working container as dead forever.
// It reports only that the process is up, no configuration and no counts.
app.use('/api/v1/health', require('./http/routes/v1/health.routes'));

// Sign up and sign in, also ahead of auth: a caller asking for a token cannot already hold one.
// Only mounted when this deployment issues its own tokens; with AUTH_MODE=jwks an external issuer
// owns accounts and these routes would be a second, contradictory source of identity.
if (appConfig.auth.supabase.mode === 'hs256') {
    app.use('/api/v1/auth', require('./http/routes/v1/auth.routes'));
}

// Applies globally: every request must carry a valid Supabase JWT, and sets req.user.
// Authorization (ownership) is enforced per-resource by requireMeetingAccess on the meeting routes.
app.use(authenticate);

// Verify Postgres connectivity at startup.
connectPg().catch(err => {
  logger.error('Initial Postgres connection failed', { error: err.message });
  process.exit(1);
});

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
    // 1. Run system checks
    await performSystemCheck();

    // 2. Start HTTP server
    const serverInstance = app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });

    // 3. Make sure the chunk collection exists before any meeting can write to it.
    await transcriptPipeline.ensureReady();

    // 4. Attach the live meeting gateway. Auth runs on the HTTP upgrade, reusing the REST verifier and ownership lookup.
    // Speaker attribution is opt in: without SPEAKER_SERVICE_URL the lane is not built and meetings transcribe unattributed.
    const speakerLane = process.env.SPEAKER_SERVICE_URL ? createFunasrSpeakerLane : null;
    if (!speakerLane) {
      logger.warn('SPEAKER_SERVICE_URL not set, meetings will run without speaker attribution');
    }

    global.gateway = attachGateway({
      server: serverInstance,
      verifyAccessToken,
      getMeetingOwner,
      // Resumes a reconnecting client past the stored transcript instead of over it.
      getWatermarkMs,
      createSpeakerLane: speakerLane,
      createLane: createSarvamRealtimeLane,
      maxConcurrentPerUser: appConfig.limits.wsMaxConcurrentPerUser,
      onUtterance: transcriptPipeline.onUtterance,
      onRevision: transcriptPipeline.onRevision,
      onSessionEnd: transcriptPipeline.onSessionEnd,
      onFrame: transcriptPipeline.onFrame,
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

  // 1. Flush and close live meeting sessions first, so in-flight audio is finalised rather than dropped.
  if (global.gateway) {
    try {
      await global.gateway.closeAll();
      logger.info('Live sessions closed');
    } catch (err) {
      logger.error('Error closing live sessions', { error: err.message });
    }
  }

  // 2. Close the server (stops accepting new requests)
  if (global.server) {
    global.server.close(async () => {
      logger.info('HTTP server closed');

      // 3. Release LLM limiter timers + the shared AMQP publisher connection
      try {
        await inferenceShutdown();
        await closeAmqp();
        await closeRedis();
      } catch (err) {
        logger.error('Error during resource shutdown', { error: err.message });
      }

      // 4. Clear force timer and exit cleanly
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
