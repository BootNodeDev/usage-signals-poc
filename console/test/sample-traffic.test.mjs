// Sample traffic for the demo sites: the plan is stable and shaped like the hand-loaded sample,
// the route refuses calls without the cron secret, and a run fills each missing hour once.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { requireEnv } from '../lib/config.js';
import {
  fillSampleTraffic,
  handleSampleTraffic,
  hoursWithSample,
  missingHours,
  pageViewsInHour,
  planApiHour,
  planHour,
  sampleWindowStart,
} from '../lib/sample-traffic.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TUESDAY_NOON = Date.parse('2026-11-24T12:00:00Z');
const PROFILE = { pageViewsPerDay: 140, pages: ['/demo/', '/demo/pricing', '/demo/docs'] };
const API_PROFILE = { requestsPerDay: 2400 };
const BOUNDS_MS = [5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

function planDay(dayStart) {
  return Array.from({ length: 24 }, (_, hour) => planHour('s', PROFILE, dayStart + hour * HOUR)).flat();
}

describe('sample traffic plan', () => {
  it('plans the same page views for the same site and hour, and different ones for another', () => {
    assert.deepEqual(planHour('s', PROFILE, TUESDAY_NOON), planHour('s', PROFILE, TUESDAY_NOON));
    assert.notDeepEqual(planHour('s', PROFILE, TUESDAY_NOON), planHour('t', PROFILE, TUESDAY_NOON));
  });

  it('keeps every page view inside its hour, on a page of the site, from a documentation address', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const start = TUESDAY_NOON - 12 * HOUR + hour * HOUR;
      for (const event of planHour('s', PROFILE, start)) {
        assert.ok(event.at >= start && event.at < start + HOUR, `event at ${event.at} outside hour ${start}`);
        assert.ok(PROFILE.pages.includes(event.url), event.url);
        assert.match(event.address, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
      }
    }
  });

  it('gives a weekday close to the daily figure and a weekend day less', () => {
    const weekday = planDay(Date.parse('2026-11-24T00:00:00Z')).length;
    const saturday = planDay(Date.parse('2026-11-28T00:00:00Z')).length;
    assert.ok(Math.abs(weekday - 140) <= 14, `weekday ${weekday}`);
    assert.ok(saturday < weekday, `saturday ${saturday}, weekday ${weekday}`);
    const expected = Array.from({ length: 24 }, (_, h) => pageViewsInHour(140, Date.parse('2026-11-24T00:00:00Z') + h * HOUR));
    assert.ok(Math.abs(expected.reduce((a, b) => a + b, 0) - 140) < 1e-9);
  });

  it('lists only complete hours that are missing, from the first sample hour', () => {
    const first = Date.parse('2026-11-20T00:00:00Z');
    const now = first + 3 * HOUR + 10 * 60_000;
    assert.deepEqual(missingHours(new Set(), now, first), [first, first + HOUR, first + 2 * HOUR]);
    assert.deepEqual(missingHours(new Set([first + HOUR]), now, first), [first, first + 2 * HOUR]);
  });

  it('looks back at most 30 days, from a whole hour, and never before the first sample hour', () => {
    const first = Date.parse('2026-11-20T00:00:00Z');
    const now = first + 45 * DAY + 10 * 60_000;
    const start = sampleWindowStart(now, first);
    assert.equal(start % HOUR, 0);
    assert.ok(now - start <= 30 * DAY, `window of ${(now - start) / DAY} days`);
    assert.ok(now - start > 30 * DAY - HOUR);
    assert.equal(sampleWindowStart(first + 2 * DAY, first), first);
  });
});

describe('sample API plan', () => {
  it('plans the same rows for the same site and hour', () => {
    assert.deepEqual(planApiHour('s', API_PROFILE, TUESDAY_NOON), planApiHour('s', API_PROFILE, TUESDAY_NOON));
    assert.notDeepEqual(planApiHour('s', API_PROFILE, TUESDAY_NOON), planApiHour('t', API_PROFILE, TUESDAY_NOON));
  });

  it('gives each row a histogram of 15 counts that adds up to its requests', () => {
    for (const row of planApiHour('s', API_PROFILE, TUESDAY_NOON)) {
      assert.equal(row.buckets.length, BOUNDS_MS.length + 1);
      assert.equal(row.buckets.reduce((a, b) => a + b, 0), row.count);
      assert.ok(row.count > 0 && row.sumMs > 0);
      assert.match(row.route, /^\/v1\//);
      assert.ok(row.status >= 100 && row.status <= 599);
    }
  });

  it('keeps a weekday within a fifth of the daily figure, and days differ', () => {
    const dayTotal = (dayStart) => {
      let total = 0;
      for (let hour = 0; hour < 24; hour += 1) {
        for (const row of planApiHour('s', API_PROFILE, dayStart + hour * HOUR)) total += row.count;
      }
      return total;
    };
    const tuesday = dayTotal(Date.parse('2026-11-24T00:00:00Z'));
    const wednesday = dayTotal(Date.parse('2026-11-25T00:00:00Z'));
    for (const total of [tuesday, wednesday]) {
      assert.ok(total >= 2400 * 0.75 && total <= 2400 * 1.25, `weekday ${total}`);
    }
    assert.notEqual(tuesday, wednesday);
  });
});

describe('sample traffic route', () => {
  const saved = process.env.CRON_SECRET;
  after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });

  it('answers 401 without the secret, with a wrong one, and when no secret is configured', async () => {
    const request = (authorization) =>
      new Request('http://x/api/cron/sample-traffic', { headers: authorization ? { authorization } : {} });
    delete process.env.CRON_SECRET;
    assert.equal((await handleSampleTraffic(request('Bearer '))).status, 401);
    process.env.CRON_SECRET = 'local-cron-secret';
    assert.equal((await handleSampleTraffic(request())).status, 401);
    assert.equal((await handleSampleTraffic(request('Bearer wrong'))).status, 401);
  });
});

