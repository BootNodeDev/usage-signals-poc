// Stores the points of one export request: their de-duplication keys, their counts in
// api_metric_minute and the refusals, in one transaction, as the check 5 writer does
// (`checks/check-05/writer.mjs`). Every writer takes locks in the same order (keys, then rows,
// then refusal counters) and in key order, so two requests cannot deadlock.
import { createHash } from 'node:crypto';
import { withTransaction } from './db.js';
import { dateOf } from './otlp-metrics.js';

const DAY_MS = 86_400_000;
// SQLSTATE classes that say "not now": connection, resources, operator intervention,
// transaction rollback and system errors. Any other error on one row is about that row.
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

// A key that exists, or that another transaction inserts and commits, is not returned.
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

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest();
const columnsOf = (points) => [points.map((point) => point.day), points.map((point) => point.key)];

function rowOf(point) {
  return [
    point.resource['tenant.id'],
    (BigInt(point.timeUnixNano) / 60_000_000_000n).toString(),
    point.resource['service.name'] ?? '(unknown)',
    point.attributes['http.route'],
    point.attributes['http.request.method'],
    point.attributes['http.response.status_code'],
    point.count,
    point.sum * 1000,
    point.bucketCounts,
  ];
}

const rowKey = (point) => JSON.stringify(rowOf(point).slice(0, 6));

function isTemporary(error) {
  if (typeof error.code !== 'string' || error.code.length !== 5) return true;
  return TEMPORARY_CLASSES.includes(error.code.slice(0, 2));
}

/**
 * One entry per key. Exact copies inside a request count once; points of one request that
 * share a key with other numbers are added together, as the collector's merge adds them.
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

/** Inserts the keys and splits the points into fresh ones, redeliveries and collisions. */
async function claim(client, points) {
  const { groups, copies } = groupByKey(points);
  if (groups.length === 0) return { fresh: [], duplicates: [], collisions: [] };
  const numbers = groups.map((group) => group.numbers);
  const inserted = await client.query(INSERT_KEYS, [...columnsOf(groups), numbers]);
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

/** Adds the points to their rows; returns the points PostgreSQL refused for good. */
async function addCounts(client, points) {
  const ordered = [...points].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : 1));
  const refused = [];
  const notCounted = new Set();
  for (const point of ordered) {
    await client.query('SAVEPOINT one_point');
    try {
      await client.query(UPSERT, rowOf(point));
    } catch (error) {
      if (isTemporary(error)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT one_point');
      notCounted.add(point);
      refused.push({ ...point, reason: `refused by the database (SQLSTATE ${error.code})` });
    }
  }
  // A key stays while any point of its group was counted, so a redelivery is still caught.
  const counted = new Set(points.filter((point) => !notCounted.has(point)).map((p) => p.key));
  const orphans = refused.filter((point) => !counted.has(point.key));
  if (orphans.length > 0) await client.query(FORGET_KEYS, columnsOf(orphans));
  return refused;
}

/** One counter per project and reason; the text after a colon names a client's key. */
async function countRefusals(client, refused) {
  const totals = new Map();
  for (const item of refused) {
    const group = `${item.resource['tenant.id']}|${item.reason.split(':')[0]}`;
    totals.set(group, (totals.get(group) ?? 0) + 1);
  }
  const day = dateOf(Math.floor(Date.now() / DAY_MS));
  for (const group of [...totals.keys()].sort()) {
    const [tenant, reason] = group.split('|');
    await client.query(COUNT_REFUSAL, [tenant, day, reason, totals.get(group)]);
  }
}

/**
 * Stores what `readRequest` accepted and counts what it and the database refused. Returns
 * `{ accepted, duplicates, refused }`; throws when storage is unavailable, so the client
 * retries the whole request.
 */
export function storePoints(points, refusedBefore) {
  return withTransaction(async (client) => {
    const { fresh, duplicates, collisions } = await claim(client, points);
    const refusedByDatabase = await addCounts(client, fresh);
    const refused = [...refusedBefore, ...collisions, ...refusedByDatabase];
    await countRefusals(client, refused);
    const refusedKeys = new Set(refusedByDatabase.map((point) => point.key));
    const accepted = fresh.filter((point) => !refusedKeys.has(point.key));
    return { accepted, duplicates, refused };
  });
}
