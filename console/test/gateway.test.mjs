// End-to-end check against the running local stack (docker compose, seed, dev.mjs).
// Everything is asserted through public interfaces: the gateway, Umami's statistics API,
// and a database dump.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { truncateAddress } from '../lib/client-address.js';
import { requireEnv } from '../lib/config.js';
import { MAX_AGENTS_PER_ADDRESS } from '../lib/flags.js';
import { umamiLogin, umamiRequest } from '../lib/umami-admin.js';
import { BY_TAG, FLAGGED } from '../lib/web-read.js';
import { FETCH_METADATA, TENANTS } from '../scripts/fixtures.mjs';

const POC_ROOT = path.resolve(import.meta.dirname, '..');
if (!process.env.GATEWAY_URL) process.loadEnvFile(path.join(POC_ROOT, 'local.env'));

const GATEWAY = requireEnv('GATEWAY_URL');
const DEMO = requireEnv('DEMO_URL');
const [SITE_A, SITE_B, SITE_SUSPENDED, SITE_PUBLIC_HOST] = TENANTS.map((tenant) => tenant.site);
const BREAKDOWNS = ['referrer', 'country', 'browser', 'os', 'device'];
const FORGEABLE_FIELDS = {
  ip: '9.9.9.9',
  userAgent: 'Forged/1.0',
  timestamp: 1_700_000_000,
  id: 'forged-visitor',
};

// The platform reports each visitor's country in x-vercel-ip-country; dev.mjs relays ours.
const CHROME_DESKTOP = {
  address: '8.8.8.8',
  truncated: '8.8.8.0',
  country: 'US',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};
const SAFARI_MOBILE = {
  address: '200.45.191.35',
  truncated: '200.45.191.0',
  country: 'AR',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
};
const FIREFOX_DESKTOP = {
  address: '2a00:1450:4001:81b::200e',
  truncated: '2a00:1450:4001::',
  country: 'DE',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
};
// Same /24 and same /48 as the visitors above: after truncation Umami cannot tell them apart.
const CHROME_NEIGHBOUR = { ...CHROME_DESKTOP, address: '8.8.8.77' };
const FIREFOX_NEIGHBOUR = { ...FIREFOX_DESKTOP, address: '2a00:1450:4001:ffff::1' };
// Next /24 over: stays a separate visitor. Its country is deliberately not the one a geo
// database gives for the address, to show the figure comes from the platform header.
const CHROME_OTHER_NETWORK = {
  ...CHROME_DESKTOP,
  address: '8.8.6.6',
  truncated: '8.8.6.0',
  country: 'CA',
};
const VISITORS = [
  CHROME_DESKTOP,
  SAFARI_MOBILE,
  FIREFOX_DESKTOP,
  CHROME_NEIGHBOUR,
  FIREFOX_NEIGHBOUR,
  CHROME_OTHER_NETWORK,
];
const ROTATED_AGENTS = [];

let umami;
let windowStart;
let scratch;
const spawned = [];
const stubs = [];

function trackerBody(site, url, referrer = '') {
  return {
    type: 'event',
    payload: {
      website: site.umamiWebsiteId,
      screen: '1920x1080',
      language: 'en-US',
      title: 'Demo page',
      hostname: 'localhost',
      url,
      referrer,
    },
  };
}

