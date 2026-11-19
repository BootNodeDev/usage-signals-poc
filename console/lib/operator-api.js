// Operator console endpoint: every site in one answer, aggregates only, small counts rounded
// here and never in the page. No access control yet: anyone can read it.
import { listSites } from './db.js';
import {
  SMALL_COUNT_BELOW,
  SMALL_COUNT_STEP,
  badRange,
  cached,
  json,
  rangeParam,
  readFigures,
  roundSmall,
  unavailable,
} from './web-read.js';

function roundedRows(rows) {
  return rows.map((row) => ({ label: row.label, value: roundSmall(row.value) }));
}

// Rates are computed from the exact counts before rounding, so they stay meaningful.
function operatorRow(site, figures) {
  const { totals, breakdowns } = figures;
  const rounded = {};
  for (const [dimension, rows] of Object.entries(breakdowns)) rounded[dimension] = roundedRows(rows);
  return {
    project: { id: site.id, name: site.name, domain: site.domain, state: site.state },
    totals: {
      pageviews: roundSmall(totals.pageviews),
      visitors: roundSmall(totals.visitors),
      visits: roundSmall(totals.visits),
      bounces: roundSmall(totals.bounces),
      bounce_rate: totals.visits ? totals.bounces / totals.visits : 0,
      avg_visit_seconds: totals.visits ? totals.total_seconds / totals.visits : 0,
      // Traffic is not classified in this prototype: unknown, not zero.
      flagged: null,
    },
    daily: figures.daily.map((row) => ({ day: row.day, pageviews: roundSmall(row.pageviews) })),
    breakdowns: rounded,
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
      rounding: { below: SMALL_COUNT_BELOW, step: SMALL_COUNT_STEP },
      projects: figures.map((siteFigures, index) => operatorRow(sites[index], siteFigures)),
    });
  } catch (error) {
    return unavailable(error);
  }
}
