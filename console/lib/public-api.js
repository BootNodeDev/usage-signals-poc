import { listSites } from './db.js'
import { SMALL_COUNT_BELOW, smallCount } from './operator-api.js'
import { badRange, cached, json, rangeParam, readFigures, unavailable } from './web-read.js'

/**
 * One row of the public list: the project's name and two counted totals, small counts masked.
 * @example
 *   publicRow({ name: 'Aurora Wallet', slug: 'aurora-wallet' }, { totals: { pageviews: 120, visitors: 4 } })
 *   // { project: { name: 'Aurora Wallet' }, totals: { pageviews: 120, visitors: { small: true, below: 10 } } }
 */
export function publicRow(site, figures) {
  return {
    project: { name: site.name },
    totals: {
      pageviews: smallCount(figures.totals.pageviews),
      visitors: smallCount(figures.totals.visitors),
    },
  }
}

/**
 * GET /api/public/projects?days=7|30|90
 * Every active project with its page views and visitors, for anyone. Pick `handleOperatorProjects`
 * for everything else about a project: ids, slug, domain, state and every other figure.
 */
export async function handlePublicProjects(request) {
  if (request.method !== 'GET') return json(405, { error: 'Use GET.' }, { allow: 'GET' })
  const dayCount = rangeParam(request)
  if (!dayCount || new URL(request.url).search !== `?days=${dayCount}`) return badRange() // one URL per range, so extra parameters cannot skip the shared cache
  try {
    const sites = (await listSites()).filter((site) => site.state === 'active')
    const figures = await Promise.all(sites.map((site) => readFigures(site, dayCount, [])))
    return cached({
      days: dayCount,
      through: figures[0]?.through ?? new Date().toISOString(),
      small_counts: { below: SMALL_COUNT_BELOW },
      projects: sites.map((site, index) => publicRow(site, figures[index])),
    })
  } catch (error) {
    return unavailable(error)
  }
}
