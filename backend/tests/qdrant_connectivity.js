// tests/qdrant_connectivity.js
const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../utils/config');

async function checkConnection() {
    console.log('--- Checking Qdrant Connectivity ---');
    console.log(`URL: ${config.QDRANT_URL}`);
    console.log(`Collection: ${config.TRANSCRIPTION_COLLECTION}`);

    try {
        const client = new QdrantClient({
            url: config.QDRANT_URL,
            apiKey: config.QDRANT_API_KEY,
            timeout: 10000, // Explicitly matching the user's 10s timeout
        });

        console.log('Attempting to list collections...');
        const collections = await client.getCollections();
        console.log(`✅ Success! Found ${collections.collections.length} collections.`);
        console.log('Collections:', collections.collections.map(c => c.name).join(', '));

        // Try a Search (dummy)
        console.log(`Attempting dummy search on ${config.TRANSCRIPTION_COLLECTION}...`);
        const result = await client.search(config.TRANSCRIPTION_COLLECTION, {
            vector: new Array(768).fill(0.01),
            limit: 1
        });
        console.log(`✅ Search Success! Found ${result.length} results.`);

    } catch (error) {
        console.error('❌ Connection Failed:', error);
        if (error.cause) {
            console.error('Cause:', error.cause);
        }
    }
}

checkConnection();
