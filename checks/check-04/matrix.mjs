// Round two, item F: every GET route of Umami 3.5.0 is either probed across the tenant boundary
// or listed here with the reason it is not. The list of routes is read from Umami's source, so a
// route added by an upgrade makes the check fail until it is placed in one of the tables below.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { rangeQuery } from './harness.mjs';
import { READ_ROUTES } from './read-routes.mjs';

const OK = 200;
const REFUSED = 401;
const NOT_FOUND = 404;

// Routes under /api/websites/:id that also take the id of a stored object. `stored` routes are
// probed with a real object of each tenant. The others have no object to read in this stack (no
// error was reported and no session was recorded), so only the website guard is exercised: the
// tenant's own key must get past it and the other tenant's key must not.
const ID_ROUTES = [
  { tail: '/sessions/:sessionId', stored: true },
  { tail: '/sessions/:sessionId/activity', stored: true },
  { tail: '/sessions/:sessionId/properties', stored: true },
  { tail: '/sessions/:sessionId/replays', stored: true },
  { tail: '/event-data/:eventId', stored: true },
  { tail: '/annotations/:annotationId', stored: true },
  { tail: '/segments/:segmentId', stored: true },
  { tail: '/funnels/:funnelId', stored: true },
  { tail: '/funnels/:funnelId/stats', stored: true },
  { tail: '/goals/:goalId', stored: true },
  { tail: '/goals/:goalId/stats', stored: true },
  { tail: '/errors/:issueId', own: NOT_FOUND },
  { tail: '/errors/:issueId/events', own: NOT_FOUND },
  { tail: '/errors/:issueId/values', extra: 'type=browser', own: NOT_FOUND },
  { tail: '/errors/:issueId/events/:eventId', own: NOT_FOUND },
  { tail: '/replays/:replayId', own: OK },
  { tail: '/replays/saved/:replayId', own: OK },
];

// Routes outside /api/websites that carry a tenant's id in the path.
const SCOPED_ROUTES = [
  ['realtime/[websiteId]', tenant => `/api/realtime/${tenant.websiteId}`],
  ['teams/[teamId]', tenant => `/api/teams/${tenant.teamId}`],
  ['teams/[teamId]/users', tenant => `/api/teams/${tenant.teamId}/users`],
  ['teams/[teamId]/websites', tenant => `/api/teams/${tenant.teamId}/websites`],
  ['teams/[teamId]/boards', tenant => `/api/teams/${tenant.teamId}/boards`],
  ['teams/[teamId]/links', tenant => `/api/teams/${tenant.teamId}/links`],
  ['teams/[teamId]/pixels', tenant => `/api/teams/${tenant.teamId}/pixels`],
  ['boards/[boardId]', tenant => `/api/boards/${tenant.userId}`],
  ['boards/[boardId]/shares', tenant => `/api/boards/${tenant.userId}/shares`],
];

// Lists without an id in the path. `own` says whether the caller's own tenant must appear.
const LIST_ROUTES = [
  ['websites', () => '/api/websites?includeTeams=1', true],
  ['me/websites', () => '/api/me/websites?includeTeams=1', true],
  ['me/teams', () => '/api/me/teams', true],
  ['teams', () => '/api/teams', true],
  ['boards', () => '/api/boards', false],
  ['links', () => '/api/links', false],
  ['pixels', () => '/api/pixels', false],
  ['websites/charts', (own, other) => `/api/websites/charts?ids=${own.websiteId},${other.websiteId}`, false],
];

// Closed to a tenant's key even for its own ids, so there is no boundary to compare across.
const CLOSED_ROUTES = [
  ['admin/teams', () => '/api/admin/teams'],
  ['admin/users', () => '/api/admin/users'],
  ['admin/websites', () => '/api/admin/websites'],
  ['admin/users/[userId]/2fa', tenant => `/api/admin/users/${tenant.userId}/2fa`],
  ['users/[userId]', tenant => `/api/users/${tenant.userId}`],
  ['users/[userId]/teams', tenant => `/api/users/${tenant.userId}/teams`],
  ['users/[userId]/websites', tenant => `/api/users/${tenant.userId}/websites`],
  ['teams/[teamId]/users/[userId]', tenant => `/api/teams/${tenant.teamId}/users/${tenant.userId}`],
  ['me/api-keys', () => '/api/me/api-keys'],
  ['2fa/status', () => '/api/2fa/status'],
  ['dashboard', () => '/api/dashboard'],
];

