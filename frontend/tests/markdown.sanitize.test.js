const test = require('node:test');
const assert = require('node:assert');

const { renderSafe } = require('../markdown.sanitize.js');

// Attack shapes a meeting transcript (or a model reflecting it back) could contain.

test('an <img> with onerror never becomes a real element', () => {
    const out = renderSafe('<img src=x onerror=alert(1)>');
    assert.ok(!/<img/i.test(out), `img tag survived: ${out}`);
    assert.ok(out.includes('&lt;img'), `raw tag was not escaped to visible text: ${out}`);
});

test('a remote markdown image never fetches: no <img> tag is emitted', () => {
    const out = renderSafe('![pixel](https://evil.example.com/track.png)');
    assert.ok(!/<img/i.test(out), `img tag survived: ${out}`);
    assert.ok(out.includes('pixel'), `alt text was dropped: ${out}`);
});

test('a remote raw-HTML <img> also never fetches', () => {
    const out = renderSafe('<img src="https://evil.example.com/track.png">');
    assert.ok(!/<img/i.test(out), `img tag survived: ${out}`);
});

test('an <a href="javascript:..."> link is neutralized, not just its text kept', () => {
    const out = renderSafe('<a href="javascript:alert(1)">click</a>');
    // The escaped text visibly contains the word "javascript:" (that's fine, it's inert
    // characters); what must never appear is a live, unescaped href attribute carrying it.
    assert.ok(!/<a\s/i.test(out), `anchor tag survived: ${out}`);
    assert.ok(!/href\s*=\s*"javascript:/i.test(out), `a live javascript: href survived: ${out}`);
});

test('a markdown link to a javascript: URL renders as plain text, not a link', () => {
    const out = renderSafe('[click me](javascript:alert(1))');
    assert.ok(!/<a\s/i.test(out), `anchor tag survived: ${out}`);
    assert.ok(out.includes('click me'), `link text was dropped: ${out}`);
});

test('an <iframe> is escaped, not embedded', () => {
    const out = renderSafe('<iframe src="https://evil.example.com"></iframe>');
    assert.ok(!/<iframe/i.test(out), `iframe tag survived: ${out}`);
    assert.ok(out.includes('&lt;iframe'), `raw tag was not escaped to visible text: ${out}`);
});

test('a <script> tag never executes: it is escaped to visible text', () => {
    const out = renderSafe('<script>alert(1)</script>');
    assert.ok(!/<script/i.test(out), `script tag survived: ${out}`);
    assert.ok(out.includes('&lt;script&gt;'), `raw tag was not escaped to visible text: ${out}`);
});

test('an event handler attribute on an otherwise benign tag is neutralized', () => {
    const out = renderSafe('<div onclick="alert(1)">hi</div>');
    // Same distinction: the escaped text visibly contains the word "onclick", which is inert;
    // what must never appear is a live div element carrying a real onclick attribute.
    assert.ok(!/<div\s/i.test(out), `div tag survived: ${out}`);
    assert.ok(!/onclick\s*=\s*"/i.test(out), `a live onclick attribute survived: ${out}`);
});

test('a data: URL link is dropped to plain text, including one carrying an embedded <script>', () => {
    const out = renderSafe('[data link](data:text/html,<script>alert(1)</script>)');
    assert.ok(!/<a\s/i.test(out), `anchor tag survived: ${out}`);
    assert.ok(!/<script/i.test(out), `embedded script from the URL leaked into the DOM: ${out}`);
    assert.ok(out.includes('data link'), `link text was dropped: ${out}`);
});

// Case and whitespace bypasses of the scheme check.

test('an uppercase/mixed-case javascript: scheme is still blocked', () => {
    const out = renderSafe('[x](JaVaScRiPt:alert(1))');
    assert.ok(!/<a\s/i.test(out), `anchor tag survived: ${out}`);
});

test('a javascript: scheme with a leading space is still blocked', () => {
    const out = renderSafe('[x](  javascript:alert(1))');
    assert.ok(!/<a\s/i.test(out), `anchor tag survived: ${out}`);
});

// Ordinary markdown a user actually wants must keep working.

test('bold and italic markdown still render as real elements', () => {
    const out = renderSafe('**bold** and *italic*');
    assert.ok(out.includes('<strong>bold</strong>'), out);
    assert.ok(out.includes('<em>italic</em>'), out);
});

test('lists still render', () => {
    const out = renderSafe('- one\n- two\n- three');
    assert.ok(out.includes('<ul>'), out);
    assert.ok((out.match(/<li>/g) || []).length === 3, out);
});

test('fenced code blocks still render, with their content escaped', () => {
    const out = renderSafe('```js\nconsole.log(1)\n```');
    assert.ok(out.includes('<pre><code'), out);
    assert.ok(out.includes('console.log(1)'), out);
});

test('a normal https link still renders as a real, clickable link', () => {
    const out = renderSafe('[docs](https://example.com/page)');
    assert.ok(out.includes('<a href="https://example.com/page">docs</a>'), out);
});

test('a normal http link still renders as a real, clickable link', () => {
    const out = renderSafe('[docs](http://example.com/page)');
    assert.ok(out.includes('<a href="http://example.com/page">docs</a>'), out);
});

test('a mailto link still renders', () => {
    const out = renderSafe('[email me](mailto:a@b.com)');
    assert.ok(out.includes('<a href="mailto:a@b.com">email me</a>'), out);
});

test('nested formatting inside a link still renders', () => {
    const out = renderSafe('[**bold** link text](https://example.com)');
    assert.ok(out.includes('<a href="https://example.com"><strong>bold</strong> link text</a>'), out);
});
