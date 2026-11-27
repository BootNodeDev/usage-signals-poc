import { isSlug, RESERVED_SLUGS } from '../lib/slug.js'
import { TENANTS } from './fixtures.mjs'

// One per host in DEMO_SITE_HOSTS, in order; ids are fixed so a site keeps its history across builds.
export const PRODUCTION_TENANTS = [
  {
    id: 'f0000000-0000-4000-8000-000000000001',
    name: 'Demo site A',
    slug: 'demo-site-a',
    siteId: 'f0000000-0000-4000-8000-0000000000f1',
    umamiWebsiteId: 'f0000000-0000-4000-8000-0000000000ff',
  },
  {
    id: 'f0000000-0000-4000-8000-000000000002',
    name: 'Demo site B',
    slug: 'demo-site-b',
    siteId: 'f0000000-0000-4000-8000-0000000000f2',
    umamiWebsiteId: 'f0000000-0000-4000-8000-0000000002ff',
  },
  {
    id: 'f0000000-0000-4000-8000-000000000003',
    name: 'Demo site C',
    slug: 'demo-site-c',
    siteId: 'f0000000-0000-4000-8000-0000000000f3',
    umamiWebsiteId: 'f0000000-0000-4000-8000-0000000003ff',
  },
]

const LIVE_TENANTS = [
  {
    id: 'f0000000-0000-4000-8000-000000000004',
    name: 'Strata Vault Kit',
    status: 'active',
    site: {
      id: 'f0000000-0000-4000-8000-0000000000f4',
      slug: 'strata-vault-kit',
      domain: 'strata-vault-kit-app.vercel.app',
      umamiWebsiteId: 'f0000000-0000-4000-8000-0000000004ff',
    },
  },
]

const SEED_INPUTS = ['DATABASE_URL_UNPOOLED', 'UMAMI_URL', 'UMAMI_ADMIN_PASSWORD']
const RESERVED_HOST = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\]|(.*\.)?example)(:\d+)?$/i
// Lower-case DNS name of at least two labels: no scheme, port, path, space or wildcard.
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const HOSTS_FORMAT =
  `Expected one to ${PRODUCTION_TENANTS.length} lower-case host names separated by a comma and ` +
  'nothing else: the hosts of Demo site A, B and C, in that order.'

function profileName(env) {
  if (!env.VERCEL) return 'local'
  return env.VERCEL_ENV === 'production' ? 'production' : 'preview'
}

/** Names the environment variables the seed needs here and does not have. */
export function missingInputs(env) {
  const required = {
    local: SEED_INPUTS,
    production: ['DEMO_SITE_HOSTS', ...SEED_INPUTS],
    preview: ['DATABASE_URL'],
  }[profileName(env)]
  return required.filter((name) => !env[name])
}

/**
 * Parses DEMO_SITE_HOSTS: the hosts of Demo site A, B and C, in that order. Anything
 * malformed throws, so the build stops. `consoleHost` is the host the console itself is
 * opened on, which may not also be a demo site.
 */
export function parseDemoSiteHosts(value, consoleHost) {
  const fail = (reason) => {
    throw new Error(`DEMO_SITE_HOSTS is "${value ?? ''}": ${reason}. ${HOSTS_FORMAT}`)
  }
  if (!value) fail('at least one host is required')
  const hosts = value.split(',')
  if (hosts.length > PRODUCTION_TENANTS.length) {
    fail(`at most ${PRODUCTION_TENANTS.length} hosts are supported`)
  }
  for (const host of hosts) {
    if (!HOST_NAME.test(host)) fail(`"${host}" is not a plain host name`)
    if (RESERVED_HOST.test(host)) fail(`"${host}" is a loopback or reserved host`)
    if (host === consoleHost) fail(`"${host}" is the console's own host`)
    if (hosts.indexOf(host) !== hosts.lastIndexOf(host)) fail(`"${host}" is listed twice`)
  }
  return hosts
}

function productionTenants(env) {
  const hosts = parseDemoSiteHosts(env.DEMO_SITE_HOSTS, env.VERCEL_PROJECT_PRODUCTION_URL)
  const demoTenants = hosts.map((domain, index) => {
    const { id, name, slug, siteId, umamiWebsiteId } = PRODUCTION_TENANTS[index]
    return { id, name, status: 'active', site: { id: siteId, slug, domain, umamiWebsiteId } }
  })
  return [...demoTenants, ...LIVE_TENANTS]
}

/**
 * Stops the seed when a site's slug cannot address a tenant console: wrong shape, a word the
 * routes already use, or the same slug twice. Also stops it when two sites share a domain.
 */
export function assertSites(tenants) {
  const slugs = new Set()
  const domains = new Set()
  for (const { name, site } of tenants) {
    const problem =
      (!isSlug(site.slug) &&
        'must be lower-case letters, digits and single hyphens, at most 63 characters') ||
      (RESERVED_SLUGS.includes(site.slug) &&
        `is reserved for a route of the console (${RESERVED_SLUGS.join(', ')})`) ||
      (slugs.has(site.slug) && 'is used by two sites')
    if (problem) throw new Error(`The slug "${site.slug}" of "${name}" ${problem}.`)
    if (domains.has(site.domain))
      throw new Error(`The domain "${site.domain}" of "${name}" is used by two sites.`)
    slugs.add(site.slug)
    domains.add(site.domain)
  }
}

/**
 * Returns `{ name, tenants, databaseVariable }`: the tenants to seed, and the variable that holds
 * the database the schema goes to. Preview builds seed no tenant and get no unpooled URL on Vercel.
 */
export function selectProfile(env) {
  const name = profileName(env)
  const tenants = { local: TENANTS, production: [], preview: [] }[name]
  const profile = {
    name,
    tenants: name === 'production' ? productionTenants(env) : tenants,
    databaseVariable: name === 'preview' ? 'DATABASE_URL' : 'DATABASE_URL_UNPOOLED',
  }
  assertSites(profile.tenants)
  return profile
}