describe('sample traffic run against the local stack', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  const site = TENANTS[0].site;
  // A fixed hour in the far past keeps the test apart from today's figures.
  const hour = Date.parse('2001-03-06T14:00:00Z');
  const sites = { [site.slug]: PROFILE };
  after(() => pool.end());

  async function storedPageViews() {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM public.website_event
        WHERE website_id = $1 AND created_at >= $2 AND created_at < $3 AND tag = 'sample'`,
      [site.umamiWebsiteId, new Date(hour), new Date(hour + HOUR)],
    );
    return rows[0].n;
  }

  async function clearHour() {
    await pool.query(
      `DELETE FROM public.website_event WHERE website_id = $1 AND created_at >= $2 AND created_at < $3`,
      [site.umamiWebsiteId, new Date(hour), new Date(hour + HOUR)],
    );
  }

  it('sends the planned page views of a missing hour once, tagged as sample', async () => {
    await clearHour();
    const planned = planHour(site.slug, PROFILE, hour).length;
    assert.ok(planned > 0);
    // Starting the run at the fixed hour makes it the only complete hour that is missing.
    const first = await fillSampleTraffic({ now: hour + HOUR + 60_000, sites, first: hour });
    assert.equal(first.filled, 1);
    assert.equal(first.pageViews, planned);
    assert.equal(await storedPageViews(), planned);
    const again = await fillSampleTraffic({ now: hour + HOUR + 60_000, sites, first: hour });
    assert.equal(again.filled, 0);
    assert.equal(await storedPageViews(), planned);
  });

  it('sends an hour once when two runs start at the same time', async () => {
    await clearHour();
    const planned = planHour(site.slug, PROFILE, hour).length;
    const run = () => fillSampleTraffic({ now: hour + HOUR + 60_000, sites, first: hour });
    const reports = await Promise.all([run(), run()]);
    assert.equal(reports.filter((report) => report === null).length, 1);
    assert.equal(await storedPageViews(), planned);
  });

  it('spends no run budget on hours whose plan has no page views', async () => {
    const quiet = { [site.slug]: { ...PROFILE, pageViewsPerDay: 0 } };
    const report = await fillSampleTraffic({ now: hour + HOUR + 60_000, sites: quiet, first: hour - 200 * HOUR });
    assert.deepEqual(report, {
      filled: 0,
      pageViews: 0,
      failedHours: 0,
      remaining: 0,
      api: { filled: 0, requests: 0, remaining: 0 },
    });
  });

  it('writes the planned API rows of a missing hour once, as service "sample"', async () => {
    const { rows: [tenant] } = await pool.query(
      `SELECT tenant_id AS id FROM usage_signals.site WHERE slug = $1`,
      [site.slug],
    );
    const stored = async () => {
      const { rows } = await pool.query(
        `SELECT coalesce(sum(request_count), 0)::int AS n FROM usage_signals.api_metric_minute
          WHERE tenant_id = $1 AND minute = $2 AND service = 'sample'`,
        [tenant.id, new Date(hour)],
      );
      return rows[0].n;
    };
    await pool.query(
      `DELETE FROM usage_signals.api_metric_minute WHERE tenant_id = $1 AND minute = $2`,
      [tenant.id, new Date(hour)],
    );
    const planned = planApiHour(site.slug, API_PROFILE, hour).reduce((sum, row) => sum + row.count, 0);
    assert.ok(planned > 0);
    const run = () =>
      fillSampleTraffic({ now: hour + HOUR + 60_000, sites: {}, apiSites: { [site.slug]: API_PROFILE }, first: hour });
    assert.deepEqual((await run()).api, { filled: 1, requests: planned, remaining: 0 });
    assert.deepEqual((await run()).api, { filled: 0, requests: 0, remaining: 0 });
    assert.equal(await stored(), planned);
  });

  it('fills the API rows when the page views fail, and the page views when the API rows fail', async () => {
    const broken = { get pageViewsPerDay() { throw new Error('page views broke'); }, pages: PROFILE.pages };
    const brokenApi = { get requestsPerDay() { throw new Error('API rows broke'); } };
    const now = hour + HOUR + 60_000;
    await clearHour();
    const webFails = await fillSampleTraffic({
      now, sites: { [site.slug]: broken }, apiSites: { [site.slug]: API_PROFILE }, first: hour,
    });
    assert.equal(webFails.error, 'page views broke');
    assert.ok(webFails.api.remaining === 0 && webFails.api.error === undefined);
    await pool.query(
      `DELETE FROM usage_signals.api_metric_minute WHERE minute = $1 AND service = 'sample'`,
      [new Date(hour)],
    );
    const apiFails = await fillSampleTraffic({
      now, sites, apiSites: { [site.slug]: brokenApi }, first: hour,
    });
    assert.equal(apiFails.api.error, 'API rows broke');
    assert.equal(apiFails.filled, 1);
  });

  it('still reads single hours from Umami when the first sample hour is months back', async () => {
    const now = hour + HOUR + 60_000;
    const done = await hoursWithSample(site, sampleWindowStart(now, hour - 90 * DAY), now);
    assert.ok(done.has(hour), `hours read: ${[...done].map((h) => new Date(h).toISOString())}`);
  });
});
