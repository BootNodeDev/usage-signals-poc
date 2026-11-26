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

const SITE_COLUMNS = `s.id, s.slug, t.name, s.domain, t.status AS state, s.umami_website_id AS "umamiWebsiteId"`;
const SITE_ORDER = 's.created_at, s.id';

/** Sites of every project that has not been removed, oldest first. */
export async function listSites() {
  const { rows } = await getPool().query(
    `SELECT ${SITE_COLUMNS}
       FROM usage_signals.site s
       JOIN usage_signals.tenant t ON t.id = s.tenant_id
      WHERE t.status <> 'removed'
      ORDER BY ${SITE_ORDER}`,
  );
  return rows;
}

export async function findSiteBySlug(slug) {
  const { rows } = await getPool().query(
    `SELECT ${SITE_COLUMNS}
       FROM usage_signals.site s
       JOIN usage_signals.tenant t ON t.id = s.tenant_id
      WHERE s.slug = $1 AND t.status <> 'removed'`,
    [slug],
  );
  return rows[0] ?? null;
}

/** The active site registered for this host, with its 0-based position among all sites. */
export async function findActiveSiteByDomain(domain) {
  const { rows } = await getPool().query(
    `SELECT *
       FROM (SELECT ${SITE_COLUMNS}, (row_number() OVER (ORDER BY ${SITE_ORDER}))::int - 1 AS position
               FROM usage_signals.site s
               JOIN usage_signals.tenant t ON t.id = s.tenant_id) ranked
      WHERE domain = $1 AND state = 'active'`,
    [domain],
  );
  return rows[0] ?? null;
}

/**
 * Runs `task` while this connection holds a transaction-level advisory lock on `key`, and returns
 * null without running it when another connection holds the lock. A session-level lock would not
 * hold through Neon's pooled connection, which hands each transaction to any server connection.
 */
export async function withTransactionLock(key, task) {
  const client = await getPool().connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [key]);
    if (!rows[0].locked) return null;
    return await task();
  } finally {
    await client.query('ROLLBACK').catch((error) => {
      releaseError = error;
    });
    client.release(releaseError);
  }
}
