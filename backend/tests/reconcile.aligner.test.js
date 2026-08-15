const { align, buildSpeakerMap, overlapMs } = require('../src/transcript/reconcile.aligner');

const live = (turnId, t0, t1, text, speakerLabel = null, over = {}) =>
    ({ turnId, t0Ms: t0, t1Ms: t1, text, speakerLabel, overlap: false, ...over });
const bat = (t0, t1, text, speakerId) => ({ t0Ms: t0, t1Ms: t1, text, speakerId });

describe('overlap', () => {
    it('measures shared milliseconds', () => {
        expect(overlapMs({ t0Ms: 0, t1Ms: 100 }, { t0Ms: 50, t1Ms: 150 })).toBe(50);
    });
    it('is zero for disjoint spans', () => {
        expect(overlapMs({ t0Ms: 0, t1Ms: 100 }, { t0Ms: 100, t1Ms: 200 })).toBe(0);
    });
});

describe('speaker mapping', () => {
    it('keeps the label the live pass already showed the user', () => {
        const map = buildSpeakerMap(
            [live('t1', 0, 5000, 'a', 'S3')],
            [bat(0, 5000, 'a', '0')]
        );
        expect(map.get('0')).toBe('S3');
    });

    it('does not give one live label to two batch speakers', () => {
        const map = buildSpeakerMap(
            [live('t1', 0, 10000, 'a', 'S1')],
            [bat(0, 6000, 'a', '0'), bat(6000, 10000, 'b', '1')]
        );
        expect(map.get('0')).toBe('S1');          // more shared time wins
        expect(map.get('1')).not.toBe('S1');
    });

    it('invents a fresh label for a speaker the live pass never attributed', () => {
        const map = buildSpeakerMap(
            [live('t1', 0, 5000, 'a', null)],
            [bat(0, 5000, 'a', '0')]
        );
        expect(map.get('0')).toMatch(/^S\d+$/);
    });

    it('never reuses a label already taken by another speaker', () => {
        const map = buildSpeakerMap(
            [live('t1', 0, 5000, 'a', 'S1')],
            [bat(0, 5000, 'a', '0'), bat(20000, 25000, 'b', '9')]
        );
        expect(map.get('9')).not.toBe('S1');
        expect(new Set([...map.values()]).size).toBe(2);
    });
});

describe('alignment', () => {
    it('corrects the wording from batch', () => {
        const { revisions } = align(
            [live('t1', 0, 5000, 'teh cat sat', 'S1')],
            [bat(0, 5000, 'the cat sat', '0')]
        );
        expect(revisions).toHaveLength(1);
        expect(revisions[0]).toMatchObject({ turnId: 't1', text: 'the cat sat', source: 'batch' });
    });

    it('attributes a turn the live pass left unattributed', () => {
        const { revisions } = align(
            [live('t1', 0, 5000, 'hello', null)],
            [bat(0, 5000, 'hello', '0')]
        );
        expect(revisions[0].speakerLabel).toMatch(/^S\d+$/);
        expect(revisions[0].speakerConfidence).toBe('confident');
    });

    it('emits nothing when batch agrees with live', () => {
        const { revisions } = align(
            [live('t1', 0, 5000, 'hello', 'S1')],
            [bat(0, 5000, 'hello', '0')]
        );
        expect(revisions).toEqual([]);
    });

    it('joins several batch entries covering one live turn', () => {
        const { revisions } = align(
            [live('t1', 0, 10000, 'garbled', 'S1')],
            [bat(0, 5000, 'first half', '0'), bat(5000, 10000, 'second half', '0')]
        );
        expect(revisions[0].text).toBe('first half second half');
    });

    it('marks a turn contested when batch finds two speakers inside it', () => {
        const { revisions } = align(
            [live('t1', 0, 10000, 'merged turn', 'S1')],
            [bat(0, 6000, 'one said this', '0'), bat(6000, 10000, 'other replied', '1')]
        );
        expect(revisions[0]).toMatchObject({ speakerConfidence: 'provisional', overlap: true });
    });

    it('picks the speaker with the most time in a contested turn', () => {
        const { revisions, speakerMap } = align(
            [live('t1', 0, 10000, 'x', null)],
            [bat(0, 8000, 'mostly this one', '0'), bat(8000, 10000, 'brief', '1')]
        );
        expect(revisions[0].speakerLabel).toBe(speakerMap.get('0'));
    });

    it('reports a live turn batch heard nothing for, without deleting it', () => {
        const { revisions, unmatched } = align(
            [live('t1', 0, 5000, 'phantom noise', 'S1')],
            [bat(60000, 65000, 'much later', '0')]
        );
        expect(revisions).toEqual([]);
        expect(unmatched.map((u) => u.turnId)).toEqual(['t1']);
    });

    it('treats a barely-overlapping match as unmatched', () => {
        const { unmatched } = align(
            [live('t1', 0, 10000, 'x', 'S1')],
            [bat(9500, 12000, 'tail end', '0')],           // 5% of the turn
            { minOverlapRatio: 0.3 }
        );
        expect(unmatched).toHaveLength(1);
    });

    it('preserves turn ids so revisions target the right rows', () => {
        const { revisions } = align(
            [live('turn-abc', 0, 5000, 'wrong', 'S1')],
            [bat(0, 5000, 'right', '0')]
        );
        expect(revisions[0].turnId).toBe('turn-abc');
    });

    it('keeps an existing overlap flag even when batch sees one speaker', () => {
        const { revisions } = align(
            [live('t1', 0, 5000, 'old', 'S1', { overlap: true })],
            [bat(0, 5000, 'new', '0')]
        );
        expect(revisions[0].overlap).toBe(true);
    });

    it('handles an empty batch result by leaving everything unmatched', () => {
        const { revisions, unmatched } = align([live('t1', 0, 5000, 'a', 'S1')], []);
        expect(revisions).toEqual([]);
        expect(unmatched).toHaveLength(1);
    });

    it('handles an empty live transcript', () => {
        expect(align([], [bat(0, 5000, 'a', '0')]).revisions).toEqual([]);
    });

    it('collapses whitespace when joining fragments', () => {
        const { revisions } = align(
            [live('t1', 0, 10000, 'x', 'S1')],
            [bat(0, 5000, 'first  ', '0'), bat(5000, 10000, '   second', '0')]
        );
        expect(revisions[0].text).toBe('first second');
    });
});

// Measured word-weighted against AMI ground truth on three meetings: batch diarization scores
// 55.0% speaker error, the live lane 34.4%. Letting batch overwrite attribution was reliably
// trading a better label for a worse one.
describe('who owns speaker attribution', () => {
    it('keeps the live label when the live lane made a call', () => {
        const [r] = align(
            [live('t1', 0, 5000, 'rough words', 'S1')],
            [bat(0, 5000, 'the corrected words', '7')],
        ).revisions;

        expect(r.text).toBe('the corrected words');   // batch still wins the wording
        expect(r.speakerLabel).toBe('S1');            // but not the speaker
    });

    it('fills in attribution the live lane never made', () => {
        const [r] = align(
            [live('t1', 0, 5000, 'rough words', null)],
            [bat(0, 5000, 'the corrected words', '7')],
        ).revisions;

        expect(r.speakerLabel).toBeTruthy();
    });

    it('does not raise a revision when only the batch speaker disagrees', () => {
        // Same wording, live already attributed: there is nothing left worth rewriting.
        const { revisions } = align(
            [live('t1', 0, 5000, 'same words', 'S1')],
            [bat(0, 5000, 'same words', '7')],
        );

        expect(revisions).toHaveLength(0);
    });
});
