const { createChunker, estimateTokens, cosineDistance } = require('../src/transcript/chunk.boundary');

let n = 0;
// the utt helper mints sequential ids, so the last one issued is the one just added
let lastIssued = null;
const lastTurnId = () => lastIssued;

const utt = (t0, t1, text, speaker = 'S1', over = {}) => ({
    turnId: (lastIssued = `t${n++}`), t0Ms: t0, t1Ms: t1, text, speakerLabel: speaker, overlap: false, ...over,
});

// ~13 tokens each, so 60 utterances comfortably exceeds an 800-token cap
const line = 'we should probably revisit the pricing model before the end of this quarter';

beforeEach(() => { n = 0; });

describe('token estimate', () => {
    it('counts words with a fudge factor', () => {
        expect(estimateTokens('one two three')).toBe(4);
    });
    it('handles empty and whitespace', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('   ')).toBe(0);
    });
});

describe('cosine distance', () => {
    it('is zero for identical vectors', () => {
        expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0);
    });
    it('is one for orthogonal vectors', () => {
        expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
    });
    it('is zero for mismatched or empty input rather than NaN', () => {
        expect(cosineDistance([1, 2], [1])).toBe(0);
        expect(cosineDistance([0, 0], [0, 0])).toBe(0);
        expect(cosineDistance(null, [1])).toBe(0);
    });
});

describe('hard caps', () => {
    it('closes on the duration ceiling', () => {
        const c = createChunker({ maxDurationMs: 5000 });
        expect(c.add(utt(0, 1000, 'a'))).toBeNull();
        const chunk = c.add(utt(1000, 6000, 'b'));
        expect(chunk).toMatchObject({ reason: 'hard', t0Ms: 0, t1Ms: 6000 });
    });

    it('closes on the token ceiling', () => {
        const c = createChunker({ maxTokens: 20, maxDurationMs: 999999 });
        c.add(utt(0, 1000, line));
        const chunk = c.add(utt(1000, 2000, line));
        expect(chunk.reason).toBe('hard');
    });

    it('numbers chunks sequentially', () => {
        const c = createChunker({ maxDurationMs: 1000, overlapRatio: 0 });
        const a = c.add(utt(0, 1500, 'a'));
        const b = c.add(utt(1500, 3000, 'b'));
        expect(a.ordinal).toBe(0);
        expect(b.ordinal).toBe(1);
    });
});

describe('soft boundaries', () => {
    it('closes on speaker change plus a silence gap', () => {
        const c = createChunker({ minDurationMs: 1000, silenceGapMs: 500 });
        c.add(utt(0, 5000, 'first speaker talking', 'S1'));
        const chunk = c.add(utt(6000, 8000, 'second speaker', 'S2'));   // 1000ms gap
        expect(chunk).toMatchObject({ reason: 'soft' });
        expect(chunk.t1Ms).toBe(5000);      // boundary falls BEFORE the new utterance
    });

    it('does not close on a speaker change without a gap', () => {
        const c = createChunker({ minDurationMs: 1000, silenceGapMs: 700 });
        c.add(utt(0, 5000, 'a', 'S1'));
        expect(c.add(utt(5100, 6000, 'b', 'S2'))).toBeNull();   // 100ms gap: interruption
    });

    it('does not close on a gap without a speaker change', () => {
        const c = createChunker({ minDurationMs: 1000, silenceGapMs: 500 });
        c.add(utt(0, 5000, 'a', 'S1'));
        expect(c.add(utt(9000, 10000, 'b', 'S1'))).toBeNull();  // same speaker pausing
    });

    it('ignores soft signals below the minimum duration', () => {
        const c = createChunker({ minDurationMs: 10000, silenceGapMs: 500 });
        c.add(utt(0, 1000, 'a', 'S1'));
        expect(c.add(utt(3000, 4000, 'b', 'S2'))).toBeNull();   // only 1s of content so far
    });

    it('requires a semantic shift when embeddings are supplied', () => {
        const c = createChunker({ minDurationMs: 1000, silenceGapMs: 500, semanticShiftThreshold: 0.5 });
        c.add(utt(0, 5000, 'a', 'S1'), [1, 0]);
        // same topic: distance 0, so no soft close despite turn + gap
        expect(c.add(utt(6000, 7000, 'b', 'S2'), [1, 0])).toBeNull();
    });

    it('closes when the topic actually shifts', () => {
        const c = createChunker({ minDurationMs: 1000, silenceGapMs: 500, semanticShiftThreshold: 0.5 });
        c.add(utt(0, 5000, 'a', 'S1'), [1, 0]);
        expect(c.add(utt(6000, 7000, 'b', 'S2'), [0, 1])).toMatchObject({ reason: 'soft' });
    });
});

