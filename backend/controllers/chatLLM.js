// db/mongoutils/chatLLM.js

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../utils/config');
const { queryTranscriptions, queryChats } = require('./queryVectordb');
// Import the new two-step chat database functions
const { createChatEntry, updateChatEntry } = require('../db/mongoutils/chat.db');
const { upsertChatPair } = require('./embedding/embedChat');

// Initialize the Google Generative AI client with the API key
const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);

// Use the specified Gemini model for streaming content
const llmModel = genAI.getGenerativeModel({
    model: "gemini-2.5-pro"
});

/**
 * Orchestrates the full RAG (Retrieval-Augmented Generation) process.
 * 1. Retrieves relevant context from Qdrant.
 * 2. Prepares a system prompt.
 * 3. Creates a new chat entry in the database for the user's prompt.
 * 4. Sends the prompt to the LLM via a streaming API.
 * 5. Streams the LLM's response back to the client using SSE.
 * 6. Collects the full LLM response and updates the chat entry in MongoDB.
 *
 * @param {Object} res - The Express response object for SSE streaming.
 * @param {string} userPrompt - The user's message/query.
 * @param {string} jobId - The unique ID of the current meeting session.
 */
const getLLMStreamResponse = async (res, userPrompt, jobId) => {
    let chatId = null; // Variable to hold the ID of the new chat entry

    try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering
        res.flushHeaders(); // Flush the headers to start the SSE stream

        // Step 1: Query relevant context from both collections
        const [transcriptionContext, chatHistory] = await Promise.all([
            queryTranscriptions(userPrompt, jobId, 5), // Get top 5 relevant transcription chunks
            queryChats(userPrompt, jobId, 3) // Get top 3 relevant chat pairs from Qdrant
        ]);

        console.log("LLM: Transcription Context:", transcriptionContext);
        console.log("LLM: Chat History:", chatHistory);

        // Step 2: Combine all contexts into a single string for the LLM
        const transcriptionText = transcriptionContext.length > 0
            ? transcriptionContext.map(chunk => `Transcription Snippet: ${chunk.text}`).join('\n')
            : "No relevant meeting transcriptions were found for this query.  Respond to user accordingly";

        const chatHistoryText = chatHistory.length > 0
            ? chatHistory.map(chat => `User: ${JSON.stringify(chat.userChat)}\nAI: ${chat.aiChat}`).join('\n')
            : "No relevant chat history was found for this query.  Respond to user accordingly";

        console.log("LLM: Transcription Text:", transcriptionText);
        console.log("LLM: Chat Text:", chatHistoryText);

        // This is the combined dynamic context and the user's question
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
            chatId = newChat._id; // Store the ID for the later update
            console.log(`Chat entry created with ID: ${chatId}`);
        } catch (dbError) {
            console.error("MONGODB_CREATE_ERROR:", dbError);
            res.write(`data: ${JSON.stringify({ text: "I apologize, but an error occurred while saving your message." })}\n\n`);
            res.write('data: {"event": "stream_end"}\n\n');
            return res.end(); // End the response early on a critical error
        }


        // Step 4: Use generateContentStream for a single, efficient call
        const result = await llmModel.generateContentStream({
            // The role and constraints are now defined in a dedicated system instruction
            system_instruction: {
                // CORRECTED: Use the 'parts' array to pass the system instruction text
                parts: [
                    {
                        text: `You are a helpful assistant for a meeting management application. Your primary goal is to answer user questions based on the provided meeting transcription snippets and chat history.

Instructions:
- Answer the user's question directly using information from the transcription snippets
- If the answer exists in the transcription, provide it clearly and completely
- If the answer cannot be found in the provided context, state that politely
- Use natural, conversational language
- Focus on the content of what was discussed in the meeting
- Do not mention that you are an AI assistant or refer to "provided context"`
                    }
                ]
            },
            contents: [{
                role: 'user',
                parts: [{ text: contentsPrompt }],
            }],
            generationConfig: {
                maxOutputTokens: 6000, // A reasonable limit to keep responses concise
                temperature: 0.4, // Low temperature for more factual and less creative responses
            },
        });

        let fullResponseText = '';

        // Add heartbeat to keep connection alive
        const heartbeatInterval = setInterval(() => {
            res.write(':heartbeat\n\n');
        }, 15000);

        try {
            // Step 5: Stream the LLM's response back to the client and collect chunks
            for await (const chunk of result.stream) {
                const chunkText = chunk.text();
                if (chunkText) {
                    fullResponseText += chunkText;
                    console.log(`LLM Response: ${chunkText}`);
                    // CORRECTED: Add the required '\n\n' to terminate each data message
                    res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
                }
            }
        } finally {
            clearInterval(heartbeatInterval);
        }

        // Step 6: After the stream ends, update the complete chat entry in MongoDB and create embedding
        try {
            if (chatId) {
                await updateChatEntry(chatId, fullResponseText);
                console.log("Chat history successfully updated in MongoDB.");

                // Create embedding for the chat pair
                await upsertChatPair(jobId, userPrompt, fullResponseText, chatId);
                console.log("Chat pair embedded successfully.");
            }
        } catch (dbError) {
            console.error("MONGODB_UPDATE_ERROR:", dbError);
            // Don't stop the stream, just log the error
        }

        // Signal the end of the stream
        res.write('data: {"event": "stream_end"}\n\n');
        res.end();
        console.log("LLM: Streaming complete.");

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
