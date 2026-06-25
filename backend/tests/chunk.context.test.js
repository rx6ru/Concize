const {
    buildContextPrefix, withContext, formatClock, formatSpeakers,
} = require('../src/transcript/chunk.context');

describe('clock formatting', () => {
    it('uses m:ss under an hour', () => {
        expect(formatClock(0)).toBe('0:00');
        expect(formatClock(65000)).toBe('1:05');
        expect(formatClock(750000)).toBe('12:30');
    });

    it('uses h:mm:ss past an hour — long meetings are the point', () => {
        expect(formatClock(3600000)).toBe('1:00:00');
        expect(formatClock(11045000)).toBe('3:04:05');
    });

    it('clamps negative input rather than printing a negative clock', () => {
        expect(formatClock(-5000)).toBe('0:00');
    });
});

describe('speaker list', () => {
    it('lists a small group in full', () => {
        expect(formatSpeakers(['S1', 'S2'])).toBe('S1, S2');
    });

    it('truncates a large group so the prefix stays short', () => {
        expect(formatSpeakers(['S1', 'S2', 'S3', 'S4', 'S5', 'S6'])).toBe('S1, S2, S3, S4 +2 more');
    });

    it('returns null when nobody is attributed', () => {
        expect(formatSpeakers([])).toBeNull();
        expect(formatSpeakers([null, undefined])).toBeNull();
    });
});

describe('context prefix', () => {
    const chunk = { t0Ms: 750000, t1Ms: 845000, speakers: ['S1', 'S2'], hasOverlap: false };

    it('includes title, time span, topic and speakers', () => {
        const prefix = buildContextPrefix(chunk, { title: 'Q3 planning', topic: 'pricing' });
        expect(prefix).toBe('[Q3 planning | 12:30–14:05 | Topic: pricing | Speakers: S1, S2]');
    });

    it('omits parts that are unknown rather than printing empty fields', () => {
        expect(buildContextPrefix(chunk)).toBe('[12:30–14:05 | Speakers: S1, S2]');
    });

    it('always carries the time span — it is the one thing always known', () => {
        expect(buildContextPrefix({ t0Ms: 0, t1Ms: 1000, speakers: [] })).toBe('[0:00–0:01]');
    });

    it('marks overlapping speech so an answer from contested audio can be hedged', () => {
        const prefix = buildContextPrefix({ ...chunk, hasOverlap: true });
        expect(prefix).toContain('overlapping speech');
    });

    it('omits speakers entirely when nothing is attributed', () => {
        const prefix = buildContextPrefix({ ...chunk, speakers: [] });
        expect(prefix).not.toContain('Speakers');
        expect(prefix).not.toContain('null');
    });
});

describe('withContext', () => {
    it('prepends the prefix to the chunk text', () => {
        const text = withContext(
            { t0Ms: 0, t1Ms: 5000, speakers: ['S1'], text: 'push it to next quarter' },
            { title: 'Standup' }
        );
        expect(text).toBe('[Standup | 0:00–0:05 | Speakers: S1]\npush it to next quarter');
    });

    it('reuses a stored prefix rather than rebuilding it', () => {
        const text = withContext({
            contextPrefix: '[precomputed]', text: 'body', t0Ms: 0, t1Ms: 1, speakers: [],
        });
        expect(text).toBe('[precomputed]\nbody');
    });
});
