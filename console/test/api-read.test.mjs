// API figures: percentiles come from the shared histogram buckets, and the tenant endpoint sums
// the rows of api_metric_minute per route, per status class and per day.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { percentileMs } from '../lib/api-read.js';
import { apiBySite, operatorApi } from '../lib/operator-api.js';
import { requireEnv } from '../lib/config.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const GATEWAY = requireEnv('GATEWAY_URL');
const TENANT = TENANTS[1];
const SERVICE = 'api-read-test';
const EMPTY = new Array(15).fill(0);

function buckets(entries) {
  const counts = [...EMPTY];
  for (const [index, count] of entries) counts[index] = count;
  return counts;
}

describe('percentiles from histogram buckets', () => {
  it('interpolates inside the bucket that holds the rank', () => {
    // Ten requests in (25, 50] ms: the median is half way through that bucket.
    assert.equal(percentileMs(buckets([[3, 10]]), 0.5), 37.5);
    // 90 in (0, 5] and 10 in (100, 250]: p95 is half way through (100, 250].
    assert.equal(percentileMs(buckets([[0, 90], [6, 10]]), 0.95), 175);
  });

  it('starts the first bucket at zero and caps the last one at its lower bound', () => {
    assert.equal(percentileMs(buckets([[0, 4]]), 0.5), 2.5);
    assert.equal(percentileMs(buckets([[14, 3]]), 0.95), 10_000);
  });

  it('has no percentile without requests', () => {
    assert.equal(percentileMs(EMPTY, 0.5), null);
  });
});

describe('API figures in the operator view', () => {
  const SMALL = { small: true, below: 10 };
  const figure = (requests, errors, p95) => ({
    totals: { requests, statuses: { '2xx': requests - errors, '3xx': 0, '4xx': 0, '5xx': errors }, p50_ms: 1, p95_ms: p95 },
    routes: [
      { method: 'GET', route: '/a', requests: requests - 3 },
      { method: 'GET', route: '/b', requests: 3 },
    ],
  });

  it('gives requests, the server error share and p95, and hides small route counts', () => {
    assert.deepEqual(operatorApi(figure(40, 2, 120)), {
      requests: 40,
      error_rate: 0.05,
      p95_ms: 120,
      routes: [{ label: 'GET /a', value: 37 }, { label: 'GET /b', value: SMALL }],
    });
  });

  it('reads each tenant once, shows it on its first site, and gives null when a read fails', async () => {
    const sites = [
      { id: 's1', slug: 'one', tenantId: 't1' },
      { id: 's2', slug: 'two', tenantId: 't1' },
      { id: 's3', slug: 'three', tenantId: 't2' },
    ];
    const reads = [];
    const read = async (site) => {
      reads.push(site.id);
      if (site.tenantId === 't2') throw new Error('database down');
      return figure(40, 2, 120);
    };
    const shown = await apiBySite(sites, 7, read);
    assert.deepEqual(reads, ['s1', 's3']);
    assert.deepEqual(shown.get('s1'), operatorApi(figure(40, 2, 120)));
    assert.equal(shown.has('s2'), false);
    assert.equal(shown.get('s3'), null);
  });

  it('withholds the share and p95 under 10 requests, and has none without requests', () => {
    const few = operatorApi(figure(9, 1, 80));
    assert.deepEqual([few.requests, few.error_rate, few.p95_ms], [SMALL, SMALL, SMALL]);
    const none = operatorApi({ totals: { requests: 0, statuses: {}, p50_ms: null, p95_ms: null }, routes: [] });
    assert.deepEqual(none, { requests: 0, error_rate: null, p95_ms: null, routes: [] });
  });
});

describe('tenant API endpoint', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const today = new Date(hour).toISOString().slice(0, 10);
  const rows = [
    ['GET', '/test/accounts/{id}', 200, 18, buckets([[3, 18]])],
    ['GET', '/test/accounts/{id}', 404, 2, buckets([[0, 2]])],
    ['POST', '/test/transactions', 201, 5, buckets([[7, 5]])],
    ['POST', '/test/transactions', 504, 1, buckets([[14, 1]])],
  ];

  async function clear() {
    await pool.query(`DELETE FROM usage_signals.api_metric_minute WHERE service = $1`, [SERVICE]);
  }

  before(async () => {
    await clear();
    for (const [method, route, status, count, counts] of rows) {
      await pool.query(
        `INSERT INTO usage_signals.api_metric_minute
           (tenant_id, minute, service, route, method, status_code, request_count,
            duration_sum_ms, bucket_counts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [TENANT.id, new Date(hour), SERVICE, route, method, status, count, count * 10, counts],
      );
    }
  });
  after(async () => {
    await clear();
    await pool.end();
  });

  async function readApi(slug, days) {
    const response = await fetch(`${GATEWAY}/api/tenant/${slug}/api?days=${days}`);
    return { response, body: await response.json() };
  }

  it('sums requests, status classes and percentiles per route, busiest first', async () => {
    const { response, body } = await readApi(TENANT.site.slug, 7);
    assert.equal(response.status, 200);
    assert.equal(body.days, 7);
    assert.equal(body.project.slug, TENANT.site.slug);
    const ours = body.routes.filter((r) => r.route.startsWith('/test/'));
    assert.deepEqual(ours, [
      {
        method: 'GET',
        route: '/test/accounts/{id}',
        requests: 20,
        statuses: { '2xx': 18, '3xx': 0, '4xx': 2, '5xx': 0 },
        p50_ms: percentileMs(buckets([[0, 2], [3, 18]]), 0.5),
        p95_ms: percentileMs(buckets([[0, 2], [3, 18]]), 0.95),
      },
      {
        method: 'POST',
        route: '/test/transactions',
        requests: 6,
        statuses: { '2xx': 5, '3xx': 0, '4xx': 0, '5xx': 1 },
        p50_ms: percentileMs(buckets([[7, 5], [14, 1]]), 0.5),
        p95_ms: 10_000,
      },
    ]);
    assert.ok(body.totals.requests >= 26);
    assert.equal(body.daily.length, 7);
    assert.equal(body.daily.at(-1).day, today);
    assert.ok(body.daily.at(-1).requests >= 26);
  });

  it('adds API figures to each project of the operator list', async () => {
    const response = await fetch(`${GATEWAY}/api/operator/projects?days=7`);
    assert.equal(response.status, 200);
    const row = (await response.json()).projects.find((r) => r.project.slug === TENANT.site.slug);
    const exact = (await readApi(TENANT.site.slug, 7)).body;
    assert.deepEqual(row.api.requests, exact.totals.requests);
    assert.ok(row.api.routes.some((r) => r.label === 'GET /test/accounts/{id}' && r.value === 20));
  });

  it('answers 400 for an unsupported range and 404 for an unknown project', async () => {
    assert.equal((await readApi(TENANT.site.slug, 5)).response.status, 400);
    assert.equal((await readApi('no-such-project', 7)).response.status, 404);
  });
});
