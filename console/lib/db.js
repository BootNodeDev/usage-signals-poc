import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';
import { requireEnv } from './config.js';

let pool;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: requireEnv('DATABASE_URL'),
      max: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
    pool.on('error', (error) => console.error(`database: idle connection failed: ${error.message}`));
    // Lets Vercel close idle connections before it suspends the instance; a no-op elsewhere.
    attachDatabasePool(pool);
  }
  return pool;
}

/** Returns `{ domain, tenantStatus }` for the site registered with this Umami website id. */
export async function findSiteByWebsiteId(websiteId) {
  const { rows } = await getPool().query(
    `SELECT s.domain, t.status AS "tenantStatus"
       FROM usage_signals.site s
       JOIN usage_signals.tenant t ON t.id = s.tenant_id
      WHERE s.umami_website_id = $1`,
    [websiteId],
  );
  return rows[0] ?? null;
}

export async function isDomainOfActiveTenant(domain) {
  const { rowCount } = await getPool().query(
    `SELECT 1
       FROM usage_signals.site s
       JOIN usage_signals.tenant t ON t.id = s.tenant_id
      WHERE s.domain = $1 AND t.status = 'active'`,
    [domain],
  );
  return rowCount > 0;
}
