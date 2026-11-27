// Operator console endpoint: every site in one answer, aggregates only. A count from 1 to 9 is
// never sent: it is replaced here, not in the page, by a marker. No access control yet:
// anyone can read it.
import { readApiFigures } from './api-read.js';
import { listSites } from './db.js';
import { DIMENSIONS, badRange, cached, json, rangeParam, readFigures, unavailable } from './web-read.js';

// Placeholder threshold, to be agreed with the program.
export const SMALL_COUNT_BELOW = 10;
const BREAKDOWNS_READ = {
  all: DIMENSIONS,
  totals: [],
  one: ['referrers'], // the only breakdown the start page shows
};

/** Zero and counts from the threshold up are exact; anything between is only "small". */
export function smallCount(count) {
  if (count > 0 && count < SMALL_COUNT_BELOW) return { small: true, below: SMALL_COUNT_BELOW };
  return count;
}

// A rate over a small number of visits or requests would give the small count away.
function rateOver(base, rate) {
  if (!base) return null;
  return base < SMALL_COUNT_BELOW ? smallCount(base) : rate;
}

function identity(site) {
  return { id: site.id, slug: site.slug, name: site.name, domain: site.domain, state: site.state };
}

/** One row of the operator list, from the exact figures of a site. */
export function operatorRow(site, figures) {
  const { totals, breakdowns } = figures;
  const shown = {};
  for (const [dimension, rows] of Object.entries(breakdowns)) {
    shown[dimension] = rows.map((row) => ({ label: row.label, value: smallCount(row.value) }));
  }
  return {
    project: identity(site),
    totals: {
      pageviews: smallCount(totals.pageviews),
      visitors: smallCount(totals.visitors),
      visits: smallCount(totals.visits),
      bounces: smallCount(totals.bounces),
      bounce_rate: rateOver(totals.visits, totals.bounces / totals.visits),
      avg_visit_seconds: rateOver(totals.visits, totals.total_seconds / totals.visits),
      flagged: smallCount(totals.flagged),
    },
    flagged_by_rule: Object.fromEntries(
      Object.entries(figures.flagged_by_rule).map(([rule, count]) => [rule, smallCount(count)]),
    ),
    daily: figures.daily.map((row) => ({
      day: row.day,
      pageviews: smallCount(row.pageviews),
      flagged: smallCount(row.flagged),
    })),
    breakdowns: shown,
  };
}

/** The API figures of one row: requests, the share of 5xx answers, p50, p95 and per route. */
export function operatorApi(api) {
  const { requests, statuses, p50_ms, p95_ms } = api.totals;
  return {
    requests: smallCount(requests),
    error_rate: rateOver(requests, statuses['5xx'] / requests),
    p50_ms: rateOver(requests, p50_ms),
    p95_ms: rateOver(requests, p95_ms),
    routes: api.routes.map((row) => ({
      label: `${row.service} · ${row.method} ${row.route}`,
      value: smallCount(row.requests),
    })),
  };
}

/**
 * API figures by site id. API rows belong to a tenant, so each tenant is read once and shown on
 * its first site; its other sites get none. A failed read gives null, so the web figures stay.
 */
export async function apiBySite(sites, dayCount, read = readApiFigures) {
  const first = new Map();
  for (const site of sites) if (!first.has(site.tenantId)) first.set(site.tenantId, site);
  const entries = await Promise.all(
    [...first.values()].map(async (site) => {
      try {
        return [site.id, operatorApi(await read(site, dayCount))];
      } catch (error) {
        console.error(`operator: API figures of ${site.slug} unavailable: ${error.message}`);
        return [site.id, null];
      }
    }),
  );
  return new Map(entries);
}

/**
 * The operator answer for these sites: aggregates only, small counts hidden. `mode` picks the
 * breakdowns read; with `shown`, only that site's figures are read and the others are listed.
 * The metrics API (`/api/v1/projects`) sends the same answer with `mode` `all`.
 */
export async function operatorFigures(sites, dayCount, mode = 'all', shown = null) {
  const readSite = (site) =>
    shown && site !== shown ? null : readFigures(site, dayCount, BREAKDOWNS_READ[mode]);
  // The start page modes show no API figures, so only `all` reads them.
  const [figures, api] = await Promise.all([
    Promise.all(sites.map(readSite)),
    mode === 'all' ? apiBySite(sites, dayCount) : new Map(),
  ]);
  const unread = (site) => ({
    project: identity(site), totals: null, flagged_by_rule: {}, daily: [], breakdowns: {},
  });
  return {
    days: dayCount,
    through: figures.find(Boolean)?.through ?? new Date().toISOString(),
    small_counts: { below: SMALL_COUNT_BELOW },
    projects: sites.map((site, index) => ({
      ...(figures[index] ? operatorRow(site, figures[index]) : unread(site)),
      api: api.get(site.id) ?? null,
    })),
  };
}

function previewed(sites, slug) {
  if (slug) return sites.find((site) => site.slug === slug);
  return sites.find((site) => site.state === 'active') ?? sites[0];
}

/**
 * GET /api/operator/projects?days=7|30|90[&figures=all|totals|one[&project=<slug>]]
 * Every site is listed. `all` (the default) reads every figure, API figures included; `totals`
 * leaves out the breakdowns; `one` reads only the project named, or else the first active one, with its referrers.
 */
export async function handleOperatorProjects(request) {
  if (request.method !== 'GET') return json(405, { error: 'Use GET.' }, { allow: 'GET' });
  const dayCount = rangeParam(request);
  if (!dayCount) return badRange();
  const params = new URL(request.url).searchParams;
  const mode = params.get('figures') ?? 'all';
  const slug = params.get('project');
  if (!Object.hasOwn(BREAKDOWNS_READ, mode)) {
    return json(400, { error: `figures must be one of ${Object.keys(BREAKDOWNS_READ).join(', ')}.` });
  }
  if (slug !== null && mode !== 'one') return json(400, { error: 'project needs figures=one.' });
  try {
    const sites = await listSites();
    const shown = mode === 'one' ? previewed(sites, slug) : null;
    if (slug && !shown) return json(404, { error: 'Project not found.' });
    return cached(await operatorFigures(sites, dayCount, mode, shown));
  } catch (error) {
    return unavailable(error);
  }
}
