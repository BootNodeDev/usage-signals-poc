// The writer of check 05: only what the experiment needs. It receives what the collector
// exports (OTLP/HTTP, JSON encoding), decides for every data point whether it can ever be
// stored, and adds the storable ones to usage_signals.api_metric_minute.
//
// Two kinds of failure are kept apart, because the collector retries a batch for ever:
// - a point that can never be stored is refused for good: the answer is 200 with
//   partialSuccess, or 400 when the body cannot be decoded, and the collector drops it;
// - storage that is unavailable now is answered 503, and the collector keeps the batch.
//
// Not implemented: quota, series cap, deduplication, re-bucketing, the timestamp window,
// tenant status and token revocation. See README.md.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.WRITER_PORT);
const SCRATCH = process.env.WRITER_SCRATCH;
const CAPTURE = path.join(SCRATCH, 'writer-capture.jsonl');
// run.mjs writes "503" here to make the writer answer as it would with PostgreSQL unavailable.
const MODE_FILE = path.join(SCRATCH, 'writer-mode');

const METRIC_NAME = 'http.server.request.duration';
// AGGREGATION_TEMPORALITY_DELTA in opentelemetry-proto.
const DELTA = 1;
// Upper bounds of api_metric_minute.bucket_counts in milliseconds; the last bucket is +Inf.
const BOUNDS_MS = [5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgreSQL text cannot hold a NUL, and no stored name has a use for control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;
// The primary key is a B-tree entry, which has a size limit; these keep a row well below it.
const MAX_BYTES = { service: 255, route: 1024, method: 32 };
const MAX_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

// SQLSTATE classes that say "not now": connection, resources, operator intervention,
// transaction rollback (deadlock, serialization) and system errors. Any other error on a
// single row is about that row and will be the same on every retry.
const TEMPORARY_CLASSES = ['08', '40', '53', '57', '58'];

const UPSERT = `
  INSERT INTO usage_signals.api_metric_minute AS m
    (tenant_id, minute, service, route, method, status_code,
     request_count, duration_sum_ms, bucket_counts)
  VALUES ($1, to_timestamp($2::bigint * 60), $3, $4, $5, $6, $7, $8, $9::bigint[])
  ON CONFLICT (tenant_id, minute, service, route, method, status_code) DO UPDATE SET
    request_count = m.request_count + EXCLUDED.request_count,
    duration_sum_ms = m.duration_sum_ms + EXCLUDED.duration_sum_ms,
    bucket_counts = ARRAY(
      SELECT pair.old + pair.new
      FROM unnest(m.bucket_counts, EXCLUDED.bucket_counts) WITH ORDINALITY AS pair(old, new, n)
      ORDER BY pair.n)`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
// An idle connection that breaks when PostgreSQL stops must not end the process.
pool.on('error', () => {});

function attributeValue(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return JSON.stringify(value);
}

/** The attributes as a map, and the keys that appear more than once. */
function readAttributes(list) {
  const map = {};
  const duplicated = [];
  for (const { key, value } of list ?? []) {
    if (Object.hasOwn(map, key)) duplicated.push(key);
    map[key] = attributeValue(value ?? {});
  }
  return { map, duplicated };
}

function boundsMatchLayout(explicitBounds) {
  if (explicitBounds?.length !== BOUNDS_MS.length) return false;
  return explicitBounds.every((seconds, i) => Math.abs(seconds * 1000 - BOUNDS_MS[i]) < 1e-6);
}

/** Why a name cannot be stored, or null. */
function nameRefusal(what, value) {
  if (typeof value !== 'string' || value.length === 0) return `no ${what}`;
  if (CONTROL.test(value)) return `control character in the ${what}`;
  if (Buffer.byteLength(value) > MAX_BYTES[what]) return `${what} too long`;
  return null;
}

/** An unsigned integer sent as a JSON string or number, or null when it is not one. */
function unsigned(value) {
  if (value === undefined) return 0n;
  try {
    const number = BigInt(value);
    return number >= 0n ? number : null;
  } catch {
    return null;
  }
}

/** Why nothing of a resource can be stored, or null. */
function resourceRefusal(resource, duplicated) {
  if (duplicated.length > 0) return `resource attribute sent more than once: ${duplicated[0]}`;
  if (typeof resource['tenant.id'] !== 'string') return 'no tenant.id';
  if (!UUID.test(resource['tenant.id'])) return 'tenant.id is not a UUID';
  return nameRefusal('service', resource['service.name'] ?? '(unknown)');
}

/** Why a metric as a whole cannot be stored, or null. */
function metricRefusal(metric) {
  if (!metric.histogram) return 'not a histogram';
  if (metric.name !== METRIC_NAME) return 'not the HTTP server duration metric';
  if (metric.unit !== 's') return 'unit is not seconds';
  if (metric.histogram.aggregationTemporality !== DELTA) return 'temporality is not delta';
  return null;
}

/** The numbers of a point in storable form, or the reason they cannot be stored. */
function readNumbers(point) {
  const count = unsigned(point.count);
  if (count === null || count > MAX_COUNT) return { reason: 'count is not a storable integer' };
  if (count === 0n) return { count: 0 };
  if (!boundsMatchLayout(point.explicitBounds)) {
    return { reason: 'bucket bounds differ from the layout' };
  }
  const buckets = (point.bucketCounts ?? []).map(unsigned);
  if (buckets.length !== BOUNDS_MS.length + 1 || buckets.includes(null)) {
    return { reason: 'bucket counts do not fit the layout' };
  }
  if (buckets.reduce((total, bucket) => total + bucket, 0n) !== count) {
    return { reason: 'bucket counts do not add up to the count' };
  }
  if (typeof point.sum !== 'number' || !Number.isFinite(point.sum) || point.sum < 0) {
    return { reason: 'sum is not a non-negative number' };
  }
  return { count: Number(count), bucketCounts: buckets.map(Number) };
}

/** Why a point cannot be stored, or null. */
function pointRefusal(point, attributes, duplicated, numbers) {
  if (duplicated.length > 0) return `attribute sent more than once: ${duplicated[0]}`;
  const status = attributes['http.response.status_code'];
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'no valid status code';
  if (unsigned(point.timeUnixNano) === null || point.timeUnixNano === undefined) {
    return 'no valid timestamp';
  }
  return (
    nameRefusal('route', attributes['http.route']) ??
    nameRefusal('method', attributes['http.request.method']) ??
    numbers.reason ??
    null
  );
}

/**
 * Splits one export request into points to store, zero-count points (valid, nothing to
 * store) and points refused for good, with the reason.
 */
function readRequest(body) {
  const result = { accepted: [], empty: [], refused: [] };
  if (!Array.isArray(body?.resourceMetrics)) throw new Error('resourceMetrics is not a list');
  for (const resourceMetrics of body.resourceMetrics) {
    const { map: resource, duplicated } = readAttributes(resourceMetrics.resource?.attributes);
    const resourceReason = resourceRefusal(resource, duplicated);
    const metrics = (resourceMetrics.scopeMetrics ?? []).flatMap((scope) => scope.metrics ?? []);
    for (const metric of metrics) {
      const base = {
        resource,
        metric: metric.name,
        unit: metric.unit,
        temporality: metric.histogram?.aggregationTemporality,
      };
      const metricReason = resourceReason ?? metricRefusal(metric);
      if (metricReason) {
        result.refused.push({ ...base, reason: metricReason });
        continue;
      }
      for (const point of metric.histogram.dataPoints ?? []) readPoint(point, base, result);
    }
  }
  return result;
}

function readPoint(point, base, result) {
  const { map: attributes, duplicated } = readAttributes(point.attributes);
  const numbers = readNumbers(point);
  const seen = {
    ...base,
    attributes,
    timeUnixNano: point.timeUnixNano,
    count: numbers.count ?? point.count,
    sum: point.sum,
    min: point.min,
    max: point.max,
    explicitBounds: point.explicitBounds,
    bucketCounts: numbers.bucketCounts ?? point.bucketCounts,
  };
  const reason = pointRefusal(point, attributes, duplicated, numbers);
  if (reason) result.refused.push({ ...seen, reason });
  else if (numbers.count === 0) result.empty.push(seen);
  else result.accepted.push(seen);
}

function rowOf(point) {
  const minute = BigInt(point.timeUnixNano) / 60_000_000_000n;
  return [
    point.resource['tenant.id'],
    minute.toString(),
    point.resource['service.name'] ?? '(unknown)',
    point.attributes['http.route'],
    point.attributes['http.request.method'],
    point.attributes['http.response.status_code'],
    point.count,
    point.sum * 1000,
    point.bucketCounts,
  ];
}

const KEY_COLUMNS = 6;
const keyOf = (point) => JSON.stringify(rowOf(point).slice(0, KEY_COLUMNS));
const isTemporary = (error) =>
  typeof error.code !== 'string' ||
  error.code.length !== 5 ||
  TEMPORARY_CLASSES.includes(error.code.slice(0, 2));

/**
 * Stores the points in one transaction and returns those PostgreSQL refused for good, such as
 * a tenant that is not enrolled. Throws when storage is unavailable.
 */
async function store(points) {
  // Rows are written in key order: two batches that touch the same rows in different orders
  // deadlock in PostgreSQL.
  const ordered = [...points].sort((a, b) =>
    keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
  );
  const refused = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const point of ordered) {
      await client.query('SAVEPOINT one_point');
      try {
        await client.query(UPSERT, rowOf(point));
      } catch (error) {
        if (isTemporary(error)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT one_point');
        refused.push({ ...point, reason: `refused by the database (SQLSTATE ${error.code})` });
      }
    }
    await client.query('COMMIT');
    return refused;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function capture(entry) {
  appendFileSync(CAPTURE, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function answer(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const currentMode = () => (existsSync(MODE_FILE) ? readFileSync(MODE_FILE, 'utf8').trim() : 'ok');

async function handle(request, response) {
  // Lets run.mjs wait until a change of the mode file is visible inside the container.
  if (request.method === 'GET' && request.url === '/mode') {
    return answer(response, 200, { mode: currentMode() });
  }
  if (request.method !== 'POST' || request.url !== '/v1/metrics') {
    capture({ outcome: 'unexpected-request', method: request.method, url: request.url });
    return answer(response, 404, {});
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (currentMode() === '503') {
    capture({ outcome: 'answered-503' });
    return answer(response, 503, { message: 'storage unavailable (forced by the experiment)' });
  }
  let parsed;
  try {
    parsed = readRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    capture({ outcome: 'undecodable', error: String(error) });
    return answer(response, 400, { message: 'undecodable body' });
  }
  let refusedByDatabase;
  try {
    refusedByDatabase = await store(parsed.accepted);
  } catch (error) {
    capture({ outcome: 'storage-error', error: String(error), code: error.code });
    return answer(response, 503, { message: 'storage unavailable' });
  }
  const refused = [...parsed.refused, ...refusedByDatabase];
  const accepted = parsed.accepted.filter(
    (point) => !refusedByDatabase.some((item) => keyOf(item) === keyOf(point)),
  );
  // Written after the commit, so a captured accepted point is a stored point.
  capture({ outcome: 'stored', accepted, empty: parsed.empty, refused });
  const partialSuccess =
    refused.length > 0
      ? { rejectedDataPoints: String(refused.length), errorMessage: refused[0].reason }
      : undefined;
  return answer(response, 200, { partialSuccess });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    capture({ outcome: 'writer-bug', error: String(error) });
    answer(response, 500, { message: 'writer error' });
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`writer listening on ${PORT}`));
process.on('SIGTERM', () => {
  server.close(() => pool.end().then(() => process.exit(0)));
  server.closeAllConnections();
});
