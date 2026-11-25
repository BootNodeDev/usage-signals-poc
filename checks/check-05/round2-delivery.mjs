// Round two of check 05, delivery: the Builder build (C), de-duplication in the writer (A) and
// the lifetime of its keys (B).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HERE,
  WRITER,
  WRITER_2,
  capture,
  captureLength,
  captureOfWriter2,
  clearKeys,
  clearRows,
  collectorIsBack,
  compose,
  composeInBackground,
  edgeName,
  edgeSelfReport,
  post,
  purgeKeys,
  record,
  runTag,
  settle,
  simpleBody,
  sql,
  storedRows,
  waitFor,
  writerSaw,
  writerSettings,
} from './harness.mjs';
import { seededRandom } from './lib.mjs';

const sum = (values) => values.reduce((total, value) => total + value, 0);
const requestsOf = (service) => sum(storedRows(service).map((row) => row.request_count));
const countOf = (table) => Number(sql(`SELECT count(*) FROM usage_signals.${table}`).trim());
const direct = (body, base = WRITER) => post('/v1/metrics', body, { base });
const DEFAULTS = { keyDays: 8, refuseOlderThanKeys: true, clockOffsetDays: 0, ackFault: 'none' };
const COLLISION = 'same identity as a counted point, other numbers';
const TOO_OLD = 'older than the de-duplication keys that are kept';

/** Points the writer refused for a tenant and reason, as counted in api_refusal. */
const refusedFor = (tenant, reason) =>
  Number(
    sql(
      `SELECT coalesce(sum(points), 0) FROM usage_signals.api_refusal
       WHERE tenant_id = '${tenant}' AND reason = '${reason}'`,
    ).trim(),
  );

// ---------------------------------------------------------------- C. the Builder build

const modulesIn = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]).sort();

async function builderBuild() {
  const manifest = readFileSync(path.join(HERE, 'builder-manifest.yaml'), 'utf8');
  const listed = modulesIn(manifest, /^ {2}- gomod: (\S+ \S+)$/gm);
  const report = edgeSelfReport();
  const built = modulesIn(report.components, /^ +module: (\S+ \S+)$/gm);
  record(
    'C',
    'required',
    'the collector under test is the Builder build of builder-manifest.yaml',
    `builder: usage-signals-edge version 0.165.0, ${listed.length} modules as in the manifest`,
    `${edgeName}: ${report.version}, ${built.length} modules${built.join() === listed.join() ? ' as in the manifest' : ''}`,
    edgeName === 'builder' &&
      report.version === 'usage-signals-edge version 0.165.0' &&
      built.join() === listed.join(),
  );
}

// ---------------------------------------------------------------- A. one point, one count

/** How often a service's points reached the writer, and what it made of them. */
function deliveries(service, from) {
  const seen = writerSaw(service, from);
  return { ...seen, times: seen.accepted.length + seen.duplicates.length + seen.refused.length };
}

async function lostAcknowledgement({ tokenA, BASE_MS }) {
  const service = `dedup-lost-ack-${runTag}`;
  const from = captureLength();
  await writerSettings({ ackFault: 'lose-once' });
  const body = simpleBody(service, { count: 7, timeMs: BASE_MS });
  const answer = await post('/v1/metrics', body, { token: tokenA });
  await waitFor('the redelivery', () => deliveries(service, from).times >= 2, 30_000).catch(
    () => {},
  );
  await settle(tokenA);
  const seen = deliveries(service, from);
  record(
    'A',
    'required',
    'the writer commits and its answer is lost: the collector delivers the batch again',
    'HTTP 200 to the tenant; delivered 2 times; 7 of 7 requests stored',
    `HTTP ${answer.status} to the tenant; delivered ${seen.times} times; ${requestsOf(service)} of 7 requests stored`,
    answer.status === 200 && seen.duplicates.length === 1 && requestsOf(service) === 7,
  );
}

/** Sends through the collector, lets the writer commit and kills the collector before the answer. */
async function commitThenKillCollector(service, body, token) {
  const from = captureLength();
  await writerSettings({ ackFault: 'hold' });
  const answer = await post('/v1/metrics', body, { token });
  await waitFor('the first delivery', () => deliveries(service, from).times >= 1);
  compose('kill', 'collector');
  await writerSettings({ ackFault: 'none' });
  return { from, status: answer.status };
}

