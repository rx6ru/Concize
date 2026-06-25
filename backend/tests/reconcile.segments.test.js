const {
    planSegments, stitchSegments, MAX_SEGMENT_MS, OVERLAP_MS,
} = require('../src/transcript/reconcile.segments');

const HOUR = 3600000;

describe('segment planning', () => {
    it('returns one segment for a short meeting', () => {
        expect(planSegments(30 * 60000)).toEqual([{ index: 0, t0Ms: 0, t1Ms: 1800000 }]);
    });

    it('returns nothing for a zero-length recording', () => {
        expect(planSegments(0)).toEqual([]);
    });

    it('keeps every segment under the API ceiling', () => {
        for (const duration of [3 * HOUR, 5 * HOUR, 8 * HOUR]) {
            for (const s of planSegments(duration)) {
                expect(s.t1Ms - s.t0Ms).toBeLessThanOrEqual(2 * HOUR);
            }
        }
    });

    it('overlaps consecutive segments so speakers can be linked across the cut', () => {
        const segs = planSegments(5 * HOUR);
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].t0Ms).toBeLessThan(segs[i - 1].t1Ms);
            expect(segs[i - 1].t1Ms - segs[i].t0Ms).toBe(OVERLAP_MS);
        }
    });

    it('covers the whole recording with no gaps', () => {
        const segs = planSegments(5 * HOUR);
        expect(segs[0].t0Ms).toBe(0);
        expect(segs[segs.length - 1].t1Ms).toBe(5 * HOUR);
        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].t0Ms).toBeLessThanOrEqual(segs[i - 1].t1Ms);
        }
    });

    it('splits a 5-hour meeting into a sane number of segments', () => {
        expect(planSegments(5 * HOUR).length).toBe(Math.ceil((5 * HOUR) / (MAX_SEGMENT_MS - OVERLAP_MS)));
    });

    it('does not emit a segment past the end', () => {
        const segs = planSegments(2 * HOUR);
        expect(segs.every((s) => s.t1Ms <= 2 * HOUR)).toBe(true);
    });
});

// entries use segment-relative times, as the API returns them
const entry = (t0, t1, text, speakerId) => ({ t0Ms: t0, t1Ms: t1, text, speakerId });
const seg = (index, t0, t1) => ({ index, t0Ms: t0, t1Ms: t1 });

describe('stitching', () => {
    it('shifts entries into absolute meeting time', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(0, 500, 'a', '0')] },
            { segment: seg(1, 1000, 2000), entries: [entry(0, 500, 'b', '0')] },
        ]);
        expect(entries.map((e) => [e.t0Ms, e.t1Ms])).toEqual([[0, 500], [1000, 1500]]);
    });

    it('namespaces speaker ids so two segments cannot collide silently', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(0, 500, 'a', '0')] },
            { segment: seg(1, 5000, 6000), entries: [entry(0, 500, 'b', '0')] },
        ]);
        // no overlap window, so nothing links: the ids must stay distinct
        expect(entries[0].speakerId).not.toBe(entries[1].speakerId);
    });

    it('links the same voice across a cut using the overlap window', () => {
        // segment 1 starts at 900; both segments cover 900–1000 with one speaker
        const { entries, speakerLinks } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(800, 1000, 'shared', '0')] },
            { segment: seg(1, 900, 2000), entries: [entry(0, 100, 'shared', '0'), entry(200, 400, 'later', '0')] },
        ]);
        expect(speakerLinks).toHaveLength(1);
        const ids = new Set(entries.map((e) => e.speakerId));
        expect(ids.size).toBe(1);
    });

    it('does not link two different voices that merely coexist in the window', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(900, 1000, 'x', '0'), entry(900, 1000, 'y', '1')] },
            { segment: seg(1, 900, 2000), entries: [entry(0, 100, 'x', '0'), entry(0, 100, 'y', '1')] },
        ]);
        // two distinct identities survive, not one merged blob
        expect(new Set(entries.map((e) => e.speakerId)).size).toBe(2);
    });

    it('leaves a speaker unlinked when they are silent through the overlap', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(0, 100, 'early', '0')] },
            { segment: seg(1, 900, 2000), entries: [entry(200, 400, 'late', '0')] },
        ]);
        expect(new Set(entries.map((e) => e.speakerId)).size).toBe(2);
    });

    it('drops an entry duplicated inside the overlap window', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(900, 1000, 'same words', '0')] },
            { segment: seg(1, 900, 2000), entries: [entry(0, 100, 'same words', '0')] },
        ]);
        expect(entries).toHaveLength(1);
    });

    it('returns entries in chronological order', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(500, 600, 'second', '0'), entry(0, 100, 'first', '0')] },
        ]);
        expect(entries.map((e) => e.text)).toEqual(['first', 'second']);
    });

    it('preserves a null speaker rather than inventing one', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(0, 100, 'unattributed', null)] },
        ]);
        expect(entries[0].speakerId).toBeNull();
    });

    it('handles a segment that returned nothing', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [] },
            { segment: seg(1, 900, 2000), entries: null },
        ]);
        expect(entries).toEqual([]);
    });

    it('propagates a link through three segments', () => {
        const { entries } = stitchSegments([
            { segment: seg(0, 0, 1000), entries: [entry(900, 1000, 'a', '0')] },
            { segment: seg(1, 900, 2000), entries: [entry(0, 100, 'a', '0'), entry(1000, 1100, 'b', '0')] },
            { segment: seg(2, 1900, 3000), entries: [entry(0, 100, 'b', '0'), entry(500, 600, 'c', '0')] },
        ]);
        expect(new Set(entries.map((e) => e.speakerId)).size).toBe(1);
    });
});
