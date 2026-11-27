// API figures for one project, read from usage_signals.api_metric_minute. Percentiles come from
// the summed histogram buckets, the way Prometheus's histogram_quantile estimates them.
import { apiDailySums, apiRouteSums } from './db.js'
import { rangeOf } from './web-read.js'

// Upper bounds of the shared histogram buckets, in milliseconds (console/db/schema.sql).
const BOUNDS_MS = [5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
const CLASSES = ['2xx', '3xx', '4xx', '5xx']

/**
 * Estimates the `q` quantile of a histogram: it finds the bucket that holds the rank and
 * interpolates linearly inside it. The first bucket starts at 0; a rank in the last, open bucket
 * gives the highest finite bound. Returns null for an empty histogram.
 */
export function percentileMs(buckets, q) {
  const total = buckets.reduce((sum, count) => sum + count, 0)
  if (total === 0) return null
  const rank = q * total
  let below = 0
  for (let index = 0; index < BOUNDS_MS.length; index += 1) {
    const count = buckets[index]
    if (below + count >= rank && count > 0) {
      const lower = index === 0 ? 0 : BOUNDS_MS[index - 1]
      return lower + ((BOUNDS_MS[index] - lower) * (rank - below)) / count
    }
    below += count
  }
  return BOUNDS_MS.at(-1)
}

function addBuckets(into, buckets) {
  buckets.forEach((count, index) => {
    into[index] += count
  })
}

function emptyFigure() {
  const statuses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
  return { requests: 0, statuses, buckets: new Array(BOUNDS_MS.length + 1).fill(0) }
}

function finish({ buckets, ...figure }) {
  return { ...figure, p50_ms: percentileMs(buckets, 0.5), p95_ms: percentileMs(buckets, 0.95) }
}

/** API figures of one project for the last `dayCount` UTC days, today included. */
export async function readApiFigures(site, dayCount) {
  const now = Date.now()
  const { days, startAt, endAt } = rangeOf(dayCount, now)
  const [sums, daily] = await Promise.all([
    apiRouteSums(site.tenantId, startAt, endAt),
    apiDailySums(site.tenantId, startAt, endAt),
  ])
  const totals = emptyFigure()
  const routes = new Map()
  for (const row of sums) {
    const key = `${row.service} ${row.method} ${row.route}`
    if (!routes.has(key)) {
      const { service, method, route } = row
      routes.set(key, { service, method, route, ...emptyFigure() })
    }
    const name = CLASSES[row.class - 2]
    for (const figure of [routes.get(key), totals]) {
      figure.requests += row.requests
      if (name) figure.statuses[name] += row.requests
      addBuckets(figure.buckets, row.buckets)
    }
  }
  const perDay = new Map(daily.map((row) => [row.day, row.requests]))
  return {
    days: dayCount,
    through: new Date(now).toISOString(),
    totals: finish(totals),
    daily: days.map((day) => ({ day, requests: perDay.get(day) ?? 0 })),
    routes: [...routes.values()].map(finish).sort((a, b) => b.requests - a.requests),
  }
}
