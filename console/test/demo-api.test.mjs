// The demo API answers like a small Stellar API and sends its own request durations to
// /v1/metrics with the OpenTelemetry SDK, where they are stored for Demo site A.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { requireEnv } from '../lib/config.js';
import { DEMO_API_SERVICE, callDemoApi, handleDemoApi, resetDemoApi } from '../lib/demo-api.js';
import { createIngestToken } from '../lib/ingest-tokens.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const GATEWAY = requireEnv('GATEWAY_URL');
// An active project: a suspended one's ingest token is refused.
const TENANT = TENANTS[0];

const call = (path, init = {}) => handleDemoApi(new Request(`http://x${path}`, init));

describe('demo API', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  const saved = { url: process.env.CONSOLE_URL, token: process.env.DEMO_API_INGEST_TOKEN };
  before(async () => {
    process.env.CONSOLE_URL = GATEWAY;
    const created = await createIngestToken({ project: TENANT.site.slug, days: 1 });
    process.env.DEMO_API_INGEST_TOKEN = created.token;
    await resetDemoApi();
  });
  after(async () => {
    await resetDemoApi();
    const restore = [['CONSOLE_URL', saved.url], ['DEMO_API_INGEST_TOKEN', saved.token]];
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await pool.end();
  });

  async function stored(route, status) {
    const { rows } = await pool.query(
      `SELECT coalesce(sum(request_count), 0)::int AS n FROM usage_signals.api_metric_minute
        WHERE tenant_id = $1 AND service = $2 AND route = $3 AND status_code = $4`,
      [TENANT.id, DEMO_API_SERVICE, route, status],
    );
    return rows[0].n;
  }

  it('answers its routes, a missing account, a bad transaction and an unknown path', async () => {
    assert.equal((await call('/demo/api/accounts/7')).status, 200);
    assert.equal((await call('/demo/api/accounts/5000')).status, 404);
    assert.equal((await call('/demo/api/prices')).status, 200);
    const post = (body) =>
      call('/demo/api/transactions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    assert.equal((await post({ source: 'G', amount: '1' })).status, 201);
    assert.equal((await post({})).status, 400);
    assert.equal((await call('/demo/api/nothing')).status, 404);
    assert.equal((await call('/demo/api/prices', { method: 'DELETE' })).status, 405);
  });

  it('stores each request it answered under its route template, through /v1/metrics', async () => {
    const before = await stored('/demo/api/accounts/{id}', 200);
    await call('/demo/api/accounts/12');
    await call('/demo/api/accounts/13');
    assert.equal(await stored('/demo/api/accounts/{id}', 200), before + 2);
    const unknown = await stored('(unmatched)', 404);
    await call('/demo/api/nothing');
    assert.equal(await stored('(unmatched)', 404), unknown + 1);
  });

  it('is called by the scheduled run over HTTP', async () => {
    const statuses = await callDemoApi(GATEWAY, 12);
    const total = Object.values(statuses).reduce((sum, n) => sum + n, 0);
    assert.equal(total, 12);
    const expected = ['200', '201', '400', '404'];
    for (const status of Object.keys(statuses)) assert.ok(expected.includes(status), status);
  });

  it('answers within seconds and logs it when its metrics cannot be sent', async () => {
    const { createServer } = await import('node:http');
    const hanging = createServer(() => {}).listen(0);
    const failing = createServer((_, res) => res.writeHead(503).end()).listen(0);
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      for (const server of [hanging, failing]) {
        process.env.CONSOLE_URL = `http://127.0.0.1:${server.address().port}`;
        await resetDemoApi();
        const started = Date.now();
        const response = await call('/demo/api/prices');
        assert.equal(response.status, 200);
        assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
      }
    } finally {
      console.error = original;
      hanging.closeAllConnections();
      hanging.close();
      failing.close();
      process.env.CONSOLE_URL = GATEWAY;
      await resetDemoApi();
    }
    assert.equal(logged.filter((line) => line.includes('demo API: metrics not sent')).length, 2);
  });

  it('records an unknown HTTP method as _OTHER', async () => {
    const byMethod = async () => {
      const { rows } = await pool.query(
        `SELECT coalesce(sum(request_count) FILTER (WHERE method = '_OTHER'), 0)::int AS other,
                coalesce(sum(request_count) FILTER (WHERE method = 'FROBNICATE'), 0)::int AS raw
           FROM usage_signals.api_metric_minute WHERE tenant_id = $1 AND service = $2`,
        [TENANT.id, DEMO_API_SERVICE],
      );
      return rows[0];
    };
    const before = await byMethod();
    assert.equal((await call('/demo/api/prices', { method: 'FROBNICATE' })).status, 405);
    assert.deepEqual(await byMethod(), { other: before.other + 1, raw: before.raw });
  });

  it('gives each scheduled call 5 seconds and stops calling after the run budget', async () => {
    const { createServer } = await import('node:http');
    const hanging = createServer(() => {}).listen(0);
    try {
      const started = Date.now();
      const statuses = await callDemoApi(`http://127.0.0.1:${hanging.address().port}`, 3, 7000);
      assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
      const timeouts = statuses.timeout ?? 0;
      assert.ok(timeouts >= 1 && timeouts <= 2, JSON.stringify(statuses));
    } finally {
      hanging.closeAllConnections();
      hanging.close();
    }
  });

  it('fails the scheduled calls on answers the demo API never gives', async () => {
    const { createServer } = await import('node:http');
    for (const status of [401, 403, 503]) {
      const wrong = createServer((_, res) => res.writeHead(status).end()).listen(0);
      try {
        await assert.rejects(
          callDemoApi(`http://127.0.0.1:${wrong.address().port}`, 2),
          new RegExp(`not the demo API's: ${status}`),
        );
      } finally {
        wrong.close();
      }
    }
  });
});
