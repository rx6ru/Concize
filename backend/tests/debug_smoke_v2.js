// debug_smoke_v2.js
const { GoogleGenAI } = require('@google/genai');
const config = require('../utils/config');

async function testEmbedding() {
    console.log('\n--- Debugging Embedding Params ---');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemini-embedding-001';

    // Test 1: Flat params (Current approach)
    try {
        const res = await ai.models.embedContent({
            model,
            contents: [{ parts: [{ text: "test" }] }],
            outputDimensionality: 768
        });
        const vec = res.embedding?.values;
        console.log(`Test 1 (Flat): Vector length = ${vec?.length}`);
    } catch (e) { console.log('Test 1 failed', e.message); }

    // Test 2: Nested config (Common in some SDKs)
    try {
        const res = await ai.models.embedContent({
            model,
            contents: [{ parts: [{ text: "test" }] }],
            config: { outputDimensionality: 768 }
        });
        const vec = res.embedding?.values;
        console.log(`Test 2 (Nested config): Vector length = ${vec?.length}`);
    } catch (e) { console.log('Test 2 failed', e.message); }

    // Test 3: Snake case param
    try {
        const res = await ai.models.embedContent({
            model,
            contents: [{ parts: [{ text: "test" }] }],
            output_dimensionality: 768
        });
        const vec = res.embedding?.values;
        console.log(`Test 3 (Snake case): Vector length = ${vec?.length}`);
    } catch (e) { console.log('Test 3 failed', e.message); }
}

async function testChat() {
    console.log('\n--- Debugging Chat Response ---');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemini-2.5-flash-lite';

    try {
        const res = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: "Hi" }] }]
        });

        console.log('Chat Response Keys:', Object.keys(res));
        // Check if there's a response object inside
        // usually res itself is the response-like object in new SDK
        console.log('res.text() exists?', typeof res.text === 'function');
        console.log('res.candidates exists?', !!res.candidates);

        if (typeof res.text === 'function') console.log('Text via res.text():', res.text());
    } catch (e) { console.log('Chat debug failed', e); }
}

async function run() {
    await testEmbedding();
    await testChat();
}
run();
