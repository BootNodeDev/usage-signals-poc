// Tenant console endpoints. The project is named by the slug in the path and each answer holds
// that one site only. This is addressing, not access control: anyone who knows a slug can read
// its aggregates. With sign-in, `projectOf` is where the session replaces the path.
import { readApiFigures } from './api-read.js';
import { findSiteBySlug } from './db.js';
import { MAX_AGENTS_PER_ADDRESS } from './flags.js';
import { isSlug } from './slug.js';
import { TRACKER } from './tracker.generated.js';
import { badRange, cached, json, rangeParam, readFigures, unavailable } from './web-read.js';

function publicProject(site) {
  return { slug: site.slug, name: site.name, domain: site.domain, state: site.state };
}

async function projectOf(slug) {
  return isSlug(slug) ? findSiteBySlug(slug) : null;
}

async function answer(request, slug, respond) {
  if (request.method !== 'GET') return json(405, { error: 'Use GET.' }, { allow: 'GET' });
  try {
    const site = await projectOf(slug);
    if (!site) return json(404, { error: 'Project not found.' });
    return await respond(site);
  } catch (error) {
    return unavailable(error);
  }
}

/** GET /api/tenant/<slug>/web?days=7|30|90 */
export function handleTenantWeb(request, slug) {
  const dayCount = rangeParam(request);
  if (request.method === 'GET' && !dayCount) return badRange();
  return answer(request, slug, async (site) =>
    cached({
      project: publicProject(site),
      max_agents_per_address: MAX_AGENTS_PER_ADDRESS,
      ...(await readFigures(site, dayCount)),
    }),
  );
}

/** GET /api/tenant/<slug>/project: the project, its website id and the pinned tracker for its tag. */
export function handleTenantProject(request, slug) {
  return answer(request, slug, (site) =>
    cached({ project: { ...publicProject(site), website_id: site.umamiWebsiteId }, tracker: TRACKER }),
  );
}

/** GET /api/tenant/<slug>/api?days=7|30|90 */
export function handleTenantApi(request, slug) {
  const dayCount = rangeParam(request);
  if (request.method === 'GET' && !dayCount) return badRange();
  return answer(request, slug, async (site) =>
    cached({ project: publicProject(site), ...(await readApiFigures(site, dayCount)) }),
  );
}
