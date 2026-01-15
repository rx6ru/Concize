const config = require('../utils/config');
const groqService = require('../utils/llm/groqService');

async function listModels() {
    console.log("=== Listing Groq Models ===");
    try {
        const groq = groqService.getClient();
        const response = await groq.models.list();

        console.log("Available Models:");
        const modelIds = response.data.map(m => m.id);
        modelIds.forEach(id => console.log(` - ${id}`));

        const target = "openai/gpt-oss-120b";
        if (modelIds.includes(target)) {
            console.log(`\n✅ '${target}' IS a valid model.`);
        } else {
            console.log(`\n❌ '${target}' is NOT found in the model list.`);
            console.log("Did you mean: 'llama3-70b-8192', 'mixtral-8x7b-32768', etc?");
        }
    } catch (e) {
        console.error("Error listing models:", e.message);
    }
}

listModels();