describe('chunk contents', () => {
    it('joins text and collects distinct speakers', () => {
        const c = createChunker({ maxDurationMs: 3000, overlapRatio: 0 });
        c.add(utt(0, 1000, 'hello', 'S1'));
        c.add(utt(1000, 2000, 'hi there', 'S2'));
        const chunk = c.add(utt(2000, 4000, 'bye', 'S1'));

        expect(chunk.text).toBe('hello hi there bye');
        expect(chunk.speakers.sort()).toEqual(['S1', 'S2']);
        expect(chunk.turnIds).toHaveLength(3);
    });

    it('flags a chunk containing any overlapped utterance', () => {
        const c = createChunker({ maxDurationMs: 2000, overlapRatio: 0 });
        c.add(utt(0, 1000, 'a', 'S1'));
        const chunk = c.add(utt(1000, 3000, 'b', 'S2', { overlap: true }));
        expect(chunk.hasOverlap).toBe(true);
    });

    it('omits null speakers from the speaker list rather than including null', () => {
        const c = createChunker({ maxDurationMs: 2000, overlapRatio: 0 });
        c.add(utt(0, 1000, 'a', null));
        const chunk = c.add(utt(1000, 3000, 'b', 'S1'));
        expect(chunk.speakers).toEqual(['S1']);
    });
});

describe('overlap between chunks', () => {
    it('carries a tail of the closed chunk into the next', () => {
        const c = createChunker({ maxDurationMs: 4000, overlapRatio: 0.5 });
        c.add(utt(0, 1000, 'one'));
        c.add(utt(1000, 2000, 'two'));
        c.add(utt(2000, 3000, 'three'));
        const first = c.add(utt(3000, 5000, 'four'));

        expect(first.text).toBe('one two three four');
        expect(c.pending().utterances).toBe(2);       // half of four carried forward
    });

    it('carries nothing when the ratio is zero', () => {
        const c = createChunker({ maxDurationMs: 1000, overlapRatio: 0 });
        c.add(utt(0, 1500, 'a'));
        expect(c.pending().utterances).toBe(0);
    });
});

describe('flush', () => {
    it('closes whatever remains open', () => {
        const c = createChunker();
        c.add(utt(0, 1000, 'trailing words'));
        const chunk = c.flush();
        expect(chunk).toMatchObject({ reason: 'flush', text: 'trailing words' });
    });

    it('returns null when nothing is buffered', () => {
        expect(createChunker().flush()).toBeNull();
    });

    it('leaves the buffer empty after flush, carrying nothing forward', () => {
        const c = createChunker({ overlapRatio: 0.5 });
        c.add(utt(0, 1000, 'a'));
        c.add(utt(1000, 2000, 'b'));
        c.flush();
        expect(c.pending()).toEqual({ utterances: 0, tokens: 0, spanMs: 0 });
    });
});

describe('revising a buffered utterance', () => {
    it('applies a late speaker label to the open buffer', () => {
        const c = createChunker();
        c.add(utt(0, 1000, 'hello there', null));
        const turnId = c.pending().utterances === 1 ? null : null;

        expect(c.revise(lastTurnId(c), { speakerLabel: 'S3' })).toBe(true);
        expect(c.flush().speakers).toContain('S3');
    });

    it('reports when the turn is not in the buffer any more', () => {
        const c = createChunker();
        expect(c.revise('gone', { speakerLabel: 'S1' })).toBe(false);
    });

    it('keeps the utterance rather than dropping it', () => {
        const c = createChunker();
        c.add(utt(0, 1000, 'still here', null));
        c.revise(lastTurnId(c), { speakerLabel: 'S2' });

        expect(c.pending().utterances).toBe(1);
        expect(c.flush().text).toContain('still here');
    });

    it('recounts tokens when the text itself was corrected', () => {
        const c = createChunker();
        c.add(utt(0, 1000, 'one two three'));
        const before = c.pending().tokens;

        c.revise(lastTurnId(c), { text: 'one two three four five six seven eight nine ten' });
        expect(c.pending().tokens).toBeGreaterThan(before);
    });
});