async function restartCollectorAndWait(service, from) {
  compose('start', 'collector');
  await collectorIsBack();
  await waitFor('the redelivery', () => deliveries(service, from).times >= 2, 60_000).catch(
    () => {},
  );
}

async function killedInFlight({ tokenA, BASE_MS }) {
  const service = `dedup-killed-${runTag}`;
  const body = simpleBody(service, { count: 9, timeMs: BASE_MS });
  const { from, status } = await commitThenKillCollector(service, body, tokenA);
  await restartCollectorAndWait(service, from);
  await settle(tokenA);
  const seen = deliveries(service, from);
  record(
    'A',
    'required',
    'the collector is killed after the commit and before the answer, and started again',
    'HTTP 200 to the tenant; delivered 2 times; 9 of 9 requests stored',
    `HTTP ${status} to the tenant; delivered ${seen.times} times; ${requestsOf(service)} of 9 requests stored`,
    status === 200 && seen.duplicates.length === 1 && requestsOf(service) === 9,
  );
}

async function sdkRetry({ tokenA, BASE_MS }) {
  const service = `dedup-sdk-retry-${runTag}`;
  const from = captureLength();
  const body = simpleBody(service, { count: 5, timeMs: BASE_MS });
  for (let i = 0; i < 3; i += 1) await post('/v1/metrics', body, { token: tokenA });
  await settle(tokenA);
  const seen = deliveries(service, from);
  const receipts = new Set(
    [...seen.accepted, ...seen.duplicates].map(
      (point) => point.resource['usage_signals.received_at_unix_nano'],
    ),
  );
  record(
    'A',
    'required',
    "the tenant's exporter sends one export 3 times (a retry: same interval, new time of receipt)",
    '3 times of receipt at the writer; 5 of 5 requests stored',
    `${receipts.size} times of receipt at the writer; ${requestsOf(service)} of 5 requests stored`,
    receipts.size === 3 && seen.duplicates.length === 2 && requestsOf(service) === 5,
  );
}

const pointsOf = (body) => body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;

const RACE_ROUNDS = 40;
const RACE_ROUTES = 6;

/** One batch of the race: the same points in two orders, for writers that take locks in turn. */
function raceBatch(service, tenant, round, random, baseMs) {
  const counts = Array.from({ length: RACE_ROUTES }, () => 1 + Math.floor(random() * 9));
  const timeMs = baseMs + round * 1000;
  const body = simpleBody(service, { timeMs, resource: { 'tenant.id': tenant } });
  const points = counts.flatMap((count, i) =>
    pointsOf(simpleBody(service, { count, route: `/race/${i}`, timeMs })),
  );
  const withPoints = (list) => {
    const copy = structuredClone(body);
    copy.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints = list;
    return copy;
  };
  return { counts, forward: withPoints(points), backward: withPoints([...points].reverse()) };
}

async function race({ TENANT_A, BASE_MS }) {
  clearRows();
  const service = `dedup-race-${runTag}`;
  const random = seededRandom(24);
  const from = [captureLength(), captureOfWriter2().length];
  const expected = new Map();
  const statuses = [];
  for (let round = 0; round < RACE_ROUNDS; round += 1) {
    const batch = raceBatch(service, TENANT_A, round, random, BASE_MS);
    const minute = Math.floor((BASE_MS + round * 1000) / 60_000);
    batch.counts.forEach((count, i) => {
      const row = `/race/${i}|${minute}`;
      expected.set(row, (expected.get(row) ?? 0) + count);
    });
    const answers = await Promise.all([
      direct(batch.forward, WRITER),
      direct(batch.backward, WRITER_2),
      direct(batch.backward, WRITER),
      direct(batch.forward, WRITER_2),
    ]);
    statuses.push(...answers.map((answer) => answer.status));
  }
  const rows = storedRows(service);
  const rowsRight =
    rows.length === expected.size &&
    rows.every((row) => expected.get(`${row.route}|${row.minute}`) === row.request_count);
  const entries = [capture(from[0]), captureOfWriter2().slice(from[1])];
  const total = (list, field) => sum(list.map((entry) => entry[field]?.length ?? 0));
  const accepted = entries.map((list) => total(list, 'accepted'));
  const duplicates = sum(entries.map((list) => total(list, 'duplicates')));
  const points = RACE_ROUNDS * RACE_ROUTES;
  const want = sum([...expected.values()]);
  record(
    'A',
    'required',
    `${RACE_ROUNDS} batches of ${RACE_ROUTES} points, each sent at the same moment twice to each of two writers`,
    `${RACE_ROUNDS * 4} answers HTTP 200; ${points} points counted, ${points * 3} skipped; ${want} of ${want} requests stored, every row exact`,
    `${statuses.filter((status) => status === 200).length} answers HTTP 200; ${sum(accepted)} points counted, ${duplicates} skipped; ${requestsOf(service)} of ${want} requests stored, ${rowsRight ? 'every row exact' : 'rows differ'}`,
    statuses.every((status) => status === 200) &&
      sum(accepted) === points &&
      duplicates === points * 3 &&
      rowsRight,
  );
  console.log(
    `  race: writer 1 counted ${accepted[0]} points first, writer 2 counted ${accepted[1]}`,
  );
}

