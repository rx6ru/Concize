// tests/metrics.test.js
const { EventEmitter } = require('events');
const { register, httpMetricsMiddleware } = require('../src/core/metrics');

describe('metrics', () => {
    it('exposes default process metrics under the concize_ prefix', async () => {
        const out = await register.metrics();
        expect(out).toMatch(/concize_process_/);
    });

    it('records HTTP request duration on response finish, labeled by route pattern', async () => {
        const req = { method: 'GET', route: { path: '/ping' } };
        const res = new EventEmitter();
        res.statusCode = 200;

        let nexted = false;
        httpMetricsMiddleware(req, res, () => { nexted = true; });
        expect(nexted).toBe(true);

        res.emit('finish');

        const out = await register.metrics();
        expect(out).toMatch(/concize_http_request_duration_seconds_count\{[^}]*route="\/ping"[^}]*\}/);
    });
});
