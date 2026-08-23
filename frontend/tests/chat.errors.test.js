const test = require('node:test');
const assert = require('node:assert');

const { labelForCode } = require('../chat.errors.js');

test('a known backend code gets its own distinct label', () => {
    assert.strictEqual(labelForCode('RATE_LIMIT_EXCEEDED'), 'Busy');
    assert.strictEqual(labelForCode('UNAUTHORIZED'), 'Session');
    assert.strictEqual(labelForCode('SERVICE_TIMEOUT'), 'Connection');
    assert.strictEqual(labelForCode('TEMPORARILY_BLOCKED'), 'Blocked');
    assert.strictEqual(labelForCode('PROMPT_INJECTION'), 'Blocked');
    assert.strictEqual(labelForCode('QUERY_NOT_RELEVANT'), 'Off-topic');
    assert.strictEqual(labelForCode('RETRIEVAL_UNAVAILABLE'), 'Search Down');
});

test('different codes do not collapse onto the same label as each other by accident', () => {
    const codes = ['RATE_LIMIT_EXCEEDED', 'UNAUTHORIZED', 'SERVICE_TIMEOUT', 'QUERY_NOT_RELEVANT'];
    const labels = new Set(codes.map((c) => labelForCode(c)));
    assert.strictEqual(labels.size, codes.length);
});

test('an unrecognized or missing code falls back to the default label', () => {
    assert.strictEqual(labelForCode('SOMETHING_NEW'), 'Error');
    assert.strictEqual(labelForCode(undefined), 'Error');
    assert.strictEqual(labelForCode(null), 'Error');
});

test('the fallback label is overridable per call site', () => {
    assert.strictEqual(labelForCode(undefined, 'Connection Lost'), 'Connection Lost');
    assert.strictEqual(labelForCode('UNAUTHORIZED', 'Connection Lost'), 'Session');
});