// The collector's queue has several consumers, so two requests can reach the writer in either
// order: where one of two points is refused, either may be the one that is counted.
const REPLICA_CASES = [
  {
    name: 'two replicas with different instance IDs, same interval, same numbers: both count',
    kind: 'required',
    sends: [
      { instance: 'replica-1', count: 4 },
      { instance: 'replica-2', count: 4 },
    ],
    stored: [8],
    refused: 0,
  },
  {
    name: 'two replicas sharing an instance ID, intervals one millisecond apart: both count',
    kind: 'finding',
    sends: [
      { instance: 'shared', count: 4 },
      { instance: 'shared', count: 6, laterMs: 1 },
    ],
    stored: [10],
    refused: 0,
  },
  {
    name: 'two replicas sharing an instance ID, same interval to the nanosecond, other numbers: one is counted, the other refused and recorded',
    kind: 'finding',
    sends: [
      { instance: 'shared', count: 4 },
      { instance: 'shared', count: 6 },
    ],
    stored: [4, 6],
    refused: 1,
  },
  {
    name: 'two replicas sharing an instance ID, same interval to the nanosecond, same numbers: the second is taken for a redelivery',
    kind: 'finding',
    sends: [
      { instance: 'shared', count: 4 },
      { instance: 'shared', count: 4 },
    ],
    stored: [4],
    refused: 0,
  },
  {
    name: 'two replicas without an instance ID, same interval to the nanosecond, other numbers: one is counted, the other refused and recorded',
    kind: 'finding',
    sends: [{ count: 4 }, { count: 6 }],
    stored: [4, 6],
    refused: 1,
  },
  {
    name: 'two raw paths that the rules make one route, same interval, sent in two requests: one is counted, the other refused and recorded',
    kind: 'finding',
    sends: [
      { instance: 'one', count: 3, route: '/users/1' },
      { instance: 'one', count: 5, route: '/users/2' },
    ],
    stored: [3, 5],
    refused: 1,
  },
];

async function replicas({ tokenA, TENANT_A, BASE_MS }) {
  for (const [i, item] of REPLICA_CASES.entries()) {
    const service = `dedup-replica-${runTag}-${i}`;
    const before = refusedFor(TENANT_A, COLLISION);
    const statuses = [];
    for (const send of item.sends) {
      const body = simpleBody(service, {
        count: send.count,
        route: send.route ?? '/replica',
        timeMs: BASE_MS + (send.laterMs ?? 0),
        resource: send.instance ? { 'service.instance.id': send.instance } : {},
      });
      statuses.push((await post('/v1/metrics', body, { token: tokenA })).status);
    }
    await settle(tokenA);
    const refused = refusedFor(TENANT_A, COLLISION) - before;
    const sent = sum(item.sends.map((send) => send.count));
    record(
      'A',
      item.kind,
      item.name,
      `HTTP 200,200; ${item.stored.join(' or ')} of ${sent} requests stored; ${item.refused} refusal recorded`,
      `HTTP ${statuses.join()}; ${requestsOf(service)} of ${sent} requests stored; ${refused} refusal recorded`,
      statuses.join() === '200,200' && item.stored.includes(requestsOf(service)) && refused === item.refused,
    );
  }
}

