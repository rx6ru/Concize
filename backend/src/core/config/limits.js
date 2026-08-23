// Abuse and cost protection: per-user request limits, WS concurrency cap, cost circuit breaker.
// See Concize-KB/60-sprint/gates/L15.md for the numbers behind these defaults.

module.exports = {
    // /meetings/:id/chat fans out to a Gemini query-embedding call (gemini-embedding-001,
    // measured 1000 requests/day system-wide, provider.limits.json) plus one Groq prompt-guard
    // call per question and one per retrieved chunk (measured 8 guard calls for 1 question with
    // 7 retrieved chunks, Concize-KB/20-measurements/latency-and-cost.md). This window bounds
    // burst rate; the cost breaker below bounds total daily spend.
    chatRateLimit: {
        max: Number(process.env.CHAT_RATE_LIMIT_MAX) || 10,
        windowMs: Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS) || 60000,
    },

    // A person is in one meeting at a time; each created meeting is normally followed by a real
    // /rt session that starts a billed Sarvam STT session immediately.
    meetingCreateRateLimit: {
        max: Number(process.env.MEETING_CREATE_RATE_LIMIT_MAX) || 5,
        windowMs: Number(process.env.MEETING_CREATE_RATE_LIMIT_WINDOW_MS) || 3600000,
    },

    // 2, not 1: allows a reconnect to race the old socket's teardown without hard-blocking it.
    wsMaxConcurrentPerUser: Number(process.env.WS_MAX_CONCURRENT_PER_USER) || 2,

    // infra/redis.js's shared client sets maxRetriesPerRequest: null (for BullMQ), so a command
    // issued while Redis is unreachable would otherwise queue forever instead of rejecting. This
    // bounds how long a rate-limit check can block a request before falling open.
    rateLimitRedisTimeoutMs: Number(process.env.RATE_LIMIT_REDIS_TIMEOUT_MS) || 200,

    // Optional operator override, in tokens/day, checked in addition to the vendor's own
    // tokensPerDay/requestsPerDay cap already recorded in provider.limits.json. Unset by default:
    // the vendor cap is itself a real, measured number (core/provider.limits.js), so there is
    // nothing to invent a default for here.
    costCeilingTokensPerDay: process.env.COST_CEILING_TOKENS_PER_DAY
        ? Number(process.env.COST_CEILING_TOKENS_PER_DAY)
        : null,
};
