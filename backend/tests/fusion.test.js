const { createFusion, speakerAt, overlapRatio, CONFIDENCE } = require('../src/realtime/fusion');

const words = (t0, t1, text = 'x', turnId = `t${t0}`) => ({ turnId, t0Ms: t0, t1Ms: t1, text });
const spk = (t0, t1, label, confidence) => ({ t0Ms: t0, t1Ms: t1, speakerLabel: label, confidence });
const ov = (t0, t1) => ({ t0Ms: t0, t1Ms: t1 });

describe('speaker assignment', () => {
    it('assigns the speaker whose interval covers the midpoint', () => {
        const intervals = [spk(0, 1000, 'S1'), spk(1000, 2000, 'S2')];
        expect(speakerAt(intervals, 1200, 1800).speakerLabel).toBe('S2');
    });

    it('prefers the tightest interval when several cover the midpoint', () => {
        const intervals = [spk(0, 10000, 'S1'), spk(900, 1100, 'S2')];
        expect(speakerAt(intervals, 950, 1050).speakerLabel).toBe('S2');
    });

    it('returns null when nothing covers the midpoint', () => {
        expect(speakerAt([spk(0, 500, 'S1')], 1000, 2000)).toBeNull();
    });

    it('treats an interval as half-open so adjacent turns do not both match', () => {
        const intervals = [spk(0, 1000, 'S1'), spk(1000, 2000, 'S2')];
        expect(speakerAt(intervals, 500, 1500).speakerLabel).toBe('S2'); // midpoint 1000
    });
});

describe('overlap ratio', () => {
    it('is zero with no overlap intervals', () => {
        expect(overlapRatio([], 0, 1000)).toBe(0);
    });

    it('measures the covered fraction of the span', () => {
        expect(overlapRatio([ov(0, 500)], 0, 1000)).toBe(0.5);
    });

    it('clips intervals to the span', () => {
        expect(overlapRatio([ov(-5000, 500)], 0, 1000)).toBe(0.5);
        expect(overlapRatio([ov(500, 99999)], 0, 1000)).toBe(0.5);
    });

    it('unions overlapping intervals instead of double counting', () => {
        // naive summing would give 0.8; the union is 0.5
        expect(overlapRatio([ov(0, 400), ov(200, 500)], 0, 1000)).toBe(0.5);
    });

    it('never exceeds 1', () => {
        expect(overlapRatio([ov(0, 1000), ov(0, 1000)], 0, 1000)).toBe(1);
    });

    it('ignores intervals outside the span', () => {
        expect(overlapRatio([ov(5000, 6000)], 0, 1000)).toBe(0);
    });

    it('returns zero for a zero-length span rather than dividing by zero', () => {
        expect(overlapRatio([ov(0, 100)], 500, 500)).toBe(0);
    });
});

describe('fuse', () => {
    it('emits text with speaker null when the speaker lane has said nothing', () => {
        const f = createFusion();
        const u = f.fuse(words(0, 1000, 'hello'));
        expect(u).toMatchObject({
            text: 'hello', speakerLabel: null, speakerConfidence: CONFIDENCE.UNKNOWN, overlap: false,
        });
    });

    it('attaches a speaker when one is known', () => {
        const f = createFusion();
        f.addSpeakerInterval(spk(0, 2000, 'S1'));
        expect(f.fuse(words(0, 1000))).toMatchObject({
            speakerLabel: 'S1', speakerConfidence: CONFIDENCE.CONFIDENT,
        });
    });

    it('downgrades confidence to provisional inside an overlapped span', () => {
        const f = createFusion();
        f.addSpeakerInterval(spk(0, 2000, 'S1'));
        f.addOverlapInterval(ov(0, 900));
        const u = f.fuse(words(0, 1000));
        expect(u.overlap).toBe(true);
        expect(u.speakerConfidence).toBe(CONFIDENCE.PROVISIONAL);
    });

    it('does not flag overlap below the threshold', () => {
        const f = createFusion({ overlapThreshold: 0.15 });
        f.addSpeakerInterval(spk(0, 2000, 'S1'));
        f.addOverlapInterval(ov(0, 100));           // 10% of the span
        const u = f.fuse(words(0, 1000));
        expect(u.overlap).toBe(false);
        expect(u.speakerConfidence).toBe(CONFIDENCE.CONFIDENT);
    });

    it('keeps a provisional speaker provisional even without overlap', () => {
        const f = createFusion();
        f.addSpeakerInterval(spk(0, 2000, 'S1', CONFIDENCE.PROVISIONAL));
        expect(f.fuse(words(0, 1000)).speakerConfidence).toBe(CONFIDENCE.PROVISIONAL);
    });

    it('rounds the overlap ratio to three places', () => {
        const f = createFusion();
        f.addOverlapInterval(ov(0, 333));
        expect(f.fuse(words(0, 1000)).overlapRatio).toBe(0.333);
    });
});

describe('late lane data', () => {
    it('revises an utterance once its speaker arrives', () => {
        const f = createFusion();
        const first = f.fuse(words(0, 1000, 'hello', 'turn-1'));
        expect(first.speakerLabel).toBeNull();

        f.addSpeakerInterval(spk(0, 2000, 'S2'));
        const changed = f.revise();

        expect(changed).toHaveLength(1);
        expect(changed[0]).toMatchObject({ turnId: 'turn-1', speakerLabel: 'S2' });
    });

    it('revises when late overlap data changes the flag', () => {
        const f = createFusion();
        f.addSpeakerInterval(spk(0, 2000, 'S1'));
        f.fuse(words(0, 1000, 'hi', 'turn-1'));

        f.addOverlapInterval(ov(0, 800));
        const changed = f.revise();

        expect(changed[0]).toMatchObject({ overlap: true, speakerConfidence: CONFIDENCE.PROVISIONAL });
    });

    it('returns nothing when late data changes no attribution', () => {
        const f = createFusion();
        f.addSpeakerInterval(spk(0, 2000, 'S1'));
        f.fuse(words(0, 1000, 'hi', 'turn-1'));

        f.addSpeakerInterval(spk(50000, 60000, 'S9'));   // unrelated span
        expect(f.revise()).toEqual([]);
    });

    it('does not re-report the same change twice', () => {
        const f = createFusion();
        f.fuse(words(0, 1000, 'hi', 'turn-1'));
        f.addSpeakerInterval(spk(0, 2000, 'S2'));

        expect(f.revise()).toHaveLength(1);
        expect(f.revise()).toHaveLength(0);
    });
});

describe('retention', () => {
    it('drops lane intervals older than the retention window', () => {
        const f = createFusion({ retentionMs: 1000 });
        f.addSpeakerInterval(spk(0, 100, 'S1'));
        f.addSpeakerInterval(spk(5000, 5100, 'S2'));     // prunes anything ending before 4100
        expect(f.stats().speakers).toBe(1);
    });

    it('keeps intervals inside the window', () => {
        const f = createFusion({ retentionMs: 60000 });
        f.addSpeakerInterval(spk(0, 100, 'S1'));
        f.addSpeakerInterval(spk(5000, 5100, 'S2'));
        expect(f.stats().speakers).toBe(2);
    });
});
