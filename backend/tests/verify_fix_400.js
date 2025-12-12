// tests/verify_fix_400.js
const { GoogleGenAI } = require('@google/genai');
const config = require('../utils/config');

async function verify() {
    console.log('--- Verification Test for System Role Fix ---');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemini-2.5-flash';

    const systemInstruction = "You are a helpful assistant.";

    const userContent = {
        role: 'user',
        parts: [{ text: "Hello" }]
    };

    try {
        console.log('Attempting to send system instruction via config...');
        const res = await ai.models.generateContent({
            model,
            contents: [userContent],
            config: {
                systemInstruction: systemInstruction
            }
        });
        console.log('✅ Success: API accepted system instruction via config.');

        // Access text properly
        const text = res.response ? res.response.text() : res.text();
        console.log('Response:', text ? text.trim() : "No text (but no error)");

    } catch (error) {
        console.error('❌ Failed:', error.message);
        if (error.message.includes("429")) {
            console.log("⚠️ Note: 429 is expected if quota is exhausted, but 400 is GONE.");
        }
    }
}

verify();
