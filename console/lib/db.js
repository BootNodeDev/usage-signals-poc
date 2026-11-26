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

const SITE_COLUMNS = `s.id, s.slug, t.id AS "tenantId", t.name, s.domain, t.status AS state,
  s.umami_website_id AS "umamiWebsiteId"`;
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

/** Minutes, as epoch milliseconds, that hold API rows of `service` for the tenant in a range. */
export async function apiMinutesOf(tenantId, service, startAt, endAt) {
  const { rows } = await getPool().query(
    `SELECT DISTINCT minute FROM usage_signals.api_metric_minute
      WHERE tenant_id = $1 AND service = $2 AND minute >= $3 AND minute < $4`,
    [tenantId, service, new Date(startAt), new Date(endAt)],
  );
  return new Set(rows.map((row) => row.minute.getTime()));
}

/**
 * Stores the API rows of one minute. A row already stored for the same series is kept, so
 * writing the same minute twice changes nothing.
 */
export async function insertApiMinute(tenantId, minute, service, rows) {
  await getPool().query(
    `INSERT INTO usage_signals.api_metric_minute
       (tenant_id, minute, service, route, method, status_code, request_count, duration_sum_ms,
        bucket_counts)
     SELECT $1, $2, $3, r.route, r.method, r.status, r.count, r."sumMs", r.buckets
       FROM jsonb_to_recordset($4::jsonb)
         AS r(route text, method text, status smallint, count bigint, "sumMs" double precision,
              buckets bigint[])
     ON CONFLICT DO NOTHING`,
    [tenantId, new Date(minute), service, JSON.stringify(rows)],
  );
}

const BUCKET_SUMS = Array.from(
  { length: 15 },
  (_, i) => `sum(bucket_counts[${i + 1}])::float8`,
).join(', ');

/**
 * API rows of the tenant in a range, summed per service, route, method and status class, with
 * the histogram buckets summed one by one.
 */
export async function apiRouteSums(tenantId, startAt, endAt) {
  const { rows } = await getPool().query(
    `SELECT service, route, method, status_code / 100 AS class,
            sum(request_count)::float8 AS requests, ARRAY[${BUCKET_SUMS}] AS buckets
       FROM usage_signals.api_metric_minute
      WHERE tenant_id = $1 AND minute >= $2 AND minute < $3
      GROUP BY service, route, method, class`,
    [tenantId, new Date(startAt), new Date(endAt)],
  );
  return rows;
}

/** API requests of the tenant per UTC day in a range, as `{ day: 'YYYY-MM-DD', requests }`. */
export async function apiDailySums(tenantId, startAt, endAt) {
  const { rows } = await getPool().query(
    `SELECT to_char(minute AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            sum(request_count)::float8 AS requests
       FROM usage_signals.api_metric_minute
      WHERE tenant_id = $1 AND minute >= $2 AND minute < $3
      GROUP BY day`,
    [tenantId, new Date(startAt), new Date(endAt)],
  );
  return rows;
}
