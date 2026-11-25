// Sample traffic for the demo sites, so the console shows steady figures up to the current hour.
// A Vercel cron job calls the route every three hours. Each run asks Umami which complete hours have no
// page view tagged "sample" yet and fills them, so a missed run is caught up by the next one and
// nothing is stored outside Umami. A database lock lets only one run send at a time, since Vercel
// can deliver a scheduled run twice. The tag also keeps the sample apart from real visits.
import { createHash } from 'node:crypto';
import { listSites, withTransactionLock } from './db.js';
import { umamiGet } from './umami-admin.js';
import { forwardToUmami } from './umami.js';

// The first hour filled. The sample traffic loaded by hand on 2026-11-19 ends the day before.
export const FIRST_SAMPLE_HOUR = Date.parse('2026-11-20T00:00:00Z');
const HOUR_MS = 3_600_000;
// Umami answers per hour only for a range of 30 days or less, and per day beyond that.
const WINDOW_MS = 30 * 24 * HOUR_MS;
// Any fixed number: it names the run's advisory lock in Postgres.
const RUN_LOCK_KEY = 4_502_028;
const MAX_HOURS_PER_RUN = 72;
const CONCURRENT_SENDS = 8;
const SAMPLE_TAG = 'sample';

// Page views a day for each demo site, close to the hand-loaded sample of October and November.
export const SAMPLE_SITES = {
  'demo-site-a': { pageViewsPerDay: 140, pages: ['/demo/', '/demo/pricing', '/demo/docs'] },
  'demo-site-b': { pageViewsPerDay: 60, pages: ['/demo/', '/demo/wallets', '/demo/fees'] },
  'demo-site-c': { pageViewsPerDay: 15, pages: ['/demo/', '/demo/explorer', '/demo/status'] },
};

// Share of a day's traffic in each UTC hour: low at night in the Americas and Europe.
const HOUR_WEIGHTS = [3, 2, 2, 2, 2, 2, 3, 4, 5, 6, 6, 7, 7, 7, 8, 8, 8, 7, 7, 6, 6, 5, 4, 3];
const HOUR_WEIGHT_TOTAL = HOUR_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
const WEEKEND_FACTOR = 0.75;

const REFERRERS = [
  ['https://www.google.com/', 30],
  ['https://stellar.org/', 17],
  ['https://github.com/', 13],
  ['https://x.com/', 11],
  ['https://discord.com/', 11],
  ['https://www.reddit.com/', 6],
  ['https://duckduckgo.com/', 3],
  ['', 9],
];
const COUNTRIES = [
  ['US', 24], ['AR', 15], ['DE', 9], ['GB', 8], ['NG', 8], ['BR', 8], ['IN', 7], ['ES', 6],
  ['MX', 5], ['FR', 4], ['UA', 3], ['CO', 3],
];
// Umami derives browser, OS and device from the User-Agent and the screen size.
const CLIENTS = [
  [
    {
      screen: '1440x900',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    },
    38,
  ],
  [
    {
      screen: '390x844',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    },
    13,
  ],
  [
    {
      screen: '1512x982',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    },
    12,
  ],
  [
    {
      screen: '1366x768',
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
    },
    12,
  ],
  [
    {
      screen: '1536x864',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
    },
    11,
  ],
  [
    {
      screen: '412x915',
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    },
    12,
  ],
  [
    {
      screen: '1920x1080',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
    },
    2,
  ],
];
// Documentation ranges (RFC 5737): visitor addresses that belong to nobody.
const ADDRESS_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];
const BOUNCE_SHARE = 0.44;

