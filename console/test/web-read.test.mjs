// The read side: events go in through the gateway, figures come back from the read endpoints.
// Figures are whole-day ranges, so every assertion compares the endpoint before and after,
// with visitors that are new on every run (a unique user agent each).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { requireEnv } from '../lib/config.js';
import { dailyRows, roundSmall, sumOfDaily } from '../lib/web-read.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const CONSOLE_ROOT = path.resolve(import.meta.dirname, '..');
const GATEWAY = requireEnv('GATEWAY_URL');
const UMAMI = requireEnv('UMAMI_URL');
const SITE = TENANTS[1].site;
const RUN = `${Date.now() % 100_000}.${Math.floor(Math.random() * 1_000)}`;
const CHROME = {
  address: '8.8.8.8',
  country: 'US',
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.${RUN} Safari/537.36`,
};
const FIREFOX = {
  address: '200.45.191.35',
  country: 'AR',
  userAgent: `Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.${RUN}`,
};
const spawned = [];

async function readWeb(base, slug, days) {
  const response = await fetch(`${base}/api/tenant/${slug}/web?days=${days}`);
  return { response, body: await response.json() };
}

async function figures(days = 7) {
  const { response, body } = await readWeb(GATEWAY, SITE.slug, days);
  assert.equal(response.status, 200);
  return body;
}

async function sendThroughGateway(visitor, url, referrer = '') {
  const response = await fetch(`${GATEWAY}/api/e`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://${SITE.domain}`,
      'user-agent': visitor.userAgent,
      'x-forwarded-for': visitor.address,
      'x-vercel-ip-country': visitor.country,
    },
    body: JSON.stringify({ type: 'event', payload: { website: SITE.umamiWebsiteId, url, referrer } }),
  });
  assert.equal(response.status, 202);
}