// Not probed across the boundary, with the reason. Share routes are exercised in group E.
const NOT_PROBED = {
  heartbeat: 'public, returns no data',
  'scripts/telemetry': 'public, returns a script',
  'auth/subscription': 'returns the caller\'s own plan, takes no id',
  me: 'returns the caller\'s own identity, takes no id; used in group A',
  'websites/[websiteId]/recorder': 'public by design, settings only; probed without a credential',
  'share/[slug]': 'public by design; no share exists for a provisioned tenant (group E)',
  'share/id/[shareId]': 'no share exists for a provisioned tenant (group E)',
  'links/[linkId]': 'tenants have no links; a view-only key cannot create one (group E)',
  'links/[linkId]/shares': 'tenants have no links',
  'links/charts': 'tenants have no links',
  'pixels/[pixelId]': 'tenants have no pixels; a view-only key cannot create one (group E)',
  'pixels/[pixelId]/shares': 'tenants have no pixels',
  'pixels/charts': 'tenants have no pixels',
};

const sourcePattern = tail => `websites/[websiteId]${tail.replace(/:(\w+)/g, '[$1]')}`;

function fill(tail, ids) {
  return tail.replace(/:(\w+)/g, (_, name) => ids[name]);
}

/** Every route file under umami/src/app/api that exports a GET handler, as a source path. */
export function listGetRoutes(apiRoot) {
  const found = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'route.ts' && readFileSync(path, 'utf8').includes('export async function GET')) {
        found.push(relative(apiRoot, directory));
      }
    }
  };
  walk(apiRoot);
  return found.sort();
}

/** Objects of one tenant that the id routes read. Created by the admin, or found in the lists. */
export async function plantObjects(call, admin, tenant) {
  const base = `/api/websites/${tenant.websiteId}`;
  const create = async (tail, body) => {
    const result = await call('POST', `${base}${tail}`, admin, body);
    if (result.status !== OK) throw new Error(`could not create ${tail} for ${tenant.slug}: HTTP ${result.status}`);
    return result.json.id;
  };
  const steps = [
    { type: 'path', value: '/' },
    { type: 'path', value: '/pricing' },
  ];
  const sessions = await call('GET', `${base}/sessions?${rangeQuery('')}`, admin);
  const events = await call('GET', `${base}/events?${rangeQuery('')}`, admin);
  const ids = {
    sessionId: sessions.json?.data?.[0]?.id,
    eventId: events.json?.data?.find(event => event.eventName)?.id,
    annotationId: await create('/annotations', { date: new Date().toISOString(), note: `note of ${tenant.slug}` }),
    segmentId: await create('/segments', { type: 'segment', name: tenant.slug, parameters: { filters: [] } }),
    funnelId: await create('/funnels', { name: tenant.slug, parameters: { window: 60, steps } }),
    goalId: await create('/goals', { name: tenant.slug, parameters: { type: 'path', value: '/' } }),
  };
  if (!ids.sessionId || !ids.eventId) throw new Error(`no session or event found for ${tenant.slug}`);
  return ids;
}

function carries(text, tenant) {
  return [tenant.websiteId, tenant.teamId, tenant.userId, tenant.hostname].some(value => text.includes(value));
}

async function probeWebsiteRoutes({ call, record, covered }, a, b) {
  for (const [route, extra] of READ_ROUTES) {
    covered.add(sourcePattern(route));
    const pathFor = tenant => `/api/websites/${tenant.websiteId}${route}?${rangeQuery(extra)}`;
    const shown = `GET /api/websites/:id${route}`;
    for (const [reader, target] of [[a, a], [b, b]]) {
      const own = await call('GET', pathFor(target), reader.key);
      record('F1 own data', `${reader.label} key reads ${target.label}`, shown, `${reader.label} key`, own.status, OK);
    }
    for (const [reader, target] of [[a, b], [b, a]]) {
      const cross = await call('GET', pathFor(target), reader.key);
      record('F2 cross-tenant read', `${reader.label} key reads ${target.label}`, shown, `${reader.label} key`, cross.status, REFUSED);
    }
  }
}

