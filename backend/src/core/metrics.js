//
// Prometheus metrics for the API process (prom-client). Exposes default Node/process metrics
// (event-loop lag, heap, GC) plus HTTP request latency. Scrape at GET /metrics.
//
// NOTE: metrics are per-process. The transcription/summary workers would each need their own
// /metrics endpoint (or a push gateway) to be scraped — wired later alongside the queue work.

const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'concize_' });

const httpDuration = new client.Histogram({
    name: 'concize_http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [register],
});

// Available for the worker pipeline to increment per chunk outcome (success|retry|dlq|error).
const chunkProcessed = new client.Counter({
    name: 'concize_chunk_processed_total',
    help: 'Audio chunks processed, by outcome',
    labelNames: ['status'],
    registers: [register],
});

/**
 * Express middleware that records request latency. Labels by the matched route PATTERN
 * (not the raw URL) to keep label cardinality bounded.
 */
function httpMetricsMiddleware(req, res, next) {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
        end({
            method: req.method,
            route: (req.route && req.route.path) || 'unmatched',
            status_code: res.statusCode,
        });
    });
    next();
}

module.exports = { register, client, httpDuration, chunkProcessed, httpMetricsMiddleware };
