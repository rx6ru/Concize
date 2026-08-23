

const fs = require('fs');
const path = require('path');
const { getChatInference } = require('../providers/llm/inference.provider');
const { runResilient } = require('../providers/llm/resilient.inference');
const { queryTranscriptions, queryChats } = require('./vector.search');
const { buildContext, checkQuery } = require('./retrieval.wiring');
const { createChatEntry, updateChatEntry } = require('./chat.repository');
const { upsertChatPair } = require('../providers/embedding/chat.embedding');
const { getMeetingSummary } = require('../summary/summary.repository');
const { isOverBudget } = require('../core/cost.breaker');
const { ledger } = require('../core/usage.ledger');
const config = require('../core/config');
const { createLogger } = require('../core/logger');

const logger = createLogger('chatLLM');

const {
    validateInput,
    isRelevantToMeeting,
    recordViolation,
    checkBlocked,
    createStreamGuard,
    SAFE_FALLBACK
} = require('../safety');
const { SECURE_SYSTEM_PROMPT } = require('../../prompts/systemPrompt');

const SYSTEM_PROMPT = SECURE_SYSTEM_PROMPT;


/**
 * Maps system errors to professional user-facing messages.
 * Uses structured error properties when available, falls back to message string matching.
 * @param {Error|Object} error - Error object (may have .status, .code, .error properties from APIs)
 * @returns {Object} { status, message, code }
 */
const mapErrorToResponse = (error) => {
    if (!error) {
        return {
            status: 500,
            code: 'INTERNAL_SERVER_ERROR',
            message: "An unexpected system error occurred. Our team has been notified."
        };
    }

    // Extract structured properties (Groq SDK, Axios, fetch errors may have these)
    const httpStatus = error.status || error.statusCode || error.response?.status;
    const errorCode = error.code || error.error?.code || error.response?.data?.error?.code;
    const msg = error.message || '';

    // 1. Check structured HTTP status first
    // Search being down is not an internal error, and the difference matters to the person asking:
    // retrieval.wiring throws this precisely so an outage is never answered with a confident
    // "the transcript does not mention that". Without a branch here that distinction is lost on
    // the way out and the client shows a generic failure.
    if (errorCode === 'RETRIEVAL_UNAVAILABLE') {
        return {
            status: 503,
            code: 'RETRIEVAL_UNAVAILABLE',
            message: "Search is temporarily unavailable, so this cannot be answered from the transcript yet. Try again in a moment."
        };
    }

    if (httpStatus === 429 || errorCode === 'rate_limit_exceeded') {
        return {
            status: 429,
            code: 'RATE_LIMIT_EXCEEDED',
            message: "Our AI service is currently experiencing high demand. Please wait a moment before sending your next message."
        };
    }

    if (httpStatus === 401 || httpStatus === 403 || errorCode === 'invalid_api_key') {
        return {
            status: 401,
            code: 'UNAUTHORIZED',
            message: "You are not authorized to perform this action. Please refresh your credentials."
        };
    }

    if (httpStatus === 503 || httpStatus === 504 || errorCode === 'service_unavailable') {
        return {
            status: 503,
            code: 'SERVICE_TIMEOUT',
            message: "We are having trouble connecting to the knowledge base. Please check your network or try again later."
        };
    }

    // 2. Fallback to message string matching for errors without structured properties
    if (msg.includes('ConnectTimeoutError') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
        return {
            status: 503,
            code: 'SERVICE_TIMEOUT',
            message: "We are having trouble connecting to the knowledge base. Please check your network or try again later."
        };
    }

    if (msg.includes('429') || msg.includes('Quota') || msg.includes('rate limit')) {
        return {
            status: 429,
            code: 'RATE_LIMIT_EXCEEDED',
            message: "Our AI service is currently experiencing high demand. Please wait a moment before sending your next message."
        };
    }

    if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
        return {
            status: 401,
            code: 'UNAUTHORIZED',
            message: "You are not authorized to perform this action. Please refresh your credentials."
        };
    }

    // 3. Default Generic
    return {
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: "An unexpected system error occurred. Our team has been notified."
    };
};

