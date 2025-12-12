// debug_smoke_v3.js
const { GoogleGenAI } = require('@google/genai');
const config = require('../utils/config');

async function testEmbedding() {
    console.log('\n=== Debugging Embedding Structure ===');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemini-embedding-001';

    try {
        // Trying config format which is standard for new SDK
        const res = await ai.models.embedContent({
            model,
            contents: [{ parts: [{ text: "test" }] }],
            config: { outputDimensionality: 768 }
        });
        console.log('Embedding Response keys:', Object.keys(res));
        console.log('Full Embedding Response:', JSON.stringify(res, null, 2));
    } catch (e) { console.log('Embedding failed', e.message); }
}

async function testChatStream() {
    console.log('\n=== Debugging Chat Streaming ===');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemini-2.5-flash-lite';

    try {
        console.log('Starting stream...');
        const streamResp = await ai.models.generateContentStream({
            model,
            contents: [{ role: 'user', parts: [{ text: "Hi" }] }]
        });

        for await (const chunk of streamResp.stream) {
            console.log('Chunk keys:', Object.keys(chunk));
            console.log('Chunk text() exists?', typeof chunk.text === 'function');
            if (typeof chunk.text === 'function') {
                console.log('Chunk text:', chunk.text());
                break; // Just need one to verify
            } else {
                console.log('Chunk content:', JSON.stringify(chunk, null, 2));
                break;
            }
        }
    } catch (e) { console.log('Chat stream debug failed', e); }
}

async function run() {
    await testEmbedding();
    await testChatStream();
}
run();