async function probeIdRoutes({ call, record, covered }, a, b) {
  const missing = { issueId: randomUUID(), eventId: randomUUID(), replayId: randomUUID() };
  for (const { tail, extra = '', stored = false, own = OK } of ID_ROUTES) {
    covered.add(sourcePattern(tail));
    const idsOf = tenant => (stored ? tenant.objects : missing);
    const pathFor = (website, ids) => `/api/websites/${website.websiteId}${fill(tail, ids)}?${rangeQuery(extra)}`;
    const shown = `GET /api/websites/:id${tail}`;
    const kind = stored ? 'stored object' : 'no stored object, guard only';
    for (const [reader, target] of [[a, a], [b, b], [a, b], [b, a]]) {
      const isOwn = reader === target;
      const result = await call('GET', pathFor(target, idsOf(target)), reader.key);
      const group = isOwn ? 'F1 own data' : 'F2 cross-tenant read';
      record(group, `${reader.label} key reads ${target.label} (${kind})`, shown, `${reader.label} key`, result.status, isOwn ? own : REFUSED);
    }
    if (!stored) continue;
    // The other tenant's object id, asked through the caller's own website.
    const sideways = await call('GET', pathFor(a, b.objects), a.key);
    const list = sideways.json?.data ?? sideways.json;
    const empty = !sideways.json || (Array.isArray(list) && list.length === 0);
    const leaked = carries(sideways.text, b) || sideways.text.includes(`note of ${b.slug}`);
    const verdict = leaked ? 'leak' : sideways.status === NOT_FOUND || empty ? 'no B data' : 'unexpected';
    record('F2 cross-tenant read', 'A key, A website, B object id', shown, 'A key', `${sideways.status} ${verdict}`, `${sideways.status} no B data`);
  }
}

async function probeOtherRoutes({ call, record, covered }, a, b) {
  for (const [pattern, pathFor] of SCOPED_ROUTES) {
    covered.add(pattern);
    for (const [reader, target] of [[a, a], [b, b], [a, b], [b, a]]) {
      const isOwn = reader === target;
      const result = await call('GET', pathFor(target), reader.key);
      const group = isOwn ? 'F1 own data' : 'F2 cross-tenant read';
      record(group, `${reader.label} key reads ${target.label}`, `GET /api/${pattern}`, `${reader.label} key`, result.status, isOwn ? OK : REFUSED);
    }
  }
  for (const [pattern, pathFor, mustShowOwn] of LIST_ROUTES) {
    covered.add(pattern);
    for (const [reader, other] of [[a, b], [b, a]]) {
      const result = await call('GET', pathFor(reader, other), reader.key);
      const ownShown = !mustShowOwn || carries(result.text, reader);
      const clean = result.status === OK && ownShown && !carries(result.text, other);
      const expected = `only ${reader.label}`;
      record('F3 lists', `${reader.label} key lists`, `GET /api/${pattern}`, `${reader.label} key`, clean ? expected : `${result.status} wrong`, expected);
    }
  }
  for (const [pattern, pathFor] of CLOSED_ROUTES) {
    covered.add(pattern);
    for (const reader of [a, b]) {
      const result = await call('GET', pathFor(reader), reader.key);
      record('F4 closed to every key', `${reader.label} key, own ids`, `GET /api/${pattern}`, `${reader.label} key`, result.status, REFUSED);
    }
  }
}

/**
 * Runs the matrix for two provisioned tenants.
 *
 * @param {object} context
 * @param {Function} context.call HTTP client.
 * @param {Function} context.record Adds one row to the result table.
 * @param {string} context.apiRoot Path of umami/src/app/api.
 * @param {object} a Tenant A: label, slug, hostname, ids, key and objects.
 * @param {object} b Tenant B.
 * @returns {Promise<object>} Route counts for the summary.
 */
export async function runMatrix({ call, record, apiRoot }, a, b) {
  const covered = new Set();
  const context = { call, record, covered };
  await probeWebsiteRoutes(context, a, b);
  await probeIdRoutes(context, a, b);
  await probeOtherRoutes(context, a, b);

  const recorder = await call('GET', `/api/websites/${b.websiteId}/recorder`, null);
  record('F5 public by design', 'recorder settings of B, no credential', 'GET /api/websites/:id/recorder', 'nobody', `${recorder.status} ${recorder.text}`, '200 {"enabled":false}');

  const inventory = listGetRoutes(apiRoot);
  const unaccounted = inventory.filter(route => !covered.has(route) && !(route in NOT_PROBED));
  const stale = [...covered, ...Object.keys(NOT_PROBED)].filter(route => !inventory.includes(route));
  record('F6 inventory', 'every GET route in the source is probed or listed with a reason', 'umami/src/app/api', 'source', unaccounted.join(' ') || 'none unaccounted', 'none unaccounted');
  record('F6 inventory', 'every route named by this check exists in the source', 'umami/src/app/api', 'source', stale.join(' ') || 'none stale', 'none stale');
  return {
    inventory: inventory.length,
    probed: covered.size,
    notProbed: NOT_PROBED,
    websiteRoutes: READ_ROUTES.length,
    idRoutesStored: ID_ROUTES.filter(route => route.stored).length,
    idRoutesGuardOnly: ID_ROUTES.filter(route => !route.stored).length,
    scoped: SCOPED_ROUTES.length,
    lists: LIST_ROUTES.length,
    closed: CLOSED_ROUTES.length,
  };
}