// The gateway refuses timestamps, so the event of the previous day is written the only way
// one can be: straight into Umami, which accepts a timestamp from anyone who reaches it.
async function sendYesterdayToUmami(visitor, url) {
  const response = await fetch(`${UMAMI}/api/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '8.8.8.0',
      'cf-ipcountry': visitor.country,
    },
    body: JSON.stringify({
      type: 'event',
      payload: {
        website: SITE.umamiWebsiteId,
        hostname: 'localhost',
        url,
        userAgent: visitor.userAgent,
        timestamp: Math.floor(Date.now() / 1000) - 86_400,
      },
    }),
  });
  assert.equal(response.status, 200);
}

function valueOf(rows, label) {
  return rows.find((row) => row.label === label)?.value ?? 0;
}

function day(offsetDays) {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe('sum of daily visitors', () => {
  it('adds the distinct visitors of each day', () => {
    assert.equal(sumOfDaily([{ visitors: 3 }, { visitors: 0 }, { visitors: 2 }]), 5);
    assert.equal(sumOfDaily([]), 0);
  });

  it('lays the series of Umami over every day of the range, oldest first', () => {
    const rows = dailyRows(
      ['2026-11-16', '2026-11-17', '2026-11-18'],
      { pageviews: [{ x: '2026-11-18T00:00:00Z', y: 7 }, { x: '2026-11-16T00:00:00Z', y: 1 }] },
      { sessions: [{ x: '2026-11-18T00:00:00Z', y: 2 }] },
    );
    assert.deepEqual(rows, [
      { day: '2026-11-16', pageviews: 1, visitors: 0 },
      { day: '2026-11-17', pageviews: 0, visitors: 0 },
      { day: '2026-11-18', pageviews: 7, visitors: 2 },
    ]);
  });
});

describe('GET /api/tenant/web', () => {
  let earlier;
  let later;

  before(async () => {
    earlier = await figures();
    await sendThroughGateway(CHROME, '/', 'https://stellar.org/learn');
    await sendThroughGateway(CHROME, '/pricing', '/');
    await sendThroughGateway(FIREFOX, '/');
    await sendYesterdayToUmami(CHROME, '/yesterday');
    later = await figures();
  });

  after(() => {
    for (const child of spawned) child.kill();
  });

  it('reports the totals of what was sent, with visitors as the sum of daily visitors', () => {
    const delta = (name) => later.totals[name] - earlier.totals[name];
    assert.equal(delta('pageviews'), 4);
    assert.equal(delta('visits'), 3);
    assert.equal(delta('bounces'), 2);
    // One person on two days is two daily visitors: Chrome today, Firefox today, Chrome yesterday.
    assert.equal(delta('visitors'), 3);
    assert.equal(later.totals.visitors, sumOfDaily(later.daily));
    assert.ok(later.totals.total_seconds >= earlier.totals.total_seconds);
  });

  it('reports one row per day of the range with the page views and visitors of that day', () => {
    assert.deepEqual(later.daily.map((row) => row.day), [6, 5, 4, 3, 2, 1, 0].map(day));
    const change = (offset, name) =>
      later.daily.at(-1 - offset)[name] - earlier.daily.at(-1 - offset)[name];
    assert.equal(change(0, 'pageviews'), 3);
    assert.equal(change(0, 'visitors'), 2);
    assert.equal(change(1, 'pageviews'), 1);
    assert.equal(change(1, 'visitors'), 1);
  });

  it('reports referrers, countries, devices and browsers', () => {
    // Umami rotates its session salt monthly, so across a month boundary the Chrome visitor
    // of yesterday is a different session and counts once more in each breakdown.
    const chromeSessions = day(0).slice(0, 7) === day(1).slice(0, 7) ? 1 : 2;
    const change = (dimension, label) =>
      valueOf(later.breakdowns[dimension], label) - valueOf(earlier.breakdowns[dimension], label);
    assert.equal(change('referrers', 'stellar.org'), 1);
    assert.equal(change('countries', 'US'), chromeSessions);
    assert.equal(change('countries', 'AR'), 1);
    assert.equal(change('browsers', 'chrome'), chromeSessions);
    assert.equal(change('browsers', 'firefox'), 1);
    assert.equal(change('devices', 'desktop'), chromeSessions + 1);
  });

  it('names the project and says through when the figures run', () => {
    assert.deepEqual(later.project, {
      slug: SITE.slug,
      name: TENANTS[1].name,
      domain: SITE.domain,
      state: 'active',
    });
    assert.equal(later.days, 7);
    assert.ok(Math.abs(Date.parse(later.through) - Date.now()) < 60_000);
  });

  it('covers 30 and 90 days as well', async () => {
    for (const days of [30, 90]) {
      const body = await figures(days);
      assert.equal(body.daily.length, days);
      assert.ok(body.totals.pageviews >= later.totals.pageviews);
    }
  });

  it('answers 404 for a slug that is not registered, reserved or not a slug', async () => {
    for (const slug of ['no-such-project', 'operator', 'Blend-Explorer', 'blend_explorer', SITE.id]) {
      const { response, body } = await readWeb(GATEWAY, slug, 7);
      assert.equal(response.status, 404, slug);
      assert.deepEqual(body, { error: 'Project not found.' });
    }
  });

  it('answers 400 for a range that is not 7, 30 or 90 days', async () => {
    for (const days of ['14', '', '7x']) {
      const { response } = await readWeb(GATEWAY, SITE.slug, days);
      assert.equal(response.status, 400, days);
    }
  });

  it('answers 405 to anything but GET', async () => {
    const response = await fetch(`${GATEWAY}/api/tenant/${SITE.slug}/web?days=7`, { method: 'POST' });
    assert.equal(response.status, 405);
  });

  it('returns the figures of the project in the address and of no other', async () => {
    const other = TENANTS[3].site;
    const read = async (site) => (await readWeb(GATEWAY, site.slug, 7)).body;
    const [mine, theirs] = [await read(SITE), await read(other)];
    const response = await fetch(`${GATEWAY}/api/e`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `https://${other.domain}`,
        'user-agent': FIREFOX.userAgent,
        'x-forwarded-for': FIREFOX.address,
        'x-vercel-ip-country': 'AR',
      },
      body: JSON.stringify({ type: 'event', payload: { website: other.umamiWebsiteId, url: '/theirs' } }),
    });
    assert.equal(response.status, 202);
    const [mineLater, theirsLater] = [await read(SITE), await read(other)];
    assert.equal(theirsLater.project.slug, other.slug);
    assert.equal(theirsLater.totals.pageviews, theirs.totals.pageviews + 1);
    assert.deepEqual(mineLater.totals, mine.totals);
    assert.deepEqual(mineLater.breakdowns, mine.breakdowns);
  });

  it('answers 503 without a credential or an address when Umami is unreachable', async () => {
    const child = spawn(process.execPath, ['dev.mjs'], {
      cwd: CONSOLE_ROOT,
      env: { ...process.env, GATEWAY_PORT: '4320', DEMO_PORT: '4321', UMAMI_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    spawned.push(child);
    for await (const chunk of child.stdout) if (String(chunk).includes('demo site:')) break;
    const response = await fetch(`http://localhost:4320/api/tenant/${SITE.slug}/web?days=7`);
    const text = await response.text();
    assert.equal(response.status, 503);
    for (const secret of ['127.0.0.1', 'http', requireEnv('UMAMI_ADMIN_PASSWORD'), 'admin']) {
      assert.ok(!text.includes(secret), `the body mentions "${secret}"`);
    }
  });
});

describe('GET /api/tenant/<slug>/project', () => {
  it('returns the project of the address with its website id and the pinned tracker', async () => {
    const manifest = await (await fetch(`${GATEWAY}/s/manifest.json`)).json();
    for (const tenant of TENANTS) {
      const response = await fetch(`${GATEWAY}/api/tenant/${tenant.site.slug}/project`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        project: {
          slug: tenant.site.slug,
          name: tenant.name,
          domain: tenant.site.domain,
          state: tenant.status,
          website_id: tenant.site.umamiWebsiteId,
        },
        tracker: { version: manifest.version, path: manifest.path, integrity: manifest.integrity },
      });
    }
  });

  it('answers 404 for an unknown slug and has no endpoint that lists projects to a tenant', async () => {
    assert.equal((await fetch(`${GATEWAY}/api/tenant/no-such-project/project`)).status, 404);
    for (const pathname of ['/api/tenant/sites', '/api/tenant', '/api/tenant/projects', '/api/sites']) {
      assert.equal((await fetch(`${GATEWAY}${pathname}`)).status, 404, pathname);
    }
  });
});

