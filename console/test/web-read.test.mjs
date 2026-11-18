// The read side: events go in through the gateway, figures come back from /api/web.
// Figures are whole-day ranges, so every assertion compares the endpoint before and after,
// with visitors that are new on every run (a unique user agent each).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { requireEnv } from '../lib/config.js';
import { dailyRows, sumOfDaily } from '../lib/web-read.js';
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

async function readWeb(base, query) {
  const response = await fetch(`${base}/api/web?${query}`);
  return { response, body: await response.json() };
}

async function figures(days = 7) {
  const { response, body } = await readWeb(GATEWAY, `site=${SITE.id}&days=${days}`);
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

describe('GET /api/web', () => {
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

  it('names the site and says through when the figures run', () => {
    assert.deepEqual(later.site, {
      id: SITE.id,
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

  it('answers 404 for a site that is not registered', async () => {
    for (const site of [crypto.randomUUID(), 'not-a-uuid', SITE.umamiWebsiteId]) {
      const { response } = await readWeb(GATEWAY, `site=${site}&days=7`);
      assert.equal(response.status, 404, site);
    }
  });

  it('answers 400 for a range that is not 7, 30 or 90 days', async () => {
    for (const query of [`site=${SITE.id}&days=14`, `site=${SITE.id}`, `site=${SITE.id}&days=7x`]) {
      const { response } = await readWeb(GATEWAY, query);
      assert.equal(response.status, 400, query);
    }
  });

  it('answers 405 to anything but GET', async () => {
    const response = await fetch(`${GATEWAY}/api/web?site=${SITE.id}&days=7`, { method: 'POST' });
    assert.equal(response.status, 405);
  });

  it('answers 503 without a credential or an address when Umami is unreachable', async () => {
    const child = spawn(process.execPath, ['dev.mjs'], {
      cwd: CONSOLE_ROOT,
      env: { ...process.env, GATEWAY_PORT: '4320', DEMO_PORT: '4321', UMAMI_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    spawned.push(child);
    for await (const chunk of child.stdout) if (String(chunk).includes('demo site:')) break;
    const response = await fetch(`http://localhost:4320/api/web?site=${SITE.id}&days=7`);
    const text = await response.text();
    assert.equal(response.status, 503);
    for (const secret of ['127.0.0.1', 'http', requireEnv('UMAMI_ADMIN_PASSWORD'), 'admin']) {
      assert.ok(!text.includes(secret), `the body mentions "${secret}"`);
    }
  });
});

describe('GET /api/sites', () => {
  it('lists the seeded sites with the state of their project', async () => {
    const response = await fetch(`${GATEWAY}/api/sites`);
    assert.equal(response.status, 200);
    const { sites } = await response.json();
    for (const tenant of TENANTS) {
      assert.deepEqual(
        sites.find((site) => site.id === tenant.site.id),
        { id: tenant.site.id, name: tenant.name, domain: tenant.site.domain, state: tenant.status },
      );
    }
  });
});

describe('screens', () => {
  it('serves the five screens and their shared files', async () => {
    const files = ['tenant-web.html', 'tenant-api.html', 'enroll.html', 'operator.html',
      'operator-access.html', 'app.js', 'charts.js', 'data.js', 'styles.css'];
    for (const file of files) {
      assert.equal((await fetch(`${GATEWAY}/${file}`)).status, 200, file);
    }
  });

  it('keeps site ids and Umami out of the pages', async () => {
    for (const file of ['tenant-web.html', 'data.js', 'app.js']) {
      const text = await readFile(path.join(CONSOLE_ROOT, 'public', file), 'utf8');
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(text), `${file} hardcodes an id`);
      assert.ok(!/umami/i.test(text), `${file} mentions Umami`);
    }
  });
});