async function oneRequestTwoPaths({ tokenA, BASE_MS }) {
  const service = `dedup-one-request-${runTag}`;
  const body = simpleBody(service, { count: 3, route: '/users/1', timeMs: BASE_MS });
  const second = simpleBody(service, { count: 5, route: '/users/2', timeMs: BASE_MS });
  pointsOf(body).push(...pointsOf(second));
  await post('/v1/metrics', body, { token: tokenA });
  await settle(tokenA);
  record(
    'A',
    'required',
    'two raw paths that the rules make one route, same interval, in one request: merged at the edge, all counted',
    '8 of 8 requests stored',
    `${requestsOf(service)} of 8 requests stored`,
    requestsOf(service) === 8,
  );
}

/**
 * Overlap inside one request. An exact copy in a block of its own counts once. Two blocks with one identity and
 * other numbers are added, and the whole request delivered again adds nothing and records
 * nothing.
 */
async function overlapInOneRequest({ tokenA, TENANT_A, BASE_MS }) {
  const twice = `dedup-copy-${runTag}`;
  const copy = simpleBody(twice, { count: 4, timeMs: BASE_MS });
  pointsOf(copy).push(structuredClone(pointsOf(copy)[0]));
  await post('/v1/metrics', copy, { token: tokenA });
  const apart = `dedup-copy-blocks-${runTag}`;
  const copies = simpleBody(apart, { count: 4, timeMs: BASE_MS });
  copies.resourceMetrics.push(structuredClone(copies.resourceMetrics[0]));
  await post('/v1/metrics', copies, { token: tokenA });

  const blocks = `dedup-blocks-${runTag}`;
  const resource = { 'service.instance.id': 'shared' };
  const two = simpleBody(blocks, { count: 4, timeMs: BASE_MS, resource });
  two.resourceMetrics.push(
    simpleBody(blocks, { count: 6, timeMs: BASE_MS, resource }).resourceMetrics[0],
  );
  const before = refusedFor(TENANT_A, COLLISION);
  await post('/v1/metrics', two, { token: tokenA });
  await settle(tokenA);
  const first = requestsOf(blocks);
  await post('/v1/metrics', two, { token: tokenA });
  await settle(tokenA);
  record(
    'A',
    'required',
    'one block of 4 requests written twice in one request: counted once by the writer',
    '4 requests stored',
    `${requestsOf(apart)} requests stored`,
    requestsOf(apart) === 4,
  );
  // The edge merges points of one block that are identical after the rules, and a copy is
  // identical: it cannot be told from two paths that became one route.
  record(
    'A',
    'finding',
    'one point of 4 requests written twice inside one block: added by the merge at the edge',
    '8 requests stored',
    `${requestsOf(twice)} requests stored`,
    requestsOf(twice) === 8,
  );
  record(
    'A',
    'required',
    'one request with two blocks of one identity (4 and 6 requests), then the same request again',
    '10 requests stored, then 10; 0 refusals recorded',
    `${first} requests stored, then ${requestsOf(blocks)}; ${refusedFor(TENANT_A, COLLISION) - before} refusals recorded`,
    first === 10 && requestsOf(blocks) === 10 && refusedFor(TENANT_A, COLLISION) === before,
  );
}

const psql = ['exec', '-T', 'postgres', 'psql', '-U', 'poc', '-d', 'poc', '-q'];
const WAITING_UPSERT = `wait_event_type = 'Lock' AND query LIKE '%api_metric_minute AS m%'`;
const TABLE_LOCKED = `
  SELECT count(*) FROM pg_locks
  WHERE mode = 'AccessExclusiveLock' AND granted
    AND relation = 'usage_signals.api_metric_minute'::regclass`;
