// db/mongoutils/chatLLM.js

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../utils/config');
const { queryTranscriptions, queryChats } = require('./queryVectordb');
const { createChatEntry, updateChatEntry } = require('../db/mongoutils/chat.db');
const { upsertChatPair } = require('./embedding/embedChat');

// Initialize the Google Generative AI client with the API key
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// Use the specified Gemini model for streaming content
const llmModel = genAI.getGenerativeModel({
    model: "gemini-2.5-pro" // Corrected model to one that supports Google Search
});

/**
 * Orchestrates the full RAG (Retrieval-Augmented Generation) process with Google Search and a retry mechanism.
 * 1. Retrieves relevant context from Qdrant.
 * 2. Prepares a system prompt.
 * 3. Creates a new chat entry in the database for the user's prompt.
 * 4. Sends the prompt to the LLM via a streaming API with Google Search enabled, retrying once on an empty response.
 * 5. Streams the LLM's response back to the client using SSE.
 * 6. Collects the full LLM response and updates the chat entry in MongoDB.
 *
 * @param {Object} res - The Express response object for SSE streaming.
 * @param {string} userPrompt - The user's message/query.
 * @param {string} jobId - The unique ID of the current meeting session.
 */
const getLLMStreamResponse = async (res, userPrompt, jobId) => {
    let chatId = null;
    let fullResponseText = '';

    try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Step 1: Query relevant context from both collections
        const [transcriptionContext, chatHistory] = await Promise.all([
            queryTranscriptions(userPrompt, jobId, 5),
            queryChats(userPrompt, jobId, 3)
        ]);

        console.log("LLM: Transcription Context:", transcriptionContext);
        console.log("LLM: Chat History:", chatHistory);

        // Step 2: Combine all contexts into a single string for the LLM
        const transcriptionText = transcriptionContext.length > 0
            ? transcriptionContext.map(chunk => `Transcription Snippet: ${chunk.text}`).join('\n')
            : "No specific meeting transcriptions were found for this query.";

        const chatHistoryText = chatHistory.length > 0
            ? chatHistory.map(chat => `User: ${JSON.stringify(chat.userChat)}\nAI: ${chat.aiChat}`).join('\n')
            : "No specific chat history was found for this query.";

        console.log("LLM: Transcription Text:", transcriptionText);
        console.log("LLM: Chat Text:", chatHistoryText);

        const contentsPrompt =
            `# Meeting Transcription Context:
${transcriptionText}

# Relevant Chat History:
${chatHistoryText}

# User's Question:
${userPrompt}`;

        console.log("LLM: Generating a streaming response...");

        // Step 3: Create the chat entry in MongoDB before generating the response
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

        const tools = [{
            googleSearch: {}
        }];

        const systemInstruction = {
            parts: [{
                text: `You are a helpful assistant for a meeting management application. Your primary goal is to answer user questions.
First, use the provided meeting transcription snippets and chat history to answer the question.
If the answer cannot be found in the provided context, you may use your search tool to find the answer from external sources.
Provide clear and complete answers. If you use the search tool, you may cite your sources.
Do not mention that you are an AI assistant or refer to "provided context".`
            }]
        };

        const generationConfig = {
            maxOutputTokens: 6000,
            temperature: 0.4,
        };

        let responseValid = false;

        // Start of Retry Logic
        for (let attempt = 0; attempt < 2; attempt++) {
            let currentResponseChunk = '';
            try {
                const result = await llmModel.generateContentStream({
                    // tools: tools,
                    system_instruction: systemInstruction,
                    contents: [{
                        role: 'user',
                        parts: [{ text: contentsPrompt }],
                    }],
                    generationConfig: generationConfig,
                });
                
                // Step 5: Stream the LLM's response back to the client and collect chunks
                for await (const chunk of result.stream) {
                    if (chunk.text) {
                        const chunkText = chunk.text();
                        currentResponseChunk += chunkText;
                        res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
                    }
                }

                // Check if the current response is valid
                if (currentResponseChunk.trim()) {
                    fullResponseText = currentResponseChunk;
                    responseValid = true;
                    console.log(`LLM Response received on attempt ${attempt + 1}.`);
                    break; // Success, exit the retry loop
                } else {
                    console.log(`LLM returned empty response on attempt ${attempt + 1}. Retrying...`);
                }

            } catch (llmError) {
                console.error(`LLM_STREAM_ERROR on attempt ${attempt + 1}:`, llmError);
                if (attempt === 1) { // If this is the last attempt, re-throw the error
                    throw llmError;
                }
            }
        }
        // End of Retry Logic

        // A heartbeat is not needed during the retry loop as the initial connection might close.
        // Start the heartbeat only if a response is being streamed.
        if (responseValid) {
            const heartbeatInterval = setInterval(() => {
                res.write(':heartbeat\n\n');
            }, 15000);
        }


        // Step 6: After the stream ends, update the complete chat entry
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
            
            // Signal the end of the stream
            res.write('data: {"event": "stream_end"}\n\n');
            res.end();
            console.log("LLM: Streaming complete.");
        
        } else {
            // Handle final failure after all retries
            console.log("LLM failed to generate a response after all attempts.");
            res.write(`data: ${JSON.stringify({ text: "I apologize, but I couldn't generate a response at this time. Please try again later." })}\n\n`);
            res.write('data: {"event": "stream_end"}\n\n');
            res.end();
        }

    } catch (error) {
        console.error("LLM_STREAM_ERROR:", error);
        res.write(`data: ${JSON.stringify({ text: "I apologize, but an error occurred while processing your request. Please try again later." })}\n\n`);
        res.write('data: {"event": "stream_end"}\n\n');
        res.end();
    }
};

module.exports = {
    getLLMStreamResponse,
};