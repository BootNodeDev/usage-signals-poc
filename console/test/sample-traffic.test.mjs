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
  planHour,
  sampleWindowStart,
} from '../lib/sample-traffic.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TUESDAY_NOON = Date.parse('2026-11-24T12:00:00Z');
const PROFILE = { pageViewsPerDay: 140, pages: ['/demo/', '/demo/pricing', '/demo/docs'] };

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

  it('answers 400 for a range that is not two whole hours in the past, at most 30 days apart', async () => {
    process.env.CRON_SECRET = 'local-cron-secret';
    const call = async (query) => {
      const response = await handleSampleTraffic(
        new Request(`http://x/api/cron/sample-traffic?${query}`, {
          headers: { authorization: 'Bearer local-cron-secret' },
        }),
      );
      return [response.status, (await response.json()).error];
    };
    const message = 'Give from and to as whole UTC hours in the past, from before to, at most 30 days apart.';
    for (const query of [
      'from=2026-06-01T00:00:00Z',
      'to=2026-06-01T00:00:00Z',
      'from=2026-06-01T00:00:00Z&to=2026-07-02T00:00:00Z',
      'from=2026-06-01T00:30:00Z&to=2026-06-02T00:00:00Z',
      'from=2026-06-02T00:00:00Z&to=2026-06-01T00:00:00Z',
      'from=2026-06-01T00:00:00Z&to=2999-01-01T00:00:00Z',
      'from=junk&to=2026-06-02T00:00:00Z',
    ]) {
      assert.deepEqual(await call(query), [400, message], query);
    }
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
    assert.deepEqual(report, { filled: 0, pageViews: 0, failedHours: 0, remaining: 0 });
  });

  it('still reads single hours from Umami when the first sample hour is months back', async () => {
    const now = hour + HOUR + 60_000;
    const done = await hoursWithSample(site, sampleWindowStart(now, hour - 90 * DAY), now);
    assert.ok(done.has(hour), `hours read: ${[...done].map((h) => new Date(h).toISOString())}`);
  });
});
