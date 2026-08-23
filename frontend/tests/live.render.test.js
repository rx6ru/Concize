const test = require('node:test');
const assert = require('node:assert');

const { partialTracker } = require('../live.render.js');

test('a partial is shown while it is the only thing there is', () => {
    const t = partialTracker();
    assert.strictEqual(t.onPartial({ text: 'we should ship' }), 'we should ship');
});

test('a later partial replaces the earlier one rather than stacking', () => {
    const t = partialTracker();
    t.onPartial({ text: 'we should' });
    assert.strictEqual(t.onPartial({ text: 'we should ship it' }), 'we should ship it');
    assert.strictEqual(t.pending, 'we should ship it');
});

test('a final clears the provisional line, because the final supersedes it', () => {
    // Measured: partials arrive at a 419ms median, finals at 6115ms. Without this the popup shows
    // nothing at all for six seconds while the system already has the words.
    const t = partialTracker();
    t.onPartial({ text: 'we should ship it' });
    t.onFinal({ turnId: 't1', text: 'We should ship it.' });
    assert.strictEqual(t.pending, null);
});

test('an empty partial does not blank a line that already has text', () => {
    const t = partialTracker();
    t.onPartial({ text: 'we should ship' });
    assert.strictEqual(t.onPartial({ text: '' }), 'we should ship');
});

test('live text keeps working after the first utterance finalises', () => {
    // The first version of this suppressed every partial once a turn had settled, which would
    // have left a meeting with live text for its opening sentence and nothing after it.
    const t = partialTracker();
    t.onPartial({ text: 'we should ship' });
    t.onFinal({ turnId: 't1', text: 'We should ship it.' });
    assert.strictEqual(t.pending, null);

    assert.strictEqual(t.onPartial({ text: 'and the price' }), 'and the price');
    t.onFinal({ turnId: 't2', text: 'And the price is settled.' });
    assert.strictEqual(t.pending, null);
});
