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
            headers: headers,
            timeout: 5000
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

        req.on('timeout', () => {
            req.destroy();
            console.error(`[${description}] Error: Request timeout`);
            resolve({ error: new Error('Request timeout') });
        });

        req.end();
    });
};

const runTests = async () => {
    console.log('--- Starting Auth Middleware Tests (Headers Only) ---');
    let failureCount = 0;

    console.log('\n1. Testing Unauthorized Request (No Code)');
    const test1 = await makeRequest('/api/worker/status', 'GET', {}, 'Unauthorized Request');
    if (test1.status !== 401 && test1.status !== 403) {
        console.error(`  ❌ FAILED: Expected 401/403, got ${test1.status}`);
        failureCount++;
    } else {
        console.log(`  ✓ PASSED`);
    }

    console.log('\n2. Testing Unauthorized Request (Invalid Code)');
    const test2 = await makeRequest('/api/worker/status', 'GET', { 'x-auth-code': 'wrong-code' }, 'Invalid Code Request');
    if (test2.status !== 401 && test2.status !== 403) {
        console.error(`  ❌ FAILED: Expected 401/403, got ${test2.status}`);
        failureCount++;
    } else {
        console.log(`  ✓ PASSED`);
    }

    console.log('\n3. Testing Authorized Request (Header)');
    const test3 = await makeRequest('/api/worker/status', 'GET', { 'x-auth-code': AUTH_CODE }, 'Authorized Header Request');
    if (test3.status !== 200 && test3.status !== 404) {
        console.error(`  ❌ FAILED: Expected 200/404, got ${test3.status}`);
        failureCount++;
    } else {
        console.log(`  ✓ PASSED`);
    }

    console.log('\n4. Testing Blocked Request (Query Param - Should Fail now)');
    const test4 = await makeRequest(`/api/worker/status?authCode=${AUTH_CODE}`, 'GET', {}, 'Query Param Request');
    if (test4.status !== 401 && test4.status !== 403) {
        console.error(`  ❌ FAILED: Expected 401/403, got ${test4.status}`);
        failureCount++;
    } else {
        console.log(`  ✓ PASSED`);
    }

    console.log('\n--- Tests Complete ---');
    if (failureCount > 0) {
        console.error(`\n❌ ${failureCount} test(s) failed`);
        process.exit(1);
    } else {
        console.log(`\n✓ All tests passed`);
        process.exit(0);
    }
};

// Wait for server to start
setTimeout(runTests, 2000);