/**
 * Orchestrates the full RAG process and streams the LLM response over SSE. "Category A" (success) streams; "Category B" (failure before commit) returns JSON.
 * @param {string} ownerId - tenant scoping for retrieval + embedding
 */
const getLLMStreamResponse = async (res, userPrompt, jobId, ownerId) => {
    let chatId = null;
    let fullResponseText = '';
    let heartbeatInterval = null;

    // --- Phase -1: Cost circuit breaker ---
    // Checked first, ahead of the injection guard, so a breached ceiling costs nothing further:
    // no guard call, no embedding call, no completion call.
    const { provider: chatProvider, model: chatModel } = config.inference.chat;
    if (isOverBudget(chatProvider, chatModel, { ceilingTokens: config.limits.costCeilingTokensPerDay })) {
        logger.warn('Cost ceiling reached, refusing chat request', { jobId, provider: chatProvider, model: chatModel });
        return res.status(503).json({
            error: {
                type: 'cost_ceiling_reached',
                code: 'DAILY_COST_CEILING_REACHED',
                message: "We've reached today's usage limit for this service. Please try again tomorrow."
            }
        });
    }

    // --- Phase 0: Security Validation ---

    const standing = checkBlocked(jobId);
    if (standing.blocked) {
        logger.warn('Blocked after repeated violations', { jobId, violations: standing.violationCount });
        return res.status(429).json({
            error: {
                type: 'too_many_violations',
                code: 'TEMPORARILY_BLOCKED',
                message: "Too many blocked requests on this meeting. Try again later."
            }
        });
    }

    const inputCheck = validateInput(userPrompt);
    if (inputCheck.blocked) {
        recordViolation(jobId, inputCheck.reason, { query: userPrompt.substring(0, 100) });
        return res.status(400).json({ error: inputCheck.error });
    }

    // Runs before the relevance check so a blocked attempt doesn't burn an extra LLM call.
    // Fails open, so a guard outage never blocks the chat.
    const injection = await checkQuery(userPrompt);
    if (injection.verdict === 'block') {
        recordViolation(jobId, 'prompt_injection', {
            query: userPrompt.substring(0, 100), score: injection.score,
        });
        return res.status(400).json({
            error: {
                type: 'invalid_request',
                code: 'PROMPT_INJECTION',
                message: "That request looks like an attempt to change how I work. Ask me about the meeting instead."
            }
        });
    }

    const relevanceCheck = await isRelevantToMeeting(userPrompt, jobId);
    if (!relevanceCheck.relevant) {
        recordViolation(jobId, 'off_topic', { query: userPrompt.substring(0, 100) });
        return res.status(400).json({
            error: {
                type: 'off_topic',
                code: 'QUERY_NOT_RELEVANT',
                message: relevanceCheck.message
            }
        });
    }

    // --- Phase 1: Context Retrieval & Validation ---
    // Anything failing here sends a JSON error response; SSE headers are not set yet.

    let contentsPrompt = '';

    try {
        // Past chats and the summary are extra context: without them the answer is thinner, not wrong, so they don't get to take the request down with them.
        const [retrieved, chatHistory, meetingSummary] = await Promise.all([
            buildContext({ query: userPrompt, meetingId: jobId, ownerId }),
            queryChats(userPrompt, jobId, ownerId, 3).catch(err => {
                logger.warn('Chat history unavailable', { jobId, error: err.message });
                return [];
            }),
            getMeetingSummary(jobId).catch(err => {
                logger.warn('Summary unavailable', { jobId, error: err.message });
                return null;
            })
        ]);

        // Meetings recorded before the chunk pipeline have nothing in the chunk index, so they fall back to the original transcription collection instead of an empty block; that fallback carries no provenance, so there are no instructions with it.
        let transcriptionText;
        let contextInstructions = '';

        if (retrieved) {
            transcriptionText = retrieved.contextBlock;
            contextInstructions = retrieved.instructions;
            logger.info('Context retrieved', { jobId, ...retrieved.stats });
        } else {
            const legacyContext = await queryTranscriptions(userPrompt, jobId, ownerId, 5);
            transcriptionText = legacyContext.length > 0
                ? legacyContext.map(chunk => `Transcription Snippet: ${chunk.text}`).join('\n')
                : "No specific meeting transcriptions were found for this query.";
        }

        const chatHistoryText = chatHistory.length > 0
            ? chatHistory.map(chat => `User: ${JSON.stringify(chat.userChat)}\nAI: ${chat.aiChat}`).join('\n')
            : "No specific chat history was found for this query.";

        const summaryContext = meetingSummary
            ? `Title: ${meetingSummary.title}\nSummary: ${meetingSummary.content}`
            : "No summary available yet.";

        contentsPrompt =
            `# Meeting Summary (Current Context):
${summaryContext}

# Meeting Transcription Snippets (Specific Context):
${transcriptionText}
${contextInstructions ? `\n# How to use this context:\n${contextInstructions}\n` : ''}
# Relevant Chat History:
${chatHistoryText}

# User's Question:
${userPrompt}`;

        const newChat = await createChatEntry(jobId, userPrompt);
        chatId = newChat._id;
        logger.info('Chat entry created', { chatId, jobId });

    } catch (phase1Error) {
        logger.error('LLM_PRE_STREAM_ERROR', { jobId, error: phase1Error.message });
        const { status, message, code } = mapErrorToResponse(phase1Error);

        // Return Category B (JSON Error)
        return res.status(status).json({
            error: {
                type: 'server_error',
                code: code,
                message: message
            }
        });
    }

    // --- Phase 2: Streaming ---
    // Context is ready and the DB entry exists; committing to the 200 OK stream now.

    const startHeartbeat = () => {
        if (heartbeatInterval) return;
        heartbeatInterval = setInterval(() => {
            if (res.writableEnded || !res.writable) return;
            try {
                res.write(':heartbeat\n\n');
            } catch (e) {
                // Client likely disconnected
                clearHeartbeat();
            }
        }, 15000);
    };

    const clearHeartbeat = () => {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    };

    try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('X-Accel-Buffering', 'no');

        res.flushHeaders();

        let responseValid = false;

        // Retry loop
        for (let attempt = 0; attempt < 3; attempt++) {
            if (res.writableEnded || !res.writable) {
                logger.warn('Client disconnected, aborting LLM retry loop', { jobId });
                break;
            }

            let currentResponseChunk = '';
            let outputBlocked = false;
            let attemptUsage = null;
            try {


                const { client, model, taskConfig } = getChatInference();
                logger.info('Inference attempt started', {
                    attempt: attempt + 1,
                    provider: taskConfig.provider,
                    model,
                    jobId
                });

                // Concurrency-limited via the per-provider Bottleneck limiter. maxRetries: 0 since this is a user-facing stream; the outer retry loop owns backoff, not this call.
                // stream_options.include_usage asks the provider for a final usage-only chunk (empty choices), the only place a streamed completion's token count is observable.
                const stream = await runResilient(taskConfig.provider, () =>
                    client.chat.completions.create({
                        messages: [
                            { role: 'system', content: SYSTEM_PROMPT },
                            { role: 'user', content: contentsPrompt }
                        ],
                        model: model,
                        temperature: taskConfig.temperature,
                        max_completion_tokens: taskConfig.maxTokens,
                        stream: true,
                        stream_options: { include_usage: true },
                    }),
                    { maxRetries: 0 }
                );

                startHeartbeat();

                // Screens the answer as it streams; nothing checked output on this path before, and validateChunk tests a delta in isolation, so a pattern spanning several deltas would never match.
                const guard = createStreamGuard();

                for await (const chunk of stream) {
                    // Read before the writability check, not after: this chunk is already in hand, and on a client disconnect it is often the terminal usage chunk. Bailing first threw away the only real token count the call would ever report.
                    // It carries no choices either, so it cannot wait until after the delta check below.
                    if (chunk.usage) attemptUsage = chunk.usage;

                    if (res.writableEnded || !res.writable) break;

                    const chunkText = chunk.choices[0]?.delta?.content || '';
                    if (!chunkText) continue;

                    const verdict = guard.push(chunkText);
                    if (verdict.blocked) {
                        logger.warn('Blocked streamed output', { jobId, reason: verdict.reason });
                        // The client has already rendered what came before, so tell it to drop it.
                        res.write(`data: ${JSON.stringify({ blocked: true, replace: SAFE_FALLBACK })}\n\n`);
                        currentResponseChunk = SAFE_FALLBACK;
                        outputBlocked = true;
                        break;
                    }

                    currentResponseChunk += chunkText;
                    res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
                }

                // Recorded per attempt, win or lose, so a retried empty response still counts against the ceiling it's checked against next request.
                // No usage chunk (client disconnected mid-stream, or a provider that ignores stream_options) means nothing observed to record; recording 0 there would be a guess, not a measurement.
                if (attemptUsage) ledger.record(taskConfig.provider, model, attemptUsage.total_tokens || 0);

                if (outputBlocked) { clearHeartbeat(); fullResponseText = currentResponseChunk; responseValid = true; break; }

                clearHeartbeat();

                if (currentResponseChunk.trim()) {
                    fullResponseText = currentResponseChunk;
                    responseValid = true;
                    logger.info('LLM Response received', { attempt: attempt + 1, jobId });
                    break;
                } else {
                    logger.warn('LLM returned empty response. Retrying...', { attempt: attempt + 1, jobId });
                }

            } catch (llmError) {
                logger.error('LLM_STREAM_ERROR', { attempt: attempt + 1, jobId, error: llmError.message });

                clearHeartbeat();

                if (!res.writable || res.writableEnded) break;

                // Final attempt failed, rethrow to outer catch
                if (attempt === 2) {
                    throw llmError;
                }

                if (attempt === 1) {
                    logger.info('LLM: Waiting 5 seconds before final retry...', { jobId });
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        } // end retry loop

        if (responseValid) {
            try {
                if (chatId) {
                    await updateChatEntry(chatId, fullResponseText);
                    logger.debug("Chat history updated in MongoDB", { chatId });

                    await upsertChatPair(jobId, userPrompt, fullResponseText, chatId, ownerId);
                    logger.debug("Chat pair embedded successfully", { chatId });
                }
            } catch (dbError) {
                logger.error("MONGODB_UPDATE_ERROR", { jobId, chatId, error: dbError.message });
            }

            if (res.writable && !res.writableEnded) {
                res.write('data: {"event": "stream_end"}\n\n');
                res.end();
            }
            logger.info("LLM: Streaming complete", { jobId, chatId });

        } else {
            clearHeartbeat();
            logger.error("LLM failed to generate a response after all attempts", { jobId });
            if (res.writable && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ text: "I apologize, but I couldn't generate a response at this time. Please try again later." })}\n\n`);
                res.write('data: {"event": "stream_end"}\n\n');
                res.end();
            }
        }

    } catch (error) {
        logger.error("LLM_STREAM_ERROR (Phase 2)", { jobId, error: error.message });

        clearHeartbeat();

        const { status, message, code } = mapErrorToResponse(error);

        // CASE 1: Headers NOT sent yet -> Send standard JSON error
        if (!res.headersSent) {
            return res.status(status).json({
                error: {
                    type: 'server_error',
                    code: code,
                    message: message
                }
            });
        }

        // CASE 2: Headers ALREADY sent -> Send SSE error chunk
        if (res.writable && !res.writableEnded) {
            try {
                // Send a special error event that the frontend can listen for
                res.write(`event: error\n`);
                res.write(`data: ${JSON.stringify({ code, message })}\n\n`);
                res.end();
            } catch (writeErr) {
                logger.error("Failed to write error chunk to stream", { jobId, error: writeErr.message });
                // Force close if writing fails
                try { res.end(); } catch (_) { }
            }
        }
    }
};

module.exports = {
    getLLMStreamResponse, mapErrorToResponse };
