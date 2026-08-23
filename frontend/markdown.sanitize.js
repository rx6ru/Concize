// Hardens marked before chat-popup.js drops its output into innerHTML.
//
// marked v15 (marked.min.js, vendored) does not sanitize: Renderer.prototype.html returns raw
// HTML from the markdown source unchanged, and Renderer.prototype.link/image only run the URL
// through encodeURI, never a scheme check. A meeting participant's transcribed words become the
// chat model's context, so an <img>, a javascript: link, or any other tag typed into a question
// or reflected in an answer would render as-is. marked dropped its own `sanitize` option years
// ago and now tells callers to sanitize the output themselves (see marked's USING_PRO.md).
//
// This overrides marked's renderer instead of adding a second parser over its output:
// - Raw HTML from the markdown source is escaped, not passed through, so <script>, <iframe>,
//   event handler attributes, and similar are neutralized wholesale rather than tag-by-tag.
// - Markdown images never become <img>: the URL is not fetched, so a remote image can't act as
//   a tracking pixel. Only the alt text renders.
// - Markdown/autolink links keep only http:, https:, and mailto: targets; anything else (a
//   javascript: URL, a data: URL, a relative path) renders as plain text instead of a link.
// Everything else (bold, italic, lists, code, tables, blockquote, headings) is untouched: marked
// already escapes the text content of those by default.

(function (root) {
    const markedLib = (typeof require === 'function' && typeof module !== 'undefined')
        ? require('./marked.min.js')
        : root.marked;

    const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Browsers ignore tab/newline/carriage-return anywhere in a URL when reading its scheme
    // (the classic "java\tscript:" bypass), so strip those before checking rather than after.
    function isSafeUrl(href) {
        if (typeof href !== 'string') return false;
        const stripped = href.replace(/[\t\n\r]/g, '').trim();
        const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
        if (!match) return false;
        return SAFE_PROTOCOLS.has(match[1].toLowerCase() + ':');
    }

    markedLib.use({
        renderer: {
            html({ text }) {
                return escapeHtml(text);
            },
            link({ href, title, tokens }) {
                const inner = this.parser.parseInline(tokens);
                if (!isSafeUrl(href)) return inner;
                let out = '<a href="' + escapeHtml(href) + '"';
                if (title) out += ' title="' + escapeHtml(title) + '"';
                out += '>' + inner + '</a>';
                return out;
            },
            image({ text, tokens }) {
                // this.parser.textRenderer strips nested markup without escaping, matching
                // marked's own default image() before it wraps the result in <img alt="...">.
                const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : (text || '');
                return escapeHtml(alt);
            },
        },
    });

    function renderSafe(text) {
        return markedLib.parse(text);
    }

    const api = { renderSafe };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) Object.assign(root, { ConcizeMarkdown: api });
}(typeof self !== 'undefined' ? self : null));
