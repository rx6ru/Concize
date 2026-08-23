
describe('a retrieval outage is not an internal error', () => {
    const { mapErrorToResponse } = require('../src/chat/chat.controller');

    it('keeps RETRIEVAL_UNAVAILABLE distinguishable instead of flattening it to a 500', () => {
        // retrieval.wiring throws this so an outage is never answered with a confident
        // "the transcript does not mention that". The client can only say so if the code survives.
        const err = new Error('retrieval unavailable');
        err.code = 'RETRIEVAL_UNAVAILABLE';
        const mapped = mapErrorToResponse(err);
        expect(mapped.code).toBe('RETRIEVAL_UNAVAILABLE');
        expect(mapped.status).toBe(503);
        expect(mapped.message).toMatch(/try again/i);
    });

    it('still falls back to a generic error for anything unrecognised', () => {
        const mapped = mapErrorToResponse(new Error('something odd'));
        expect(mapped.code).toBe('INTERNAL_SERVER_ERROR');
        expect(mapped.status).toBe(500);
    });
});
