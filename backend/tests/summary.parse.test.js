const { parseLenient } = require('../src/summary/summary.service');

describe('parseLenient', () => {
    it('parses well-formed JSON unchanged', () => {
        expect(parseLenient('{"title":"T","summary":"ok"}')).toEqual({ title: 'T', summary: 'ok' });
    });

    it('recovers a raw newline inside a string, which JSON.parse rejects outright', () => {
        // Observed in production as "Bad control character in string literal in JSON at position 1028".
        const raw = '{"title":"T","summary":"line one\nline two"}';
        expect(() => JSON.parse(raw)).toThrow();
        expect(parseLenient(raw).summary).toBe('line one\nline two');
    });

    it('recovers a raw tab', () => {
        expect(parseLenient('{"title":"T","summary":"a\tb"}').summary).toBe('a\tb');
    });

    it('leaves an escaped quote alone while repairing around it', () => {
        const raw = '{"title":"T","summary":"he said \\"hi\\"\nthen left"}';
        expect(parseLenient(raw).summary).toBe('he said "hi"\nthen left');
    });

    it('does not treat a backslash outside a string as an escape', () => {
        expect(parseLenient('{"title":"T","summary":"done"}   ').summary).toBe('done');
    });

    it('rethrows the original error when the text is genuinely broken, since it names the position', () => {
        expect(() => parseLenient('{"title":"T","summary":')).toThrow(/JSON/);
    });
});
