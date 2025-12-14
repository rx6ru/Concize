require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 3000;
// Read from environment to match actual config, fallback to temp001
const AUTH_CODE = process.env.ALLOWED_AUTH_CODES?.split(',')[0]?.trim() || 'temp001';

const makeRequest = (path, method, headers, description) => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'localhost',
            port: PORT,
            path: path,
            method: method,
            headers: headers
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                console.log(`[${description}] Status: ${res.statusCode}`);
                if (res.statusCode !== 200 && res.statusCode !== 404 && res.statusCode !== 202) {
                    // console.log(`Response: ${data}`);
                }
                resolve({ status: res.statusCode, body: data });
            });
        });

        req.on('error', (e) => {
            console.error(`[${description}] Error: ${e.message}`);
            resolve({ error: e });
        });

        req.end();
    });
};

const runTests = async () => {
    console.log('--- Starting Auth Middleware Tests (Headers Only) ---');

    console.log('\n1. Testing Unauthorized Request (No Code)');
    await makeRequest('/api/worker/status', 'GET', {}, 'Unauthorized Request');

    console.log('\n2. Testing Unauthorized Request (Invalid Code)');
    await makeRequest('/api/worker/status', 'GET', { 'x-auth-code': 'wrong-code' }, 'Invalid Code Request');

    console.log('\n3. Testing Authorized Request (Header)');
    await makeRequest('/api/worker/status', 'GET', { 'x-auth-code': AUTH_CODE }, 'Authorized Header Request');

    console.log('\n4. Testing Blocked Request (Query Param - Should Fail now)');
    await makeRequest(`/api/worker/status?authCode=${AUTH_CODE}`, 'GET', {}, 'Query Param Request');

    console.log('\n--- Tests Complete ---');
    process.exit(0);
};

// Wait for server to start
setTimeout(runTests, 2000);
