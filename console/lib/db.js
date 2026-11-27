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
 * distinct User-Agents it has shown today, this one included, counting no higher than `upTo`.
 * Once an address reaches `upTo`, no more rows are kept for it that day. Only hashes are stored.
 */
export async function countAgentsToday(address, userAgent, upTo) {
  // The final SELECT reads the table as it was before the INSERT, so the new row is added apart.
  const { rows } = await getPool().query(
    `WITH today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS day),
     expired AS (
       DELETE FROM usage_signals.agent_sighting
        WHERE (day, address_hash, agent_hash) IN (
          -- SKIP LOCKED: requests running at once clear different old rows instead of waiting.
          SELECT day, address_hash, agent_hash FROM usage_signals.agent_sighting
           WHERE day < (SELECT day FROM today)
           LIMIT 500 FOR UPDATE SKIP LOCKED)
     ),
     seen AS (
       SELECT count(*)::int AS agents
         FROM (SELECT 1 FROM usage_signals.agent_sighting
                WHERE day = (SELECT day FROM today) AND address_hash = $1
                LIMIT $3) capped
     ),
     added AS (
       INSERT INTO usage_signals.agent_sighting (day, address_hash, agent_hash)
       SELECT day, $1, $2 FROM today WHERE (SELECT agents FROM seen) < $3
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT agents FROM seen) + (SELECT count(*)::int FROM added) AS agents`,
    [sha256(address), sha256(userAgent), upTo],
  );
  return rows[0].agents;
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

const TOKEN_COLUMNS = `t.token_prefix AS prefix, s.slug AS project, t.created_at, t.expires_at,
  t.revoked_at`;
// The first site of a tenant names the project a token belongs to.
const TOKEN_PROJECT = `LEFT JOIN LATERAL (
    SELECT slug FROM usage_signals.site
     WHERE tenant_id = t.tenant_id ORDER BY created_at, id LIMIT 1
  ) s ON true`;

/** Stores an ingest token's hash. Returns the listed token. */
export async function insertIngestToken({ tenantId, prefix, hash, days }) {
  const { rows } = await getPool().query(
    `WITH t AS (
       INSERT INTO usage_signals.ingest_token (tenant_id, token_prefix, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))
       RETURNING *
     )
     SELECT ${TOKEN_COLUMNS} FROM t ${TOKEN_PROJECT}`,
    [tenantId, prefix, hash, days],
  );
  return rows[0];
}

/** Every ingest token, oldest first, without its hash. */
export async function listIngestTokens() {
  const { rows } = await getPool().query(
    `SELECT ${TOKEN_COLUMNS} FROM usage_signals.ingest_token t ${TOKEN_PROJECT}
      ORDER BY t.created_at, t.token_prefix`,
  );
  return rows;
}

/** Revokes the token with this prefix: `'revoked'`, `'already revoked'` or `'not found'`. */
export async function revokeIngestToken(prefix) {
  const { rows } = await getPool().query(
    `WITH found AS (
       SELECT id FROM usage_signals.ingest_token WHERE token_prefix = $1
     ), changed AS (
       UPDATE usage_signals.ingest_token SET revoked_at = now()
        WHERE id IN (SELECT id FROM found) AND revoked_at IS NULL
        RETURNING id
     )
     SELECT (SELECT count(*) FROM found)::int AS found,
            (SELECT count(*) FROM changed)::int AS changed`,
    [prefix],
  );
  const { found, changed } = rows[0];
  if (found === 0) return 'not found';
  return changed > 0 ? 'revoked' : 'already revoked';
}

/** The tenant of a valid token with this hash, if the tenant is active; else null. */
export async function tenantOfIngestToken(hash) {
  const { rows } = await getPool().query(
    `SELECT i.tenant_id AS "tenantId"
       FROM usage_signals.ingest_token i
       JOIN usage_signals.tenant t ON t.id = i.tenant_id
      WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.expires_at > now()
        AND t.status = 'active'`,
    [hash],
  );
  return rows[0] ?? null;
}

/** Ends the pool so a command-line script can exit. */
export async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}

/**
 * Runs `task(client)` in a transaction on one connection: COMMIT when it returns, ROLLBACK
 * when it throws. A connection that broke during the task is discarded, not reused.
 */
export async function withTransaction(task) {
  const client = await getPool().connect();
  let broken = false;
  const noteBroken = () => {
    broken = true;
  };
  client.on('error', noteBroken);
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.off('error', noteBroken);
    client.release(broken);
  }
}

/** Deletes the API de-duplication keys of days before `cutoff` (a YYYY-MM-DD date). */
export async function purgeApiPointKeys(cutoff) {
  const result = await getPool().query(
    'DELETE FROM usage_signals.api_point_key WHERE point_day < $1',
    [cutoff],
  );
  return result.rowCount;
}
