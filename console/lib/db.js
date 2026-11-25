import { createHash } from 'node:crypto';
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

function sha256(text) {
  return createHash('sha256').update(text).digest();
}

/**
 * Records that the truncated address showed this User-Agent today (UTC) and returns how many
 * distinct User-Agents it has shown today, this one included. Only hashes reach the database.
 */
export async function countAgentsToday(address, userAgent) {
  // The final SELECT reads the table as it was before the INSERT, so the new row is added apart.
  const { rows } = await getPool().query(
    `WITH today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS day),
     expired AS (
       DELETE FROM usage_signals.agent_sighting WHERE day < (SELECT day FROM today)
     ),
     added AS (
       INSERT INTO usage_signals.agent_sighting (day, address_hash, agent_hash)
       SELECT day, $1, $2 FROM today
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int + (SELECT count(*)::int FROM added) AS agents
       FROM usage_signals.agent_sighting
      WHERE day = (SELECT day FROM today) AND address_hash = $1`,
    [sha256(address), sha256(userAgent)],
  );
  return rows[0].agents;
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
