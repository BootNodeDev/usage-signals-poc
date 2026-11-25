// The read side: events go in through the gateway, figures come back from the read endpoints.
// Figures are whole-day ranges, so every assertion compares the endpoint before and after,
// with visitors that are new on every run (a unique user agent and network each).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { truncateAddress } from '../lib/client-address.js';
import { requireEnv } from '../lib/config.js';
import { operatorRow, smallCount } from '../lib/operator-api.js';
import { dailyRows, flaggedByRule, sumOfDaily } from '../lib/web-read.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const CONSOLE_ROOT = path.resolve(import.meta.dirname, '..');
const GATEWAY = requireEnv('GATEWAY_URL');
const UMAMI = requireEnv('UMAMI_URL');
const SITE = TENANTS[1].site;
const RUN = `${Date.now() % 100_000}.${Math.floor(Math.random() * 1_000)}`;
const RUN_NETWORK = 1 + Math.floor(Math.random() * 254);
const FETCH_METADATA = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const CHROME = {
  address: `8.34.${RUN_NETWORK}.8`,
  country: 'US',
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.${RUN} Safari/537.36`,
};
const FIREFOX = {
  address: `200.46.${RUN_NETWORK}.35`,
  country: 'AR',
  userAgent: `Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.${RUN}`,
};
const SCRIPT = { address: `190.211.${RUN_NETWORK}.9`, country: 'UY', userAgent: `curl/8.${RUN}`, fetchMetadata: false };
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

function visitorHeaders(visitor) {
  return {
    'content-type': 'application/json',
    'user-agent': visitor.userAgent,
    'x-forwarded-for': visitor.address,
    'x-vercel-ip-country': visitor.country,
    ...(visitor.fetchMetadata !== false && FETCH_METADATA),
  };
}

async function sendThroughGateway(visitor, url, referrer = '') {
  const response = await fetch(`${GATEWAY}/api/e`, {
    method: 'POST',
    headers: { origin: `http://${SITE.domain}`, ...visitorHeaders(visitor) },
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
      'cf-connecting-ip': truncateAddress(visitor.address),
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
      {
        pageviews: [{ x: '2026-11-18T00:00:00Z', y: 7 }, { x: '2026-11-16T00:00:00Z', y: 1 }],
        sessions: [{ x: '2026-11-18T00:00:00Z', y: 2 }],
      },
      { pageviews: [{ x: '2026-11-17T00:00:00Z', y: 4 }], sessions: [{ x: '2026-11-17T00:00:00Z', y: 1 }] },
    );
    assert.deepEqual(rows, [
      { day: '2026-11-16', pageviews: 1, visitors: 0, flagged: 0 },
      { day: '2026-11-17', pageviews: 0, visitors: 0, flagged: 4 },
      { day: '2026-11-18', pageviews: 7, visitors: 2, flagged: 0 },
    ]);
  });

  it('counts flagged page views under every rule their tag names', () => {
    const byTag = [{ tag: 'bot', views: '3' }, { tag: 'bot+no-sec-fetch', views: '2' }, { tag: 'many-agents', views: '1' }];
    assert.deepEqual(flaggedByRule(byTag), { bot: 5, 'no-sec-fetch': 2, 'many-agents': 1 });
    assert.deepEqual(flaggedByRule([]), { bot: 0, 'no-sec-fetch': 0, 'many-agents': 0 });
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
    await sendThroughGateway(SCRIPT, '/');
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

  it('counts the flagged page view apart, under each rule it matched', () => {
    assert.equal(later.totals.flagged - earlier.totals.flagged, 1);
    assert.equal(later.daily.at(-1).flagged - earlier.daily.at(-1).flagged, 1);
    const change = (rule) => later.flagged_by_rule[rule] - earlier.flagged_by_rule[rule];
    assert.deepEqual(
      { bot: change('bot'), 'no-sec-fetch': change('no-sec-fetch'), 'many-agents': change('many-agents') },
      { bot: 1, 'no-sec-fetch': 1, 'many-agents': 0 },
    );
    assert.equal(valueOf(later.breakdowns.countries, 'UY'), valueOf(earlier.breakdowns.countries, 'UY'));
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
      headers: { origin: `https://${other.domain}`, ...visitorHeaders(FIREFOX) },
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

const SMALL = { small: true, below: 10 };

describe('small counts in the operator view', () => {
  it('keeps zero, hides 1 to 9 behind a marker and gives 10 and above exactly', () => {
    const cases = [[0, 0], [1, SMALL], [9, SMALL], [10, 10], [11, 11], [1234, 1234]];
    for (const [count, shown] of cases) assert.deepEqual(smallCount(count), shown, String(count));
  });

  const site = { id: 'site-id', name: 'Some project', domain: 'some.project.test', state: 'active' };
  const figures = (totals) => ({
    totals: { pageviews: 0, visitors: 0, visits: 0, bounces: 0, total_seconds: 0, flagged: 0, ...totals },
    flagged_by_rule: { bot: 12, 'no-sec-fetch': 3, 'many-agents': 0 },
    daily: [{ day: '2026-11-17', pageviews: 0, visitors: 0, flagged: 0 }, { day: '2026-11-18', pageviews: 1, visitors: 1, flagged: 15 },
      { day: '2026-11-19', pageviews: 12, visitors: 9, flagged: 4 }],
    breakdowns: { referrers: [], countries: [{ label: 'AR', value: 11 }, { label: 'UY', value: 2 }], devices: [], browsers: [] },
  });

  it('never returns a count of 1 to 9, in the totals, the daily series or a breakdown', () => {
    const row = operatorRow(site, figures({ pageviews: 13, visitors: 9, visits: 11, bounces: 1, total_seconds: 660, flagged: 19 }));
    assert.deepEqual(row.totals, {
      pageviews: 13, visitors: SMALL, visits: 11, bounces: SMALL,
      bounce_rate: 1 / 11, avg_visit_seconds: 60, flagged: 19,
    });
    assert.deepEqual(row.flagged_by_rule, { bot: 12, 'no-sec-fetch': SMALL, 'many-agents': 0 });
    assert.deepEqual(row.daily, [
      { day: '2026-11-17', pageviews: 0, flagged: 0 },
      { day: '2026-11-18', pageviews: SMALL, flagged: 15 },
      { day: '2026-11-19', pageviews: 12, flagged: SMALL },
    ]);
    assert.deepEqual(row.breakdowns.countries, [{ label: 'AR', value: 11 }, { label: 'UY', value: SMALL }]);
  });

  it('hides the rates that fewer than 10 visits would give away, and has none without visits', () => {
    const few = operatorRow(site, figures({ pageviews: 9, visitors: 9, visits: 9, bounces: 3, total_seconds: 90, flagged: 2 }));
    assert.deepEqual(few.totals, {
      pageviews: SMALL, visitors: SMALL, visits: SMALL, bounces: SMALL,
      bounce_rate: SMALL, avg_visit_seconds: SMALL, flagged: SMALL,
    });
    const none = operatorRow(site, figures({})).totals;
    assert.deepEqual([none.pageviews, none.visits, none.bounce_rate, none.avg_visit_seconds], [0, 0, null, null]);
    const ten = operatorRow(site, figures({ pageviews: 10, visitors: 10, visits: 10, bounces: 5, total_seconds: 100 })).totals;
    assert.deepEqual([ten.visits, ten.bounce_rate, ten.avg_visit_seconds], [10, 0.5, 10]);
  });
});

describe('GET /api/operator/projects', () => {
  const [, siteB, , siteD] = TENANTS.map((tenant) => tenant.site);
  const COUNT_KEYS = ['pageviews', 'visitors', 'visits', 'bounces', 'flagged'];

  async function exact(site) {
    const response = await fetch(`${GATEWAY}/api/tenant/${site.slug}/web?days=7`);
    return response.json();
  }

  function assertShown(shown, exactCount, where) {
    assert.deepEqual(shown, smallCount(exactCount), where);
    assert.ok(shown === 0 || shown >= 10 || (shown.small === true && shown.below === 10), `${where} shows ${JSON.stringify(shown)}`);
  }

  it('returns every site in one answer, exact from 10 up and marked as small below', async () => {
    const origin = { [siteB.id]: `http://${siteB.domain}`, [siteD.id]: `https://${siteD.domain}` };
    for (const site of [siteB, siteD, siteD]) {
      const response = await fetch(`${GATEWAY}/api/e`, {
        method: 'POST',
        headers: { origin: origin[site.id], ...visitorHeaders(CHROME) },
        body: JSON.stringify({ type: 'event', payload: { website: site.umamiWebsiteId, url: '/list' } }),
      });
      assert.equal(response.status, 202);
    }
    const response = await fetch(`${GATEWAY}/api/operator/projects?days=7`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.small_counts, { below: 10 });
    assert.deepEqual(body.projects.map((row) => row.project.id).sort(), TENANTS.map((t) => t.site.id).sort());

    let smallSeen = 0;
    for (const site of [siteB, siteD]) {
      const row = body.projects.find((candidate) => candidate.project.id === site.id);
      const web = await exact(site);
      assert.deepEqual(row.project, {
        id: site.id, slug: site.slug, name: TENANTS.find((t) => t.site === site).name, domain: site.domain, state: 'active',
      });
      for (const key of COUNT_KEYS) assertShown(row.totals[key], web.totals[key], `${site.slug} ${key}`);
      for (const [rule, count] of Object.entries(row.flagged_by_rule)) {
        assertShown(count, web.flagged_by_rule[rule], `${site.slug} flagged by ${rule}`);
      }
      assert.equal(row.daily.length, web.daily.length);
      row.daily.forEach((day, index) => {
        assertShown(day.pageviews, web.daily[index].pageviews, `${site.slug} ${day.day}`);
        assertShown(day.flagged, web.daily[index].flagged, `${site.slug} ${day.day} flagged`);
      });
      for (const dimension of ['referrers', 'countries', 'devices', 'browsers']) {
        row.breakdowns[dimension].forEach((entry, index) => {
          assert.equal(entry.label, web.breakdowns[dimension][index].label);
          assertShown(entry.value, web.breakdowns[dimension][index].value, `${site.slug} ${dimension} ${entry.label}`);
          if (entry.value.small) smallSeen += 1;
        });
      }
    }
    assert.ok(smallSeen > 0, 'the local data has no small count, so the marker was not exercised');
  });

  it('answers 400 for an unsupported range and 405 to anything but GET', async () => {
    assert.equal((await fetch(`${GATEWAY}/api/operator/projects?days=14`)).status, 400);
    assert.equal((await fetch(`${GATEWAY}/api/operator/projects?days=7`, { method: 'POST' })).status, 405);
  });
});
