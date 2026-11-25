// The writer of check 05: only what the experiment needs. It receives what the collector
// exports (OTLP/HTTP, JSON encoding), decides for every data point whether it can ever be
// stored, and adds the storable ones to usage_signals.api_metric_minute.
//
// Two kinds of failure are kept apart, because the collector retries a batch for ever:
// - a point that can never be stored is refused for good: the answer is 200 with
//   partialSuccess, or 400 when the body cannot be decoded, and the collector drops it;
// - storage that is unavailable now is answered 503, and the collector keeps the batch.
//
// Delivery to this writer is at least once, so every point is counted under a key made of
// its identity: the key and the counts are written in one transaction, and a point whose key
// exists is a redelivery and adds nothing.
//
// Not implemented: quota, series cap, re-bucketing, the timestamp window against the time of
// receipt, tenant status and token revocation. See README.md.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.WRITER_PORT);
const SCRATCH = process.env.WRITER_SCRATCH;
const CAPTURE = path.join(SCRATCH, process.env.WRITER_CAPTURE ?? 'writer-capture.jsonl');
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
// The bound the collector's last two path rules give every segment. The writer checks it
// again, so that a mistake at the edge stores nothing.
const SEGMENT = /^[ -~]{0,36}$/;
const MAX_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const DAY_MS = 86_400_000;
// The last instant a PostgreSQL date and a JavaScript Date both hold comfortably.
const MAX_TIME_MS = Date.UTC(9999, 11, 31);

// Keys are kept for KEY_DAYS whole UTC days behind today, and a point older than that is
// refused: its key may be gone, so it could not be told from a redelivery. The collector's
// disk queue is sized for 7 days, hence 8. The other three values exist for the experiment:
// run.mjs moves the clock, switches the age check off to show the design as first written,
// and makes an acknowledgement fail after the commit.
const settings = { keyDays: 8, refuseOlderThanKeys: true, clockOffsetDays: 0, ackFault: 'none' };
const today = () => Math.floor(Date.now() / DAY_MS) + settings.clockOffsetDays;
const dateOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

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

// Unknown keys are inserted and returned; a key that exists, or that another transaction is
// inserting and then commits, is left alone and not returned. The caller passes the keys
// sorted, and every writer sorts alike, so two batches cannot wait for each other.
const INSERT_KEYS = `
  INSERT INTO usage_signals.api_point_key (point_day, key, numbers)
  SELECT k.day, k.key, k.numbers
  FROM unnest($1::date[], $2::uuid[], $3::integer[]) WITH ORDINALITY AS k(day, key, numbers, n)
  ORDER BY k.n
  ON CONFLICT (point_day, key) DO NOTHING
  RETURNING key`;

const KNOWN_NUMBERS = `
  SELECT key, numbers FROM usage_signals.api_point_key
  WHERE (point_day, key) IN (SELECT * FROM unnest($1::date[], $2::uuid[]))`;

const FORGET_KEYS = `
  DELETE FROM usage_signals.api_point_key
  WHERE (point_day, key) IN (SELECT * FROM unnest($1::date[], $2::uuid[]))`;

const COUNT_REFUSAL = `
  INSERT INTO usage_signals.api_refusal AS r (tenant_id, day, reason, points)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (tenant_id, day, reason) DO UPDATE SET points = r.points + EXCLUDED.points`;

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
  const time = point.timeUnixNano === undefined ? null : unsigned(point.timeUnixNano);
  if (time === null || time / 1_000_000n > BigInt(MAX_TIME_MS)) return 'no valid timestamp';
  if (unsigned(point.startTimeUnixNano) === null) return 'no valid start timestamp';
  return (
    nameRefusal('route', attributes['http.route']) ??
    segmentRefusal(attributes['http.route']) ??
    nameRefusal('method', attributes['http.request.method']) ??
    numbers.reason ??
    ageRefusal(time)
  );
}

const segmentRefusal = (route) =>
  route.split('/').every((segment) => SEGMENT.test(segment))
    ? null
    : 'route with a segment outside the bound';

const dayOf = (timeUnixNano) => Number(BigInt(timeUnixNano) / 1_000_000n / BigInt(DAY_MS));

/** A point older than the keys that are kept cannot be told from a redelivery. */
function ageRefusal(timeUnixNano) {
  if (!settings.refuseOlderThanKeys) return null;
  return dayOf(timeUnixNano) < today() - settings.keyDays
    ? 'older than the de-duplication keys that are kept'
    : null;
}

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest();

