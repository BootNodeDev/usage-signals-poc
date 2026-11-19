// Web figures for one site, read from Umami's statistics API with the admin account. The
// browser never talks to Umami: the tenant and operator endpoints call this module.
import { umamiGet } from './umami-admin.js';

const RANGES = [7, 30, 90];
const DAY_MS = 86_400_000;
// Short shared cache: several viewers cost one read, and a new page view shows within seconds.
const CACHE_CONTROL = 'public, max-age=0, s-maxage=10';
// Placeholder values for "aggregates only, with small counts rounded": to be set with the fund.
export const SMALL_COUNT_BELOW = 100;
export const SMALL_COUNT_STEP = 10;
const BREAKDOWNS = { referrers: 'referrer', countries: 'country', devices: 'device', browsers: 'browser' };

export function json(status, body, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export function cached(body) {
  return json(200, body, { 'cache-control': CACHE_CONTROL });
}

/** Returns the number of days asked for, or null when it is not a supported range. */
export function rangeParam(request) {
  const dayCount = Number(new URL(request.url).searchParams.get('days'));
  return RANGES.includes(dayCount) ? dayCount : null;
}

export function badRange() {
  return json(400, { error: `days must be one of ${RANGES.join(', ')}.` });
}

export function unavailable(error) {
  console.error(`read: figures unavailable: ${error.message}`);
  return json(503, { error: 'Figures are unavailable right now. Retry later.' });
}

/** Counts under the threshold are rounded to the step, so a small audience is not exposed. */
export function roundSmall(count) {
  if (count >= SMALL_COUNT_BELOW) return count;
  return Math.round(count / SMALL_COUNT_STEP) * SMALL_COUNT_STEP;
}

/** A visitor is counted once per day, so a multi-day figure is the sum of the daily figures. */
export function sumOfDaily(rows) {
  let total = 0;
  for (const row of rows) total += row.visitors;
  return total;
}

function byDay(series) {
  return new Map(series.map((point) => [point.x.slice(0, 10), point.y]));
}

/** One row per day of the range; Umami only returns the days that have events. */
export function dailyRows(days, pageviewSeries, sessionSeries) {
  const pageviews = byDay(pageviewSeries.pageviews);
  const visitors = byDay(sessionSeries.sessions);
  return days.map((day) => ({
    day,
    pageviews: pageviews.get(day) ?? 0,
    visitors: visitors.get(day) ?? 0,
  }));
}

// The range is whole UTC days and ends now: the current day is included, incomplete.
function rangeOf(dayCount, now) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const days = [];
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    days.push(new Date(today - offset * DAY_MS).toISOString().slice(0, 10));
  }
  return { days, startAt: today - (dayCount - 1) * DAY_MS, endAt: now };
}

function totalsOf(stats, visitors) {
  return {
    pageviews: stats.pageviews,
    visitors,
    visits: stats.visits,
    bounces: stats.bounces,
    total_seconds: stats.totaltime,
  };
}

/** Exact figures of one site for the last `dayCount` UTC days, today included. */
export async function readFigures(site, dayCount) {
  const now = Date.now();
  const { days, startAt, endAt } = rangeOf(dayCount, now);
  const base = `/api/websites/${site.umamiWebsiteId}`;
  const range = `startAt=${startAt}&endAt=${endAt}`;
  const dimensions = Object.keys(BREAKDOWNS);
  const [stats, series, ...metrics] = await Promise.all([
    umamiGet(`${base}/stats?${range}`),
    umamiGet(`${base}/pageviews?${range}&unit=day&timezone=UTC`),
    ...dimensions.map((name) => umamiGet(`${base}/metrics?${range}&type=${BREAKDOWNS[name]}`)),
  ]);
  const daily = dailyRows(days, series, series);
  const breakdowns = {};
  dimensions.forEach((name, index) => {
    breakdowns[name] = metrics[index].map((row) => ({ label: row.x, value: row.y }));
  });
  return {
    days: dayCount,
    through: new Date(now).toISOString(),
    totals: totalsOf(stats, sumOfDaily(daily)),
    // Umami's comparison period; its visitor figure is not a sum of daily and is left out.
    prior: stats.comparison ? totalsOf(stats.comparison, null) : null,
    daily,
    breakdowns,
  };
}

