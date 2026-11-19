// Operator console endpoint: every site in one answer, aggregates only. A count from 1 to 9 is
// never sent: it is replaced here, not in the page, by a marker. No access control yet:
// anyone can read it.
import { listSites } from './db.js';
import { badRange, cached, json, rangeParam, readFigures, unavailable } from './web-read.js';

// Placeholder threshold, to be agreed with the program.
export const SMALL_COUNT_BELOW = 10;

/** Zero and counts from the threshold up are exact; anything between is only "small". */
export function smallCount(count) {
  if (count > 0 && count < SMALL_COUNT_BELOW) return { small: true, below: SMALL_COUNT_BELOW };
  return count;
}

// A rate over a small number of visits would give the small count away.
function rateOver(visits, rate) {
  if (!visits) return null;
  return visits < SMALL_COUNT_BELOW ? smallCount(visits) : rate;
}

/** One row of the operator list, from the exact figures of a site. */
export function operatorRow(site, figures) {
  const { totals, breakdowns } = figures;
  const shown = {};
  for (const [dimension, rows] of Object.entries(breakdowns)) {
    shown[dimension] = rows.map((row) => ({ label: row.label, value: smallCount(row.value) }));
  }
  return {
    project: { id: site.id, name: site.name, domain: site.domain, state: site.state },
    totals: {
      pageviews: smallCount(totals.pageviews),
      visitors: smallCount(totals.visitors),
      visits: smallCount(totals.visits),
      bounces: smallCount(totals.bounces),
      bounce_rate: rateOver(totals.visits, totals.bounces / totals.visits),
      avg_visit_seconds: rateOver(totals.visits, totals.total_seconds / totals.visits),
      // Traffic is not classified in this prototype: unknown, not zero.
      flagged: null,
    },
    daily: figures.daily.map((row) => ({ day: row.day, pageviews: smallCount(row.pageviews) })),
    breakdowns: shown,
  };
}

/** GET /api/operator/projects?days=7|30|90 */
export async function handleOperatorProjects(request) {
  if (request.method !== 'GET') return json(405, { error: 'Use GET.' }, { allow: 'GET' });
  const dayCount = rangeParam(request);
  if (!dayCount) return badRange();
  try {
    const sites = await listSites();
    const figures = await Promise.all(sites.map((site) => readFigures(site, dayCount)));
    return cached({
      days: dayCount,
      through: figures[0]?.through ?? new Date().toISOString(),
      small_counts: { below: SMALL_COUNT_BELOW },
      projects: figures.map((siteFigures, index) => operatorRow(sites[index], siteFigures)),
    });
  } catch (error) {
    return unavailable(error);
  }
}