/** A small deterministic generator, so one site and hour always plans the same visits. */
function random(seedText) {
  let state = createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick(next, weighted) {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let point = next() * total;
  for (const [value, weight] of weighted) {
    point -= weight;
    if (point < 0) return value;
  }
  return weighted.at(-1)[0];
}

/** Page views expected in one UTC hour for a site that gets `perDay` on a weekday. */
export function pageViewsInHour(perDay, hourStart) {
  const date = new Date(hourStart);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const share = HOUR_WEIGHTS[date.getUTCHours()] / HOUR_WEIGHT_TOTAL;
  return perDay * share * (weekend ? WEEKEND_FACTOR : 1);
}

/**
 * Plans the page views of one site in one UTC hour. Each visitor makes one visit, either a
 * bounce or two to five pages, and every page view falls inside the hour.
 */
export function planHour(slug, profile, hourStart) {
  const next = random(`${slug}:${hourStart}`);
  const expected = pageViewsInHour(profile.pageViewsPerDay, hourStart);
  const target = Math.floor(expected) + (next() < expected % 1 ? 1 : 0);
  const events = [];
  while (events.length < target) {
    const pages = next() < BOUNCE_SHARE ? 1 : 2 + Math.floor(next() * 4);
    const start = hourStart + Math.floor(next() * (HOUR_MS - pages * 120_000));
    const client = pick(next, CLIENTS);
    const visitor = {
      address: `${ADDRESS_PREFIXES[Math.floor(next() * 3)]}${1 + Math.floor(next() * 254)}`,
      country: pick(next, COUNTRIES),
      userAgent: client.userAgent,
      screen: client.screen,
    };
    const referrer = pick(next, REFERRERS);
    let at = start;
    for (let page = 0; page < pages && events.length < target; page += 1) {
      const url =
        page === 0 ? profile.pages[0] : profile.pages[Math.floor(next() * profile.pages.length)];
      events.push({ ...visitor, url, referrer: page === 0 ? referrer : '', at });
      at += 20_000 + Math.floor(next() * 100_000);
    }
  }
  return events;
}

function eventPayload(site, event) {
  const payload = {
    website: site.umamiWebsiteId,
    hostname: site.domain,
    url: event.url,
    screen: event.screen,
    userAgent: event.userAgent,
    timestamp: Math.floor(event.at / 1000),
    tag: SAMPLE_TAG,
  };
  if (event.referrer) payload.referrer = event.referrer;
  return payload;
}

async function sendAll(site, events) {
  let failed = 0;
  for (let index = 0; index < events.length; index += CONCURRENT_SENDS) {
    const batch = events.slice(index, index + CONCURRENT_SENDS);
    const statuses = await Promise.all(
      batch.map((event) =>
        forwardToUmami(eventPayload(site, event), {
          address: event.address,
          country: event.country,
        }).catch(() => 0),
      ),
    );
    failed += statuses.filter((status) => status < 200 || status >= 300).length;
  }
  return failed;
}

/** The complete hours a site still lacks, oldest first, from FIRST_SAMPLE_HOUR up to `now`. */
export function missingHours(done, now, first = FIRST_SAMPLE_HOUR) {
  const hours = [];
  const lastComplete = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
  for (let hour = first; hour <= lastComplete; hour += HOUR_MS) {
    if (!done.has(hour)) hours.push(hour);
  }
  return hours;
}

/** The first hour a run looks at: 30 days back from `now`, rounded up, and not before `first`. */
export function sampleWindowStart(now, first = FIRST_SAMPLE_HOUR) {
  return Math.max(first, Math.ceil((now - WINDOW_MS) / HOUR_MS) * HOUR_MS);
}

/** UTC hours, as epoch milliseconds, in which Umami holds sample page views for the site. */
export async function hoursWithSample(site, first, now) {
  const query = `startAt=${first}&endAt=${now}&unit=hour&timezone=UTC&tag=${SAMPLE_TAG}`;
  const body = await umamiGet(`/api/websites/${site.umamiWebsiteId}/pageviews?${query}`);
  return new Set(body.pageviews.filter((point) => point.y > 0).map((point) => Date.parse(point.x)));
}

/**
 * Sends the sample traffic of every missing hour in the last 30 days, at most MAX_HOURS_PER_RUN
 * site-hours per run. An hour with any sample page view counts as done, so a partly failed hour
 * is not completed. Returns null when another run is sending.
 */
export function fillSampleTraffic({
  now = Date.now(),
  sites = SAMPLE_SITES,
  first = FIRST_SAMPLE_HOUR,
} = {}) {
  return withTransactionLock(RUN_LOCK_KEY, () => fillHours(now, sites, sampleWindowStart(now, first)));
}

async function fillHours(now, sites, start) {
  const registered = (await listSites()).filter(
    (site) => site.state === 'active' && sites[site.slug],
  );
  const report = { filled: 0, pageViews: 0, failedHours: 0, remaining: 0 };
  let budget = MAX_HOURS_PER_RUN;
  for (const site of registered) {
    const hours = missingHours(await hoursWithSample(site, start, now), now, start);
    for (const hour of hours) {
      if (budget === 0) {
        report.remaining += 1;
        continue;
      }
      budget -= 1;
      const events = planHour(site.slug, sites[site.slug], hour);
      const failed = await sendAll(site, events);
      if (failed > 0) {
        report.failedHours += 1;
        continue;
      }
      report.filled += 1;
      report.pageViews += events.length;
    }
  }
  return report;
}

/** GET /api/cron/sample-traffic. Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. */
export async function handleSampleTraffic(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  try {
    const report = await fillSampleTraffic();
    if (report === null) {
      console.log('sample traffic: skipped, another run is sending');
      return Response.json({ skipped: 'Another run is sending.' });
    }
    console.log(`sample traffic: ${JSON.stringify(report)}`);
    return Response.json(report, { status: report.failedHours > 0 ? 502 : 200 });
  } catch (error) {
    console.error(`sample traffic: run failed: ${error.message}`);
    return Response.json({ error: 'Sample traffic run failed.' }, { status: 503 });
  }
}
