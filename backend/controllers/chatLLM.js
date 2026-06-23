// controllers/chatLLM.js

const fs = require('fs');
const path = require('path');
const { getChatInference } = require('../utils/llm/inferenceProvider');
const { runResilient } = require('../utils/llm/resilientInference');
const { queryTranscriptions, queryChats } = require('../services/retrieval/vectorSearchService');
const { createChatEntry, updateChatEntry } = require('../db/queries/chat.db');
const { upsertChatPair } = require('../services/embedding/chatEmbedding');
const { getMeetingSummary } = require('../db/queries/summary.db');
const { createLogger } = require('../utils/logger');

const logger = createLogger('chatLLM');

// Security modules
const {
    validateInput,
    isRelevantToMeeting,
    recordViolation
} = require('../utils/llmSecurity');
const { SECURE_SYSTEM_PROMPT } = require('../.secrets/systemPrompt');



// Use hardened system prompt
const SYSTEM_PROMPT = SECURE_SYSTEM_PROMPT;


/**
 * Maps system errors to professional user-facing messages.
 * Uses structured error properties when available, falls back to message string matching.
 * @param {Error|Object} error - Error object (may have .status, .code, .error properties from APIs)
 * @returns {Object} { status, message, code }
 */
const mapErrorToResponse = (error) => {
    // Null-safe access
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
 * Orchestrates the full RAG process and streams the LLM response over SSE.
 * Implements "Category A" (Success Stream) vs "Category B" (JSON Error) logic.
 *
 * @param {Object} res - Express response object (SSE)
 * @param {string} userPrompt - The user's message/query
 * @param {string} jobId - Meeting/session id
 * @param {string} ownerId - Owning user id (tenant scoping for retrieval + embedding)
 */
const getLLMStreamResponse = async (res, userPrompt, jobId, ownerId) => {
    let chatId = null;
    let fullResponseText = '';
    let heartbeatInterval = null;

    // --- Phase 0: Security Validation (Category B Potential) ---
    // If security checks fail, return JSON error immediately.

    // Input Guardrails
    const inputCheck = validateInput(userPrompt);
    if (inputCheck.blocked) {
        recordViolation(jobId, inputCheck.reason, { query: userPrompt.substring(0, 100) });
        return res.status(400).json({ error: inputCheck.error });
    }

    // Relevance Filter (uses meeting summary)
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

    // --- Phase 1: Context Retrieval & Validation (Category B Potential) ---
    // If anything fails here, we send a JSON error response (4xx/5xx).
    // do NOT set SSE headers yet.

    let contentsPrompt = '';

    try {
        // Step 1: Gather context (Parallel)
        const [transcriptionContext, chatHistory, meetingSummary] = await Promise.all([
            queryTranscriptions(userPrompt, jobId, ownerId, 5),
            queryChats(userPrompt, jobId, ownerId, 3),
            getMeetingSummary(jobId)
        ]);


        const transcriptionText = transcriptionContext.length > 0
            ? transcriptionContext.map(chunk => `Transcription Snippet: ${chunk.text}`).join('\n')
            : "No specific meeting transcriptions were found for this query.";

        const chatHistoryText = chatHistory.length > 0
            ? chatHistory.map(chat => `User: ${JSON.stringify(chat.userChat)}\nAI: ${chat.aiChat}`).join('\n')
            : "No specific chat history was found for this query.";

        // Prepare Summary Context
        const summaryContext = meetingSummary
            ? `Title: ${meetingSummary.title}\nSummary: ${meetingSummary.content}`
            : "No summary available yet.";

        contentsPrompt =
            `# Meeting Summary (Current Context):
${summaryContext}

# Meeting Transcription Snippets (Specific Context):
${transcriptionText}

# Relevant Chat History:
${chatHistoryText}

# User's Question:
${userPrompt}`;

        // Step 2: Create chat entry in DB
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

    // --- Phase 2: Streaming (Category A) ---
    // At this point, context is ready and DB entry exists.
    // We commit to the 200 OK stream.

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
        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('X-Accel-Buffering', 'no');

        // Commit response headers
        res.flushHeaders();

        let responseValid = false;

        // Retry loop
        for (let attempt = 0; attempt < 3; attempt++) {
            if (res.writableEnded || !res.writable) {
                logger.warn('Client disconnected, aborting LLM retry loop', { jobId });
                break;
            }

            let currentResponseChunk = '';
            try {


                // Get inference client routed by config
                const { client, model, taskConfig } = getChatInference();
                logger.info('Inference attempt started', {
                    attempt: attempt + 1,
                    provider: taskConfig.provider,
                    model,
                    jobId
                });

                // Concurrency-limited via the per-provider Bottleneck limiter. maxRetries:0 — this is a
                // user-facing stream, so we don't add jittered backoff here; the outer loop owns retries.
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
                    }),
                    { maxRetries: 0 }
                );

                // Start heartbeat while streaming
                startHeartbeat();

                for await (const chunk of stream) {
                    if (res.writableEnded || !res.writable) break;

                    const chunkText = chunk.choices[0]?.delta?.content || '';
                    if (chunkText) {
                        currentResponseChunk += chunkText;
                        res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
                    }
                }

                // Clear heartbeat after this attempt's streaming finished
                clearHeartbeat();

                // If we gathered anything, accept and break retry loop
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

                // Ensure heartbeat cleared
                clearHeartbeat();

                // If client disconnected, stop trying
                if (!res.writable || res.writableEnded) break;

                // Final attempt failed — rethrow to outer catch
                if (attempt === 2) {
                    throw llmError;
                }

                // Delay before retry
                if (attempt === 1) {
                    logger.info('LLM: Waiting 5 seconds before final retry...', { jobId });
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        } // end retry loop

        // Update DB entries and embeddings if response is valid
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

            // End the stream
            if (res.writable && !res.writableEnded) {
                res.write('data: {"event": "stream_end"}\n\n');
                res.end();
            }
            logger.info("LLM: Streaming complete", { jobId, chatId });

        } else {
            // No valid response after retries (Mid-stream failure)
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

        // Ensure heartbeat cleared
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
        // Can only do this if stream is still writable
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
    getLLMStreamResponse,
};
