// tests/repro_issue_400.js
const { GoogleGenAI } = require('@google/genai');
const config = require('../utils/config');

async function reproduce() {
    console.log('--- Reproduction Test for 400 (Invalid Role) ---');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const model = 'gemini-2.5-flash'; // Using the model user switched to

    const systemContent = {
        role: 'system',
        parts: [{ text: "You are a system." }]
    };

    const userContent = {
        role: 'user',
        parts: [{ text: "Hello" }]
    };

    try {
        console.log('Attempting to send system role in contents array...');
        await ai.models.generateContent({
            model,
            contents: [systemContent, userContent]
        });
        console.log('❌ Unexpected Success: API accepted system role in contents.');
    } catch (error) {
        if (error.message && error.message.includes('valid role')) {
            console.log('✅ Reproduction Success: Caught expected 400 error about invalid role.');
            console.log('Error Message:', error.message);
        } else {
            console.log('❓ Caught different error:', error);
        }
    }
}

reproduce();
