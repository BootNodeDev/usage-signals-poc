// POST /v1/metrics: a project's OpenTelemetry exporter sends OTLP/HTTP JSON with its ingest
// token, and the points reach api_metric_minute once, however often they are delivered.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import {
  BOUNDS_S,
  CUMULATIVE,
  histogramMetric,
  histogramPoint,
  resourceMetrics,
} from '../../checks/check-05/lib.mjs';
import { requireEnv } from '../lib/config.js';
import { createIngestToken } from '../lib/ingest-tokens.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const GATEWAY = requireEnv('GATEWAY_URL');
const TENANT = TENANTS[1];
const SERVICE = `ingest-test-${Date.now()}`;
const NAME = 'http.server.request.duration';
const NOW = Date.now();

function body(options) {
  const { route = '/users/123', status = 200, durations = [0.02, 0.3], temporality } = options;
  const { timeMs = NOW } = options;
  const attrs = {
    'http.route': route,
    'http.request.method': 'GET',
    'http.response.status_code': status,
  };
  const point = histogramPoint({ attrs, durations, bounds: BOUNDS_S, timeMs });
  return histogramMetric(NAME, 's', [point], temporality);
}

function exportOf(...metrics) {
  return { resourceMetrics: [resourceMetrics({ 'service.name': SERVICE }, metrics)] };
}

describe('POST /v1/metrics', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  let token;
  before(async () => {
    token = (await createIngestToken({ project: TENANT.site.slug, days: 1 })).token;
  });
  after(() => pool.end());

  const send = (payload, headers = {}) =>
    fetch(`${GATEWAY}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });

  async function stored(route) {
    const { rows } = await pool.query(
      `SELECT coalesce(sum(request_count), 0)::int AS requests FROM usage_signals.api_metric_minute
        WHERE tenant_id = $1 AND service = $2 AND route = $3`,
      [TENANT.id, SERVICE, route],
    );
    return rows[0].requests;
  }

  it('stores a histogram once under its normalised route, however often it arrives', async () => {
    const payload = exportOf(body({ route: '/users/123' }));
    const first = await send(payload);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {});
    assert.equal(await stored('/users/{id}'), 2);
    assert.equal((await send(payload)).status, 200);
    assert.equal(await stored('/users/{id}'), 2, 'a redelivery is not counted again');
  });

  it('adds a later point of the same route to the same minute row', async () => {
    const route = `/orders/${Date.now()}`;
    await send(exportOf(body({ route, timeMs: NOW - 1000 })));
    await send(exportOf(body({ route, timeMs: NOW - 2000, durations: [0.1] })));
    assert.equal(await stored('/orders/{id}'), 3);
  });

  it('answers 200 with partialSuccess for refused points and counts them by reason', async () => {
    const before = await pool.query(
      `SELECT coalesce(sum(points), 0)::int AS n FROM usage_signals.api_refusal
        WHERE tenant_id = $1 AND reason = 'temporality is not delta'`,
      [TENANT.id],
    );
    const response = await send(exportOf(body({ route: '/cumulative', temporality: CUMULATIVE })));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      partialSuccess: { rejectedDataPoints: '1', errorMessage: 'temporality is not delta' },
    });
    const afterwards = await pool.query(
      `SELECT coalesce(sum(points), 0)::int AS n FROM usage_signals.api_refusal
        WHERE tenant_id = $1 AND reason = 'temporality is not delta'`,
      [TENANT.id],
    );
    assert.equal(afterwards.rows[0].n, before.rows[0].n + 1);
  });

  it('refuses a point that reuses a counted identity with other numbers', async () => {
    const route = `/collide/${Date.now()}`;
    await send(exportOf(body({ route, timeMs: NOW - 3000 })));
    const response = await send(exportOf(body({ route, timeMs: NOW - 3000, durations: [9] })));
    const answer = await response.json();
    const reason = 'same identity as a counted point, other numbers';
    assert.equal(answer.partialSuccess.errorMessage, reason);
    assert.equal(await stored('/collide/{id}'), 2);
  });

  it('answers 401 without a valid token, with a Bearer challenge', async () => {
    const missing = await send(exportOf(body({})), { authorization: '' });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="pulse"');
    const wrong = await send(exportOf(body({})), { authorization: `Bearer pit_${'A'.repeat(43)}` });
    assert.equal(wrong.status, 401);
    const invalid = 'Bearer realm="pulse", error="invalid_token"';
    assert.equal(wrong.headers.get('www-authenticate'), invalid);
  });

  it('answers 400, 405, 413 and 415 for what it can never take', async () => {
    assert.equal((await send('{not json')).status, 400);
    assert.equal((await send({ hello: 'world' })).status, 400);
    const protobuf = { 'content-type': 'application/x-protobuf' };
    assert.equal((await send(exportOf(body({})), protobuf)).status, 415);
    assert.equal((await send('x'.repeat(1_048_577))).status, 413);
    const get = await fetch(`${GATEWAY}/v1/metrics`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
  });

  it('stores two points whose routes become the same, once however often sent', async () => {
    const stamp = Date.now();
    const payload = exportOf(
      body({ route: `/merge${stamp}/1`, timeMs: NOW - 4000 }),
      body({ route: `/merge${stamp}/3`, timeMs: NOW - 4000 }),
    );
    assert.equal((await send(payload)).status, 200);
    assert.equal(await stored(`/merge${stamp}/{id}`), 4);
    assert.equal((await send(payload)).status, 200);
    assert.equal(await stored(`/merge${stamp}/{id}`), 4);
  });

  it('answers 415 to a compressed body, which is not supported yet', async () => {
    const response = await send(exportOf(body({})), { 'content-encoding': 'gzip' });
    assert.equal(response.status, 415);
  });
});