/**
 * The key of a point: what identifies it in the metrics data model (the stream, which is the
 * resource, the metric and the attributes, with StartTimeUnixNano and TimeUnixNano). The time
 * of receipt is not part of it, so a retry by the tenant's SDK has the same key.
 */
function identify(point) {
  const hex = hashOf([
    point.resource['tenant.id'].toLowerCase(),
    point.resource['service.name'] ?? '(unknown)',
    point.resource['service.instance.id'] ?? '',
    point.attributes['http.route'],
    point.attributes['http.request.method'],
    point.attributes['http.response.status_code'],
    String(point.startTimeUnixNano ?? '0'),
    String(point.timeUnixNano),
  ]).toString('hex');
  const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const numbers = hashOf([point.count, point.sum, point.min, point.max, point.bucketCounts]);
  return { key, day: dateOf(dayOf(point.timeUnixNano)), numbers: numbers.readInt32BE(0) };
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
    startTimeUnixNano: point.startTimeUnixNano,
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
  else result.accepted.push({ ...seen, ...identify(seen) });
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

const columnsOf = (points) => [points.map((point) => point.day), points.map((point) => point.key)];

/**
 * One entry per key of a request. Exact copies inside the request count once. Points of one
 * request that share a key with other numbers are kept together and added, as the edge's
 * merge adds them; the entry's numbers then stand for the whole group.
 */
function groupByKey(points) {
  const groups = new Map();
  const copies = [];
  for (const point of points) {
    const group = groups.get(point.key) ?? { key: point.key, day: point.day, members: [] };
    groups.set(point.key, group);
    if (group.members.some((member) => member.numbers === point.numbers)) copies.push(point);
    else group.members.push(point);
  }
  for (const group of groups.values()) {
    const all = group.members.map((member) => member.numbers).sort((a, b) => a - b);
    group.numbers = all.length === 1 ? all[0] : hashOf(all).readInt32BE(0);
  }
  const sorted = [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  return { groups: sorted, copies };
}

/**
 * Inserts the keys of the points and splits them: points to count, redeliveries and copies,
 * and points that carry the identity of a counted point with other numbers, which no
 * redelivery does.
 */
async function claim(client, points) {
  const { groups, copies } = groupByKey(points);
  if (groups.length === 0) return { fresh: [], duplicates: [], collisions: [] };
  const inserted = await client.query(INSERT_KEYS, [
    ...columnsOf(groups),
    groups.map((group) => group.numbers),
  ]);
  const freshKeys = new Set(inserted.rows.map((row) => row.key));
  const membersOf = (list) => list.flatMap((group) => group.members);
  const fresh = membersOf(groups.filter((group) => freshKeys.has(group.key)));
  const seenBefore = groups.filter((group) => !freshKeys.has(group.key));
  if (seenBefore.length === 0) return { fresh, duplicates: copies, collisions: [] };
  const known = await client.query(KNOWN_NUMBERS, columnsOf(seenBefore));
  const numbersOf = new Map(known.rows.map((row) => [row.key, row.numbers]));
  const same = (group) => numbersOf.get(group.key) === group.numbers;
  const reason = 'same identity as a counted point, other numbers';
  return {
    fresh,
    duplicates: [...copies, ...membersOf(seenBefore.filter(same))],
    collisions: membersOf(seenBefore.filter((group) => !same(group))).map((point) => ({
      ...point,
      reason,
    })),
  };
}

/** Adds the points to their rows and returns the points PostgreSQL refused for good. */
async function addCounts(client, points) {
  // Rows are written in key order: two batches that touch the same rows in different orders
  // deadlock in PostgreSQL.
  const ordered = [...points].sort((a, b) =>
    keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
  );
  const refused = [];
  for (const point of ordered) {
    await client.query('SAVEPOINT one_point');
    try {
      await client.query(UPSERT, rowOf(point));
    } catch (error) {
      if (isTemporary(error)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT one_point');
      refused.push(point);
      point.reason = `refused by the database (SQLSTATE ${error.code})`;
    }
  }
  // A point that was not counted must not leave a key behind.
  const counted = new Set(points.filter((point) => !refused.includes(point)).map((p) => p.key));
  const orphans = refused.filter((point) => !counted.has(point.key));
  if (orphans.length > 0) await client.query(FORGET_KEYS, columnsOf(orphans));
  return refused;
}

/** One row per tenant and reason, for the tenant's setup page. */
async function countRefusals(client, refused) {
  const totals = new Map();
  for (const item of refused) {
    const tenant = item.resource?.['tenant.id'];
    if (typeof tenant !== 'string' || !UUID.test(tenant)) continue;
    // The text after a colon names a tenant-chosen key; the reason is stored without it.
    const group = `${tenant.toLowerCase()}|${item.reason.split(':')[0]}`;
    totals.set(group, (totals.get(group) ?? 0) + 1);
  }
  for (const group of [...totals.keys()].sort()) {
    const [tenant, reason] = group.split('|');
    await client.query(COUNT_REFUSAL, [tenant, dateOf(today()), reason, totals.get(group)]);
  }
}

/**
 * Writes keys, counts and refusals in one transaction. Throws when storage is unavailable.
 * Locks are taken in one order by every writer: keys, then rows, then refusal counters.
 */
async function store(points, refusedBefore) {
  const client = await pool.connect();
  // A connection that ends while in use reports it as an event too, and an event without a
  // listener ends the process.
  let broken = false;
  const noteBroken = () => {
    broken = true;
  };
  client.on('error', noteBroken);
  try {
    await client.query('BEGIN');
    const { fresh, duplicates, collisions } = await claim(client, points);
    const refusedByDatabase = await addCounts(client, fresh);
    const refused = [...refusedBefore, ...collisions, ...refusedByDatabase];
    await countRefusals(client, refused);
    await client.query('COMMIT');
    const accepted = fresh.filter((point) => !refusedByDatabase.includes(point));
    return { accepted, duplicates, refused };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.off('error', noteBroken);
    client.release(broken);
  }
}

/** Deletes keys older than the points the writer still accepts, with one day to spare. */
async function purgeKeys() {
  const cutoff = dateOf(today() - settings.keyDays - 1);
  const result = await pool.query(
    'DELETE FROM usage_signals.api_point_key WHERE point_day < $1',
    [cutoff],
  );
  return { cutoff, deleted: result.rowCount };
}

function capture(entry) {
  appendFileSync(CAPTURE, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function answer(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const currentMode = () => (existsSync(MODE_FILE) ? readFileSync(MODE_FILE, 'utf8').trim() : 'ok');

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** The experiment's controls. The document's writer has none of them. */
async function experiment(request, response) {
  if (request.url === '/experiment/purge') return answer(response, 200, await purgeKeys());
  if (request.method === 'POST') Object.assign(settings, JSON.parse(await readBody(request)));
  return answer(response, 200, settings);
}

async function handle(request, response) {
  // Lets run.mjs wait until a change of the mode file is visible inside the container.
  if (request.method === 'GET' && request.url === '/mode') {
    return answer(response, 200, { mode: currentMode() });
  }
  if (request.url.startsWith('/experiment')) return experiment(request, response);
  if (request.method !== 'POST' || request.url !== '/v1/metrics') {
    capture({ outcome: 'unexpected-request', method: request.method, url: request.url });
    return answer(response, 404, {});
  }
  const body = await readBody(request);
  if (currentMode() === '503') {
    capture({ outcome: 'answered-503' });
    return answer(response, 503, { message: 'storage unavailable (forced by the experiment)' });
  }
  let parsed;
  try {
    parsed = readRequest(JSON.parse(body));
  } catch (error) {
    capture({ outcome: 'undecodable', error: String(error) });
    return answer(response, 400, { message: 'undecodable body' });
  }
  let stored;
  try {
    stored = await store(parsed.accepted, parsed.refused);
  } catch (error) {
    capture({ outcome: 'storage-error', error: String(error), code: error.code });
    return answer(response, 503, { message: 'storage unavailable' });
  }
  const { refused } = stored;
  // Written after the commit, so a captured accepted point is a stored point.
  capture({ outcome: 'stored', ...stored, empty: parsed.empty });
  if (settings.ackFault === 'lose-once') {
    // The commit happened and the collector never learns of it.
    settings.ackFault = 'none';
    return response.destroy();
  }
  if (settings.ackFault === 'hold') {
    // The commit happened and the answer waits: the collector can be killed meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
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
