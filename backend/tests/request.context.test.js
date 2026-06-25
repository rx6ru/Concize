// tests/requestContext.test.js
// Correlation-id context (AsyncLocalStorage) + the requestId middleware.

const { runWithContext, getRequestId } = require('../src/core/request.context');
const requestId = require('../src/http/middleware/request.id');

describe('context (AsyncLocalStorage)', () => {
    it('exposes the requestId inside a context scope, undefined outside', () => {
        expect(getRequestId()).toBeUndefined();
        runWithContext({ requestId: 'abc' }, () => {
            expect(getRequestId()).toBe('abc');
        });
        expect(getRequestId()).toBeUndefined();
    });

    it('propagates through async awaits', async () => {
        await runWithContext({ requestId: 'xyz' }, async () => {
            await Promise.resolve();
            expect(getRequestId()).toBe('xyz');
        });
    });
});

describe('requestId middleware', () => {
    function mockRes() {
        const headers = {};
        return { setHeader: (k, v) => { headers[k] = v; }, headers };
    }

    it('generates an id, echoes it on the response, and runs next inside the context', (done) => {
        const req = { headers: {} };
        const res = mockRes();
        requestId(req, res, () => {
            expect(getRequestId()).toBe(req.requestId);
            expect(res.headers['x-request-id']).toBe(req.requestId);
            expect(typeof req.requestId).toBe('string');
            done();
        });
    });

    it('honors an inbound x-request-id', (done) => {
        const req = { headers: { 'x-request-id': 'inbound-123' } };
        const res = mockRes();
        requestId(req, res, () => {
            expect(req.requestId).toBe('inbound-123');
            expect(getRequestId()).toBe('inbound-123');
            expect(res.headers['x-request-id']).toBe('inbound-123');
            done();
        });
    });
});
