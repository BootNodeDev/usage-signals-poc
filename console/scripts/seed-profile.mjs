// Decides what the seed creates from the environment it runs in: the local fixtures on a
// developer machine, one demo tenant on the deployment's own host in a Vercel production build.
import { TENANTS } from './fixtures.mjs';

export const PRODUCTION_TENANT_ID = 'f0000000-0000-4000-8000-000000000001';
export const PRODUCTION_SITE_ID = 'f0000000-0000-4000-8000-0000000000f1';
export const PRODUCTION_WEBSITE_ID = 'f0000000-0000-4000-8000-0000000000ff';

const SEED_INPUTS = ['DATABASE_URL_UNPOOLED', 'UMAMI_URL', 'UMAMI_ADMIN_PASSWORD'];
const RESERVED_HOST = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|\[::1\]|(.*\.)?example)(:\d+)?$/i;

function profileName(env) {
  if (!env.VERCEL) return 'local';
  return env.VERCEL_ENV === 'production' ? 'production' : 'preview';
}

/** Names the environment variables the seed needs here and does not have. */
export function missingInputs(env) {
  const required = {
    local: [...SEED_INPUTS, 'GATEWAY_URL'],
    production: ['VERCEL_PROJECT_PRODUCTION_URL', ...SEED_INPUTS],
    preview: ['VERCEL_PROJECT_PRODUCTION_URL'],
  }[profileName(env)];
  return required.filter((name) => !env[name]);
}

function productionHost(env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL;
  if (RESERVED_HOST.test(host)) {
    throw new Error(
      `VERCEL_PROJECT_PRODUCTION_URL is "${host}", which is not a public host. ` +
        'The production seed only registers the real production domain.',
    );
  }
  return host;
}

function productionTenant(domain) {
  return {
    id: PRODUCTION_TENANT_ID,
    name: 'Usage Signals demo',
    status: 'active',
    site: { id: PRODUCTION_SITE_ID, domain, umamiWebsiteId: PRODUCTION_WEBSITE_ID },
  };
}

/**
 * Returns `{ name, tenants, demo }`: the tenants to seed and the site the demo pages report to.
 * Preview builds seed nothing; their demo pages point at production.
 */
export function selectProfile(env) {
  const name = profileName(env);
  if (name === 'local') {
    const demo = { websiteId: TENANTS[0].site.umamiWebsiteId, gatewayOrigin: env.GATEWAY_URL };
    return { name, tenants: TENANTS, demo };
  }
  const host = productionHost(env);
  return {
    name,
    tenants: name === 'production' ? [productionTenant(host)] : [],
    demo: { websiteId: PRODUCTION_WEBSITE_ID, gatewayOrigin: `https://${host}` },
  };
}
