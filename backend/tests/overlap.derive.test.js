jest.mock('../src/core/logger', () => ({
    createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { deriveOverlaps, mergeIntervals } = require('../src/transcript/overlap.derive');

const iv = (t0, t1, speaker) => ({ t0Ms: t0, t1Ms: t1, speaker });

describe('finding contested speech', () => {
    it('reports the intersection when two speakers talk at once', () => {
        const out = deriveOverlaps([iv(0, 3000, 'S1'), iv(2000, 5000, 'S2')]);

        expect(out).toEqual([expect.objectContaining({ t0Ms: 2000, t1Ms: 3000 })]);
        expect(out[0].speakers.sort()).toEqual(['S1', 'S2']);
    });

    it('finds nothing when speakers take turns cleanly', () => {
        expect(deriveOverlaps([iv(0, 2000, 'S1'), iv(2000, 4000, 'S2')])).toEqual([]);
    });

    // The same person's segments abutting or overlapping is not contested speech.
    it('ignores a speaker overlapping themselves', () => {
        expect(deriveOverlaps([iv(0, 3000, 'S1'), iv(2000, 5000, 'S1')])).toEqual([]);
    });

    it('handles three people at once as one contested span', () => {
        const out = deriveOverlaps([iv(0, 4000, 'S1'), iv(1000, 5000, 'S2'), iv(1500, 3000, 'S3')]);

        const covered = out.find((o) => o.t0Ms <= 1500 && o.t1Ms >= 3000);
        expect(covered).toBeDefined();
        expect(covered.speakers.length).toBeGreaterThanOrEqual(2);
    });

    it('is not confused by unordered input', () => {
        const out = deriveOverlaps([iv(2000, 5000, 'S2'), iv(0, 3000, 'S1')]);
        expect(out).toHaveLength(1);
        expect(out[0].t0Ms).toBe(2000);
    });

    it('ignores an interval with no speaker', () => {
        expect(deriveOverlaps([iv(0, 3000, null), iv(2000, 5000, 'S2')])).toEqual([]);
    });

    it('returns nothing for fewer than two intervals', () => {
        expect(deriveOverlaps([iv(0, 1000, 'S1')])).toEqual([]);
        expect(deriveOverlaps([])).toEqual([]);
    });

    // A brief boundary wobble between two segments is a timestamp artefact, not two people
    // talking over each other; counting it would flag most of the meeting.
    it('discards an overlap shorter than the floor', () => {
        expect(deriveOverlaps([iv(0, 3000, 'S1'), iv(2960, 5000, 'S2')])).toEqual([]);
    });
});

describe('merging', () => {
    it('joins touching spans so a chunk is not flagged twice for one event', () => {
        const merged = mergeIntervals([
            { t0Ms: 1000, t1Ms: 2000, speakers: ['S1', 'S2'] },
            { t0Ms: 1900, t1Ms: 3000, speakers: ['S2', 'S3'] },
        ]);

        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ t0Ms: 1000, t1Ms: 3000 });
        expect(merged[0].speakers.sort()).toEqual(['S1', 'S2', 'S3']);
    });

    it('leaves separate events separate', () => {
        const merged = mergeIntervals([
            { t0Ms: 0, t1Ms: 1000, speakers: ['S1', 'S2'] },
            { t0Ms: 9000, t1Ms: 10000, speakers: ['S1', 'S3'] },
        ]);
        expect(merged).toHaveLength(2);
    });
});