const terminate = (where) =>
  sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${where}`);

/**
 * Keys and counts are one transaction: the transaction is broken after the key is inserted
 * and before the counts are added, and neither may remain.
 */
async function brokenTransaction(context) {
  const { TENANT_A, BASE_MS } = context;
  clearRows();
  clearKeys();
  const service = `dedup-broken-${runTag}`;
  const body = simpleBody(service, { count: 5, timeMs: BASE_MS, resource: { 'tenant.id': TENANT_A } });
  const lock = composeInBackground(
    psql,
    'BEGIN; LOCK TABLE usage_signals.api_metric_minute IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(600);',
  );
  await waitFor('the table lock', () => sql(TABLE_LOCKED).trim() === '1');
  const pending = direct(body);
  await waitFor(
    'the writer to wait for the row',
    () => sql(`SELECT count(*) FROM pg_stat_activity WHERE ${WAITING_UPSERT}`).trim() === '1',
  );
  terminate(WAITING_UPSERT);
  const failed = await pending;
  terminate("query LIKE '%pg_sleep(600)%' AND pid <> pg_backend_pid()");
  await lock;
  context.expected['storage-error'] = (context.expected['storage-error'] ?? 0) + 1;
  const left = `${countOf('api_point_key')} keys, ${requestsOf(service)} requests`;
  const again = await direct(body);
  const after = `${countOf('api_point_key')} keys, ${requestsOf(service)} requests`;
  record(
    'A',
    'required',
    'the transaction is broken between the key and the counts, then the batch is sent again',
    'HTTP 503 and 0 keys, 0 requests; then HTTP 200 and 1 keys, 5 requests',
    `HTTP ${failed.status} and ${left}; then HTTP ${again.status} and ${after}`,
    failed.status === 503 && left === '0 keys, 0 requests' && after === '1 keys, 5 requests',
  );
}

async function deduplication(context) {
  await writerSettings(DEFAULTS);
  try {
    await lostAcknowledgement(context);
    await killedInFlight(context);
    await sdkRetry(context);
    await race(context);
    await replicas(context);
    await oneRequestTwoPaths(context);
    await overlapInOneRequest(context);
    await brokenTransaction(context);
  } finally {
    await writerSettings(DEFAULTS);
  }
}

// ---------------------------------------------------------------- B. how long a key is kept

const LIFETIME_CASES = [
  // The document as written: keys for 2 days, and nothing that looks at the age of a point.
  { keyDays: 2, guard: false, later: 4, redelivery: true, stored: 22 },
  { keyDays: 2, guard: true, later: 4, redelivery: true, stored: 11 },
  { keyDays: 2, guard: true, later: 4, redelivery: false, stored: 0 },
  { keyDays: 8, guard: true, later: 1, redelivery: true, stored: 11 },
  { keyDays: 8, guard: true, later: 7, redelivery: true, stored: 11 },
  { keyDays: 8, guard: true, later: 8, redelivery: true, stored: 11 },
  { keyDays: 8, guard: true, later: 9, redelivery: true, stored: 11 },
  { keyDays: 8, guard: true, later: 30, redelivery: true, stored: 11 },
  { keyDays: 8, guard: true, later: 7, redelivery: false, stored: 11 },
  { keyDays: 8, guard: true, later: 8, redelivery: false, stored: 11 },
  { keyDays: 8, guard: true, later: 9, redelivery: false, stored: 0 },
  { keyDays: 8, guard: false, later: 10, redelivery: true, stored: 22 },
];

const lifetimeLabel = (item) =>
  `keys kept ${item.keyDays} days, ${item.guard ? 'older points refused' : 'no check of a point\'s age'}: ` +
  (item.redelivery
    ? `a counted batch delivered again ${item.later} days later`
    : `a batch first delivered ${item.later} days after its interval`);

async function lifetimeCase(item, i, { TENANT_A }) {
  clearKeys();
  const service = `lifetime-${runTag}-${i}`;
  await writerSettings({ ...DEFAULTS, keyDays: item.keyDays, refuseOlderThanKeys: item.guard });
  const body = simpleBody(service, {
    count: 11,
    timeMs: Date.now(),
    resource: { 'tenant.id': TENANT_A },
  });
  if (item.redelivery) await direct(body);
  await writerSettings({ clockOffsetDays: item.later });
  const purge = await purgeKeys();
  const answer = await direct(body);
  const refused = refusedFor(TENANT_A, TOO_OLD);
  const outcome = (stored, keysPurged, tooOld) =>
    `HTTP 200; ${stored} requests stored for 11 sent; key purged: ${keysPurged}; refused as too old: ${tooOld}`;
  // A redelivery is counted again exactly when its key is gone and its age is not checked.
  const wantPurged = item.redelivery && item.later > item.keyDays + 1 ? 'yes' : 'no';
  const wantRefused = item.guard && item.later > item.keyDays ? 1 : 0;
  record(
    'B',
    item.stored === 11 ? 'required' : 'finding',
    lifetimeLabel(item),
    outcome(item.stored, wantPurged, wantRefused),
    `HTTP ${answer.status}; ${requestsOf(service)} requests stored for 11 sent; key purged: ${purge.deleted > 0 ? 'yes' : 'no'}; refused as too old: ${refused}`,
    answer.status === 200 &&
      requestsOf(service) === item.stored &&
      (purge.deleted > 0 ? 'yes' : 'no') === wantPurged &&
      refused === wantRefused,
  );
}

/** The same through the collector: a batch that waits in its disk queue while the days pass. */
async function queuedAcrossDays(context, { keyDays, guard, later, stored, kind }) {
  const { tokenA, TENANT_A } = context;
  clearKeys();
  const service = `lifetime-queue-${runTag}-${keyDays}-${guard}`;
  await writerSettings({ ...DEFAULTS, keyDays, refuseOlderThanKeys: guard });
  const body = simpleBody(service, { count: 11, timeMs: Date.now() });
  const { from } = await commitThenKillCollector(service, body, tokenA);
  await writerSettings({ clockOffsetDays: later });
  const purge = await purgeKeys();
  await restartCollectorAndWait(service, from);
  const seen = deliveries(service, from);
  record(
    'B',
    kind,
    `through the collector, keys kept ${keyDays} days, ${guard ? 'older points refused' : 'no check of a point\'s age'}: the collector is down for ${later} days with a counted batch in its queue`,
    `delivered 2 times; ${stored} requests stored for 11 sent`,
    `delivered ${seen.times} times; ${requestsOf(service)} requests stored for 11 sent (keys purged: ${purge.deleted}, refused as too old: ${refusedFor(TENANT_A, TOO_OLD)})`,
    seen.times === 2 && requestsOf(service) === stored,
  );
  await writerSettings(DEFAULTS);
  await settle(tokenA);
}

// A fifth of a day's keys, to keep the run's disk use near 20 MB; the size is per key.
const KEYS_MEASURED = 200_000;

/** What a day of keys costs at the design volume: at most one key per request. */
function keyStorage() {
  clearKeys();
  sql(
    `INSERT INTO usage_signals.api_point_key
     SELECT DATE '2026-01-01', gen_random_uuid(), 0 FROM generate_series(1, ${KEYS_MEASURED})`,
  );
  const table = `'usage_signals.api_point_key'`;
  const [size] = sql(
    `SELECT pg_relation_size(${table}) AS heap, pg_indexes_size(${table}) AS index,
            pg_total_relation_size(${table}) AS total`,
    { rows: true },
  );
  const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  const perKey = size.total / KEYS_MEASURED;
  record(
    'B',
    'finding',
    `storage of ${KEYS_MEASURED.toLocaleString('en')} keys of one day, inserted in random order`,
    'between 95 and 115 bytes a key',
    `${perKey.toFixed(1)} bytes a key: ${megabytes(size.total)} MB (table ${megabytes(size.heap)} MB, index ${megabytes(size.index)} MB)`,
    perKey >= 95 && perKey <= 115,
  );
}

async function keyLifetime(context) {
  clearRows();
  try {
    for (const [i, item] of LIFETIME_CASES.entries()) await lifetimeCase(item, i, context);
    await writerSettings(DEFAULTS);
    await queuedAcrossDays(context, { keyDays: 2, guard: false, later: 4, stored: 22, kind: 'finding' });
    await queuedAcrossDays(context, { keyDays: 8, guard: true, later: 7, stored: 11, kind: 'required' });
    keyStorage();
    const purge = await purgeKeys();
    record(
      'B',
      'required',
      'the purge removes a day of keys that is older than the keys kept',
      `${KEYS_MEASURED} keys deleted`,
      `${purge.deleted} keys deleted`,
      purge.deleted === KEYS_MEASURED,
    );
  } finally {
    await writerSettings(DEFAULTS);
    clearKeys();
  }
}

export function deliveryPhases(context) {
  const phases = [builderBuild, deduplication, keyLifetime];
  return phases.map((phase) =>
    Object.defineProperty(() => phase(context), 'name', { value: phase.name }),
  );
}