describe('small counts', () => {
  it('rounds counts under 100 to the nearest 10 and leaves the others', () => {
    const cases = [[0, 0], [4, 0], [5, 10], [14, 10], [95, 100], [99, 100], [100, 100], [1234, 1234]];
    for (const [count, rounded] of cases) assert.equal(roundSmall(count), rounded, String(count));
  });
});

describe('GET /api/operator/projects', () => {
  const [, siteB, , siteD] = TENANTS.map((tenant) => tenant.site);

  async function exact(site) {
    const response = await fetch(`${GATEWAY}/api/tenant/${site.slug}/web?days=7`);
    return response.json();
  }

  it('returns every site in one answer, with the exact figures after rounding', async () => {
    const origin = { [siteB.id]: `http://${siteB.domain}`, [siteD.id]: `https://${siteD.domain}` };
    for (const site of [siteB, siteD, siteD]) {
      const response = await fetch(`${GATEWAY}/api/e`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: origin[site.id],
          'user-agent': CHROME.userAgent,
          'x-forwarded-for': CHROME.address,
          'x-vercel-ip-country': 'US',
        },
        body: JSON.stringify({ type: 'event', payload: { website: site.umamiWebsiteId, url: '/list' } }),
      });
      assert.equal(response.status, 202);
    }
    const response = await fetch(`${GATEWAY}/api/operator/projects?days=7`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.rounding, { below: 100, step: 10 });
    assert.deepEqual(body.projects.map((row) => row.project.id).sort(), TENANTS.map((t) => t.site.id).sort());

    for (const site of [siteB, siteD]) {
      const row = body.projects.find((candidate) => candidate.project.id === site.id);
      assert.deepEqual(row.project, { id: site.id, name: TENANTS.find((t) => t.site === site).name, domain: site.domain, state: 'active' });
      const web = await exact(site);
      assert.ok(web.totals.pageviews > 0);
      assert.deepEqual(row.totals, {
        pageviews: roundSmall(web.totals.pageviews),
        visitors: roundSmall(web.totals.visitors),
        visits: roundSmall(web.totals.visits),
        bounces: roundSmall(web.totals.bounces),
        bounce_rate: web.totals.visits ? web.totals.bounces / web.totals.visits : 0,
        avg_visit_seconds: web.totals.visits ? web.totals.total_seconds / web.totals.visits : 0,
        flagged: null,
      });
      assert.deepEqual(row.daily, web.daily.map((d) => ({ day: d.day, pageviews: roundSmall(d.pageviews) })));
      for (const dimension of ['referrers', 'countries', 'devices', 'browsers']) {
        assert.deepEqual(
          row.breakdowns[dimension],
          web.breakdowns[dimension].map((entry) => ({ label: entry.label, value: roundSmall(entry.value) })),
        );
      }
    }
  });

  it('answers 400 for an unsupported range and 405 to anything but GET', async () => {
    assert.equal((await fetch(`${GATEWAY}/api/operator/projects?days=14`)).status, 400);
    assert.equal((await fetch(`${GATEWAY}/api/operator/projects?days=7`, { method: 'POST' })).status, 405);
  });
});
