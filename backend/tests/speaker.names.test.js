const mockQuery = jest.fn();
jest.mock('../src/infra/postgres', () => ({ query: (...args) => mockQuery(...args) }));

const { namesFor, setName, displayFor, MAX_NAME } = require('../src/transcript/speaker.names');

beforeEach(() => jest.clearAllMocks());

describe('namesFor', () => {
    it('returns the meeting\'s namings as a map', async () => {
        mockQuery.mockResolvedValue({ rows: [{ speaker_label: 'S0', display_name: 'Priya' }] });
        expect([...await namesFor('m1')]).toEqual([['S0', 'Priya']]);
    });

    it('is empty rather than null when nobody has been named', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        expect((await namesFor('m1')).size).toBe(0);
    });
});

describe('setName', () => {
    it('stores a trimmed name and reports it back', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        expect(await setName('m1', 'S0', '  Priya  ')).toBe('Priya');
        expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO speaker_names/);
        expect(mockQuery.mock.calls[0][1]).toEqual(['m1', 'S0', 'Priya']);
    });

    it('deletes rather than storing an empty name, so a cleared name reverts to the label', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        expect(await setName('m1', 'S0', '   ')).toBeNull();
        expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM speaker_names/);
    });

    it('caps a name rather than letting it run through a transcript line', async () => {
        mockQuery.mockResolvedValue({ rows: [] });
        const stored = await setName('m1', 'S0', 'x'.repeat(MAX_NAME + 40));
        expect(stored).toHaveLength(MAX_NAME);
    });
});

describe('displayFor', () => {
    const names = new Map([['S0', 'Priya']]);

    it('prefers the name', () => expect(displayFor(names, 'S0')).toBe('Priya'));
    it('falls back to the label', () => expect(displayFor(names, 'S4')).toBe('S4'));
    it('passes a missing label straight through', () => expect(displayFor(names, null)).toBeNull());
});