function sendEvent({ gateway = GATEWAY, site, visitor, origin, body }) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': visitor.userAgent,
    'x-forwarded-for': visitor.address,
    'x-vercel-ip-country': visitor.country,
    ...(visitor.fetchMetadata !== false && FETCH_METADATA),
  };
  const sentOrigin = origin === undefined ? `http://${site.domain}` : origin;
  if (sentOrigin !== null) headers.origin = sentOrigin;
  return fetch(`${gateway}/api/e`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function umamiJson(pathAndQuery) {
  const response = await umamiRequest(umami, pathAndQuery);
  assert.equal(response.status, 200, `Umami ${pathAndQuery} answered ${response.status}`);
  return response.json();
}

async function figures(site, startAt) {
  const base = `/api/websites/${site.umamiWebsiteId}`;
  const range = `startAt=${startAt}&endAt=${Date.now() + 60_000}`;
  const { pageviews, visitors, visits, bounces, totaltime } = await umamiJson(
    `${base}/stats?${range}`,
  );
  const result = { pageviews, visitors, visits, bounces, totaltime };
  for (const type of BREAKDOWNS) {
    const rows = await umamiJson(`${base}/metrics?${range}&type=${type}`);
    result[type] = Object.fromEntries(rows.map((row) => [row.x, row.y]));
  }
  return result;
}

async function assertUnchanged(site, action) {
  const beforeAction = await figures(site, 0);
  await action();
  assert.deepEqual(await figures(site, 0), beforeAction, `figures of ${site.domain} changed`);
}

async function startGateway(env) {
  const child = spawn(process.execPath, ['dev.mjs'], {
    cwd: POC_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  spawned.push(child);
  for await (const chunk of child.stdout) {
    if (String(chunk).includes('demo site:')) return `http://localhost:${env.GATEWAY_PORT}`;
  }
  throw new Error(`dev.mjs exited before listening on port ${env.GATEWAY_PORT}`);
}

describe('gateway', () => {
  before(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'usage-signals-test-'));
    umami = await umamiLogin();
    // Statistics are read from windowStart on, so earlier runs do not count.
    await sleep(1_100);
    windowStart = Date.now() - 500;
  });

  after(() => {
    for (const child of spawned) child.kill();
    for (const stub of stubs) stub.close();
    console.log(`Scratch directory (not deleted): ${scratch}`);
  });

  it('turns accepted events into the seven metrics for the right site', async () => {
    const baselineB = await figures(SITE_B, 0);
    const visits = [
      [CHROME_DESKTOP, '/', 'https://stellar.org/learn'],
      [SAFARI_MOBILE, '/', 'https://news.ycombinator.com/item?id=1'],
      [FIREFOX_DESKTOP, '/about.html', ''],
      [CHROME_NEIGHBOUR, '/', ''],
      [FIREFOX_NEIGHBOUR, '/', ''],
      [CHROME_OTHER_NETWORK, '/', ''],
    ];
    for (const [visitor, url, referrer] of visits) {
      const response = await sendEvent({
        site: SITE_A,
        visitor,
        body: trackerBody(SITE_A, url, referrer),
      });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('access-control-allow-origin'), `http://${SITE_A.domain}`);
    }
    await sleep(2_000);
    const secondPage = await sendEvent({
      site: SITE_A,
      visitor: CHROME_DESKTOP,
      body: trackerBody(SITE_A, '/about.html', '/'),
    });
    assert.equal(secondPage.status, 202);

    const { totaltime, ...counted } = await figures(SITE_A, windowStart);
    assert.deepEqual(counted, {
      pageviews: 7,
      visitors: 4,
      visits: 4,
      bounces: 2,
      referrer: { 'stellar.org': 1, 'news.ycombinator.com': 1 },
      country: { US: 1, CA: 1, AR: 1, DE: 1 },
      browser: { chrome: 2, ios: 1, firefox: 1 },
      os: { 'Windows 10': 2, iOS: 1, Linux: 1 },
      device: { desktop: 3, mobile: 1 },
    });
    assert.ok(totaltime >= 2 && totaltime <= 10, `total time ${totaltime}s, expected about 2s`);
    assert.deepEqual(await figures(SITE_B, 0), baselineB, 'site B changed');
    assert.equal((await figures(SITE_B, windowStart)).pageviews, 0);
  });

  it('answers 403 and forwards nothing when the Origin is not the site domain', async () => {
    const body = trackerBody(SITE_A, '/forged');
    const attempts = [
      { site: SITE_A, origin: 'https://evil.example', body },
      { site: SITE_A, origin: `http://${SITE_B.domain}`, body },
      { site: SITE_A, origin: null, body },
      { site: SITE_A, origin: 'not a url', body },
      { site: SITE_A, body: trackerBody({ umamiWebsiteId: crypto.randomUUID() }, '/forged') },
    ];
    await assertUnchanged(SITE_A, async () => {
      for (const attempt of attempts) {
        const response = await sendEvent({ ...attempt, visitor: CHROME_DESKTOP });
        assert.equal(response.status, 403, `origin ${attempt.origin}`);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
    });
  });

  it('answers 403 and forwards nothing for a suspended tenant', async () => {
    await assertUnchanged(SITE_SUSPENDED, async () => {
      const response = await sendEvent({
        site: SITE_SUSPENDED,
        visitor: CHROME_DESKTOP,
        body: trackerBody(SITE_SUSPENDED, '/'),
      });
      assert.equal(response.status, 403);
    });
  });

  it('answers 400 and forwards nothing when the caller supplies identity fields', async () => {
    await assertUnchanged(SITE_A, async () => {
      for (const [field, value] of Object.entries(FORGEABLE_FIELDS)) {
        const inPayload = trackerBody(SITE_A, '/forged');
        inPayload.payload[field] = value;
        const atRoot = { ...trackerBody(SITE_A, '/forged'), [field]: value };
        for (const body of [inPayload, atRoot]) {
          const response = await sendEvent({ site: SITE_A, visitor: SAFARI_MOBILE, body });
          assert.equal(response.status, 400, `${field} must be refused`);
        }
      }
    });
  });

  it('answers 400 for bodies that are not a tracker event', async () => {
    await assertUnchanged(SITE_A, async () => {
      const bodies = ['{not json', '[]', JSON.stringify({ ...trackerBody(SITE_A, '/'), type: 'identify' })];
      for (const body of bodies) {
        const response = await fetch(`${GATEWAY}/api/e`, {
          method: 'POST',
          headers: { origin: `http://${SITE_A.domain}`, 'content-type': 'application/json' },
          body,
        });
        assert.equal(response.status, 400, body);
      }
    });
  });

  it('answers the CORS preflight for registered origins only', async () => {
    const preflight = (origin) =>
      fetch(`${GATEWAY}/api/e`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-umami-hostname,x-umami-website-id',
        },
      });
    const allowed = await preflight(`http://${SITE_A.domain}`);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), `http://${SITE_A.domain}`);
    assert.equal(allowed.headers.get('vary'), 'Origin');
    assert.match(allowed.headers.get('access-control-allow-headers'), /x-umami-website-id/);
    for (const origin of ['https://evil.example', `http://${SITE_SUSPENDED.domain}`]) {
      const refused = await preflight(origin);
      assert.equal(refused.status, 403, origin);
      assert.equal(refused.headers.get('access-control-allow-origin'), null);
    }
  });

  it('answers 405 for other methods and 404 for other paths', async () => {
    assert.equal((await fetch(`${GATEWAY}/api/e`)).status, 405);
    assert.equal((await fetch(`${GATEWAY}/api/unknown`, { method: 'POST' })).status, 404);
  });

  it('fails closed with 503 when Umami or the database is unreachable', async () => {
    const withoutUmami = await startGateway({
      GATEWAY_PORT: '4310',
      DEMO_PORT: '4311',
      UMAMI_URL: 'http://127.0.0.1:1',
    });
    const failingUmami = createServer((_request, response) => response.writeHead(500).end());
    await new Promise((resolve) => failingUmami.listen(0, '127.0.0.1', resolve));
    stubs.push(failingUmami);
    const withFailingUmami = await startGateway({
      GATEWAY_PORT: '4314',
      DEMO_PORT: '4315',
      UMAMI_URL: `http://127.0.0.1:${failingUmami.address().port}`,
    });
    const withoutDatabase = await startGateway({
      GATEWAY_PORT: '4312',
      DEMO_PORT: '4313',
      DATABASE_URL: 'postgresql://poc:poc-local-only@127.0.0.1:1/poc',
    });
    await assertUnchanged(SITE_A, async () => {
      for (const gateway of [withoutUmami, withFailingUmami, withoutDatabase]) {
        const response = await sendEvent({
          gateway,
          site: SITE_A,
          visitor: CHROME_DESKTOP,
          body: trackerBody(SITE_A, '/outage'),
        });
        assert.equal(response.status, 503, gateway);
      }
    });
  });

  it('treats an upper-case website id as the same site and the same visitor', async () => {
    const earlier = await figures(SITE_A, windowStart);
    const upperCased = { umamiWebsiteId: SITE_A.umamiWebsiteId.toUpperCase() };
    const response = await sendEvent({
      site: SITE_A,
      visitor: CHROME_DESKTOP,
      body: trackerBody(upperCased, '/'),
    });
    assert.equal(response.status, 202);
    const later = await figures(SITE_A, windowStart);
    assert.equal(later.pageviews, earlier.pageviews + 1);
    assert.equal(later.visitors, earlier.visitors, 'the same visitor was counted twice');
  });

  it('requires https for the Origin of a host that is not loopback', async () => {
    const send = (origin) =>
      sendEvent({
        site: SITE_PUBLIC_HOST,
        visitor: CHROME_DESKTOP,
        origin,
        body: trackerBody(SITE_PUBLIC_HOST, '/'),
      });
    await assertUnchanged(SITE_PUBLIC_HOST, async () => {
      assert.equal((await send(`http://${SITE_PUBLIC_HOST.domain}`)).status, 403);
      const preflight = await fetch(`${GATEWAY}/api/e`, {
        method: 'OPTIONS',
        headers: { origin: `http://${SITE_PUBLIC_HOST.domain}` },
      });
      assert.equal(preflight.status, 403);
    });
    const earlier = await figures(SITE_PUBLIC_HOST, 0);
    assert.equal((await send(`https://${SITE_PUBLIC_HOST.domain}`)).status, 202);
    assert.equal((await figures(SITE_PUBLIC_HOST, 0)).pageviews, earlier.pageviews + 1);
  });

  it('answers 400 and forwards nothing when a forwarded field holds a NUL character', async () => {
    const withNul = [
      { url: '/a\u0000b' },
      { referrer: 'https://stellar.org/\u0000' },
      { name: 'sign\u0000up' },
      { name: 'signup', data: { plan: 'pro\u0000' } },
      { name: 'signup', data: { nested: { 'key\u0000': ['x'] } } },
    ];
    await assertUnchanged(SITE_A, async () => {
      for (const fields of withNul) {
        const body = trackerBody(SITE_A, '/nul');
        Object.assign(body.payload, fields);
        const response = await sendEvent({ site: SITE_A, visitor: CHROME_DESKTOP, body });
        assert.equal(response.status, 400, JSON.stringify(fields));
      }
    });
  });

  it('maps the answer of Umami by meaning', async () => {
    let upstreamStatus;
    const umamiStub = createServer((_request, response) => response.writeHead(upstreamStatus).end());
    await new Promise((resolve) => umamiStub.listen(0, '127.0.0.1', resolve));
    stubs.push(umamiStub);
    const gateway = await startGateway({
      GATEWAY_PORT: '4316',
      DEMO_PORT: '4317',
      UMAMI_URL: `http://127.0.0.1:${umamiStub.address().port}`,
    });
    const expected = { 200: 202, 400: 400, 404: 503, 429: 503, 500: 503, 502: 503 };
    for (const [upstream, answer] of Object.entries(expected)) {
      upstreamStatus = Number(upstream);
      const response = await sendEvent({
        gateway,
        site: SITE_A,
        visitor: CHROME_DESKTOP,
        body: trackerBody(SITE_A, '/'),
      });
      assert.equal(response.status, answer, `Umami ${upstream}`);
    }
  });

  it('records visitor and country when Umami has no geo database, as on Vercel', async () => {
    const gateway = await startGateway({
      GATEWAY_PORT: '4318',
      DEMO_PORT: '4319',
      UMAMI_URL: requireEnv('UMAMI_NOGEO_URL'),
    });
    const visitor = { ...SAFARI_MOBILE, address: '190.210.7.9', truncated: '190.210.7.0', country: 'UY' };
    VISITORS.push(visitor);
    for (const url of ['/', '/pricing']) {
      const response = await sendEvent({
        gateway,
        site: SITE_B,
        visitor,
        body: trackerBody(SITE_B, url),
      });
      assert.equal(response.status, 202);
    }
    // Site B receives nothing else during a run, so the window holds exactly these two events.
    const { pageviews, visitors, country, browser } = await figures(SITE_B, windowStart);
    assert.deepEqual({ pageviews, visitors, country, browser }, {
      pageviews: 2,
      visitors: 1,
      country: { UY: 1 },
      browser: { ios: 1 },
    });
  });

  it('stores flagged events with the rules they matched in the tag', async () => {
    const network = randomBytes(4).toString('hex');
    const address = `2a0b:${network.slice(0, 4)}:${network.slice(4)}::1`;
    const rotating = { ...FIREFOX_DESKTOP, address, truncated: truncateAddress(address) };
    VISITORS.push(rotating);
    for (let index = 0; index <= MAX_AGENTS_PER_ADDRESS; index += 1) {
      ROTATED_AGENTS.push(`${FIREFOX_DESKTOP.userAgent}.${Number.parseInt(network, 16)}.${index}`);
    }
    const sent = [
      { visitor: { ...CHROME_DESKTOP, userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } },
      { visitor: { ...SAFARI_MOBILE, fetchMetadata: false } },
      ...ROTATED_AGENTS.map((userAgent) => ({ visitor: { ...rotating, userAgent } })),
    ];
    for (const event of sent) {
      const response = await sendEvent({ ...event, site: SITE_A, body: trackerBody(SITE_A, '/flagged') });
      assert.equal(response.status, 202);
    }
    const range = `startAt=${windowStart}&endAt=${Date.now() + 60_000}`;
    const rows = await umamiJson(`/api/websites/${SITE_A.umamiWebsiteId}/breakdown?${range}&${BY_TAG}&${FLAGGED}`);
    assert.deepEqual(Object.fromEntries(rows.map((row) => [row.tag, Number(row.views)])), {
      bot: 1,
      'no-sec-fetch': 1,
      'many-agents': 1,
    });
  });

  it('serves the pinned tracker with the integrity value the demo page declares', async () => {
    const manifest = await (await fetch(`${GATEWAY}/s/manifest.json`)).json();
    const tracker = await fetch(`${GATEWAY}${manifest.path}`);
    assert.equal(tracker.status, 200);
    assert.equal(tracker.headers.get('access-control-allow-origin'), '*');
    const digest = createHash('sha384').update(Buffer.from(await tracker.arrayBuffer()));
    assert.equal(`sha384-${digest.digest('base64')}`, manifest.integrity);
    for (const page of ['/demo/', '/demo/pricing']) {
      const html = await (await fetch(`${DEMO}${page}`)).text();
      assert.ok(html.includes(`src="${DEMO}${manifest.path}"`), `${page} script src`);
      assert.ok(html.includes(`integrity="${manifest.integrity}"`), `${page} integrity`);
      assert.ok(html.includes('crossorigin="anonymous"'), `${page} crossorigin`);
      assert.ok(html.includes(`data-website-id="${SITE_A.umamiWebsiteId}"`), `${page} site`);
    }
  });

  it('leaves no client address in the database or in the container logs', () => {
    const compose = ['compose', '-f', path.join(POC_ROOT, 'docker-compose.yml')];
    const options = { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' };
    const dump = execFileSync('docker', [...compose, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'poc', 'poc'], options);
    const logs = execFileSync('docker', [...compose, 'logs', '--no-color'], options);
    writeFileSync(path.join(scratch, 'dump.sql'), dump);
    writeFileSync(path.join(scratch, 'containers.log'), logs);

    assert.ok(dump.includes('usage_signals.tenant'), 'dump misses our schema');
    assert.ok(dump.includes('/about.html'), 'dump misses the events this run sent');
    for (const { address, truncated } of VISITORS) {
      for (const needle of [address, truncated, FORGEABLE_FIELDS.ip]) {
        assert.ok(!dump.includes(needle), 'a client address is stored in the database');
        assert.ok(!logs.includes(needle), 'a client address is in the container logs');
      }
    }
    for (const userAgent of ROTATED_AGENTS) {
      assert.ok(!dump.includes(userAgent), 'a User-Agent is stored in the database');
    }
  });
});
