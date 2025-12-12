// db/mongoutils/chatLLM.js

const { GoogleGenAI } = require('@google/genai');
const config = require('../utils/config');
const keyRotation = require('../utils/keyRotation');
const { queryTranscriptions, queryChats } = require('./queryVectordb');
const { createChatEntry, updateChatEntry } = require('../db/mongoutils/chat.db');
const { upsertChatPair } = require('./embedding/embedChat');

// Model id to use
const MODEL_ID = "gemini-2.5-flash";

/**
 * Orchestrates the full RAG process and streams the LLM response over SSE.
 *
 * @param {Object} res - Express response object (SSE)
 * @param {string} userPrompt - The user's message/query
 * @param {string} jobId - Meeting/session id
 */
const getLLMStreamResponse = async (res, userPrompt, jobId) => {
    let chatId = null;
    let fullResponseText = '';
    let heartbeatInterval = null;

    const startHeartbeat = () => {
        if (heartbeatInterval) return;
        heartbeatInterval = setInterval(() => {
            try {
                res.write(':heartbeat\n\n');
            } catch (e) {
                // ignore write errors
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
        res.flushHeaders();

        // Step 1: gather context
        const [transcriptionContext, chatHistory] = await Promise.all([
            queryTranscriptions(userPrompt, jobId, 5),
            queryChats(userPrompt, jobId, 3)
        ]);

        const transcriptionText = transcriptionContext.length > 0
            ? transcriptionContext.map(chunk => `Transcription Snippet: ${chunk.text}`).join('\n')
            : "No specific meeting transcriptions were found for this query.";

        const chatHistoryText = chatHistory.length > 0
            ? chatHistory.map(chat => `User: ${JSON.stringify(chat.userChat)}\nAI: ${chat.aiChat}`).join('\n')
            : "No specific chat history was found for this query.";

        const contentsPrompt =
            `# Meeting Transcription Context:
${transcriptionText}

# Relevant Chat History:
${chatHistoryText}

# User's Question:
${userPrompt}`;

        // Step 3: create chat entry in DB
        try {
            const newChat = await createChatEntry(jobId, userPrompt);
            chatId = newChat._id;
            console.log(`Chat entry created with ID: ${chatId}`);
        } catch (dbError) {
            console.error("MONGODB_CREATE_ERROR:", dbError);
            res.write(`data: ${JSON.stringify({ text: "I apologize, but an error occurred while saving your message." })}\n\n`);
            res.write('data: {"event": "stream_end"}\n\n');
            return res.end();
        }

        // Tools (if any)
        const tools = [{ googleSearch: {} }];

        // System content
        const systemContent = {
            role: 'system',
            parts: [{
                text: `You are a helpful assistant for a meeting management application. Your primary goal is to answer user questions.
First, use the provided meeting transcription snippets and chat history to answer the question.
If the answer cannot be found in the provided context, you may use your search tool to find the answer from external sources.
Provide clear and complete answers. If you use the search tool, you may cite your sources.
Do not mention that you are an AI assistant or refer to "provided context".`
            }]
        };

        // Generation parameters
        const generationConfig = {
            temperature: 0.4,
            maxOutputTokens: 6000
        };

        let responseValid = false;

        // Retry loop
        for (let attempt = 0; attempt < 3; attempt++) {
            let currentResponseChunk = '';
            try {
                // Get a rotated key for this attempt (Failover support)
                const currentKey = keyRotation.getNextKey();
                const ai = new GoogleGenAI({ apiKey: currentKey });

                const streamResponse = await ai.models.generateContentStream({
                    model: MODEL_ID,
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: contentsPrompt }]
                        }
                    ],
                    config: {
                        systemInstruction: systemContent.parts[0].text,
                        generationConfig: generationConfig,
                        tools: tools,
                    }
                });

                // Determine the async iterable to use (handle SDK minor differences)
                const iterable = streamResponse?.stream ?? streamResponse;

                // Start heartbeat while streaming
                startHeartbeat();

                // Iterate streaming chunks as they arrive
                for await (const chunk of iterable) {
                    // Robust extraction: chunk.text may be a string or a function
                    let chunkText = '';
                    try {
                        if (!chunk) continue;

                        // Robust extraction for @google/genai stream chunk
                        if (typeof chunk.text === 'function') {
                            chunkText = chunk.text();
                        } else if (chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts && chunk.candidates[0].content.parts[0].text) {
                            chunkText = chunk.candidates[0].content.parts[0].text;
                        } else if (typeof chunk.text === 'string') {
                            chunkText = chunk.text;
                        }
                    } catch (e) {
                        console.warn('Warning: failed to decode chunk text', e);
                        chunkText = '';
                    }

                    if (chunkText) {
                        currentResponseChunk += chunkText;
                        // Stream chunk to client
                        res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
                    }
                }

                // Clear heartbeat after this attempt's streaming finished
                clearHeartbeat();

                // If we gathered anything, accept and break retry loop
                if (currentResponseChunk.trim()) {
                    fullResponseText = currentResponseChunk;
                    responseValid = true;
                    console.log(`LLM Response received on attempt ${attempt + 1}.`);
                    break;
                } else {
                    console.log(`LLM returned empty response on attempt ${attempt + 1}. Retrying...`);
                }

            } catch (llmError) {
                console.error(`LLM_STREAM_ERROR on attempt ${attempt + 1}:`, llmError);

                // Ensure heartbeat cleared if an error occurred mid-stream
                clearHeartbeat();

                // Final attempt failed — rethrow to outer catch
                if (attempt === 2) {
                    throw llmError;
                }

                // Delay before final retry (mirror previous behavior)
                if (attempt === 1) {
                    console.log("LLM: Waiting 31 seconds before final retry...");
                    await new Promise(resolve => setTimeout(resolve, 31000));
                }
            }
        } // end retry loop

        // Update DB entries and embeddings if response is valid
        if (responseValid) {
            try {
                if (chatId) {
                    await updateChatEntry(chatId, fullResponseText);
                    console.log("Chat history successfully updated in MongoDB.");

                    await upsertChatPair(jobId, userPrompt, fullResponseText, chatId);
                    console.log("Chat pair embedded successfully.");
                }
            } catch (dbError) {
                console.error("MONGODB_UPDATE_ERROR:", dbError);
            }

            // End the stream
            res.write('data: {"event": "stream_end"}\n\n');
            res.end();
            console.log("LLM: Streaming complete.");

        } else {
            // No valid response after retries
            clearHeartbeat();
            console.log("LLM failed to generate a response after all attempts.");
            res.write(`data: ${JSON.stringify({ text: "I apologize, but I couldn't generate a response at this time. Please try again later." })}\n\n`);
            res.write('data: {"event": "stream_end"}\n\n');
            res.end();
        }

    } catch (error) {
        console.error("LLM_STREAM_ERROR:", error);
        try {
            // Ensure heartbeat cleared and send error to client
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            res.write(`data: ${JSON.stringify({ text: "I apologize, but an error occurred while processing your request. Please try again later." })}\n\n`);
            res.write('data: {"event": "stream_end"}\n\n');
            res.end();
        } catch (e) {
            try { res.end(); } catch (_) { }
        }
    }
};

module.exports = {
    getLLMStreamResponse,
};
