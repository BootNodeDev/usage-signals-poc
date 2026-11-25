// The cases the independent review of check 05 added: duplicated attribute keys, batches the
// writer can never store, a tenant Collector that converts cumulative to delta, what besides
// the allowlisted fields reaches the disk queue, and routes that are not strings.
import {
  TENANT_COLLECTOR,
  WRITER,
  capture,
  captureLength,
  clearRows,
  databaseDump,
  driveRealService,
  post,
  queueHolds,
  record,
  runTag,
  setWriterMode,
  settle,
  simpleBody,
  sleep,
  startPostgres,
  startTenantCollector,
  stopPostgres,
  storedRows,
  useConfig,
  waitFor,
  writerSaw,
} from './harness.mjs';
import { BOUNDS_S, attributes, signRs256, strkey, tenantClaims } from './lib.mjs';
import { encodeMetricsRequest } from './proto.mjs';

const sum = (values) => values.reduce((total, value) => total + value, 0);
const firstPoint = (body) =>
  body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
const copies = (map, times) => Array.from({ length: times }, () => attributes(map)).flat();

function send(body, token, encoding = 'json') {
  if (encoding === 'json') return post('/v1/metrics', body, { token });
  return post('/v1/metrics', encodeMetricsRequest(body), {
    token,
    contentType: 'application/x-protobuf',
  });
}

const requestsOf = (service) => sum(storedRows(service).map((row) => row.request_count));

// ---------------------------------------------------------------- duplicated stamped keys

function duplicateTenantCases(tenantB) {
  const targets = {
    resource: (body) => body.resourceMetrics[0].resource.attributes,
    scope: (body) => (body.resourceMetrics[0].scopeMetrics[0].scope.attributes ??= []),
    'data point': (body) => firstPoint(body).attributes,
  };
  const cases = [];
  for (const level of Object.keys(targets)) {
    for (const times of [2, 3]) {
      for (const encoding of ['json', 'protobuf']) {
        const add = (body) => targets[level](body).push(...copies({ 'tenant.id': tenantB }, times));
        cases.push({
          name: `tenant.id = B ${times} times at ${level} level, ${encoding}`,
          add,
          encoding,
        });
      }
    }
  }
  return cases;
}

async function duplicateStampedKeys(context) {
  const { TENANT_A, TENANT_B, tokenA, BASE_MS } = context;
  clearRows();
  const cases = duplicateTenantCases(TENANT_B);
  for (const [i, item] of cases.entries()) {
    item.service = `dupkey-${runTag}-${i}`;
    const body = simpleBody(item.service, { count: 3, timeMs: BASE_MS });
    item.add(body);
    item.answer = await send(body, tokenA, item.encoding);
  }
  const forged = { 'usage_signals.token_id': 'forged', 'usage_signals.received_at_unix_nano': 1 };
  const from = captureLength();
  for (const encoding of ['json', 'protobuf']) {
    const body = simpleBody(`duptoken-${runTag}-${encoding}`, { timeMs: BASE_MS });
    body.resourceMetrics[0].resource.attributes.push(...copies(forged, 3));
    await send(body, tokenA, encoding);
  }
  await settle(tokenA);
  const rows = storedRows(`dupkey-${runTag}-%`);
  for (const item of cases) {
    const tenants = rows.filter((row) => row.service === item.service).map((row) => row.tenant_id);
    const pass = item.answer.status === 200 && tenants.length === 1 && tenants[0] === TENANT_A;
    record(
      1,
      'required',
      `token of A, ${item.name}`,
      'HTTP 200, stored for A',
      `HTTP ${item.answer.status}, stored for ${tenants.map((id) => (id === TENANT_A ? 'A' : id === TENANT_B ? 'B' : id)).join(',') || 'nobody'}`,
      pass,
    );
  }
  const tokenId = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url')).jti;
  for (const encoding of ['json', 'protobuf']) {
    const resource = writerSaw(`duptoken-${runTag}-${encoding}`, from).accepted[0]?.resource ?? {};
    const receivedMs = Number(resource['usage_signals.received_at_unix_nano']) / 1e6;
    const genuine =
      resource['usage_signals.token_id'] === tokenId && receivedMs > Date.now() - 600_000;
    record(
      1,
      'required',
      `token ID and time of receipt forged 3 times at resource level, ${encoding}`,
      `${tokenId}, a time of this run`,
      `${resource['usage_signals.token_id']}, ${Math.round(receivedMs)}`,
      genuine,
    );
  }

  await useConfig('strip-first-duplicate-only');
  const service = `dupkey-firstonly-${runTag}`;
  const body = simpleBody(service, { count: 3, timeMs: BASE_MS });
  body.resourceMetrics[0].resource.attributes.push(...copies({ 'tenant.id': TENANT_B }, 3));
  await send(body, tokenA);
  await settle(tokenA);
  const tenants = storedRows(service).map((row) => (row.tenant_id === TENANT_B ? 'B' : 'A'));
  record(
    1,
    'control',
    'with delete_key, which removes one occurrence, 3 copies of tenant.id = B are stored for B',
    'B',
    tenants.join(',') || 'nobody',
    tenants.join(',') === 'B',
  );
  await useConfig('design');
}

// ---------------------------------------------------------------- duplicated kept keys

const STABLE = 'http.server.request.duration';
const LEGACY = 'http.server.duration';

function duplicateRouteCases(raw) {
  const secret = `${raw}/secret-user-42`;
  const route = (value) => attributes({ 'http.route': value });
  const target = (value) => attributes({ 'http.target': value });
  return [
    {
      name: 'http.route twice, the second raw',
      add: [...route(secret)],
      first: raw,
      expected: '/accounts/{account}',
    },
    {
      name: 'http.route twice, the first a template',
      first: '/users/{id}',
      add: [...route(raw)],
      expected: '/users/{id}',
    },
    {
      name: 'http.route three times, two raw',
      first: '/users/{id}',
      add: [...route(raw), ...route(secret)],
      expected: '/users/{id}',
    },
    {
      name: 'http.route twice, protobuf',
      first: raw,
      add: [...route(secret)],
      encoding: 'protobuf',
      expected: '/accounts/{account}',
    },
    {
      name: 'http.route and a raw http.target',
      first: '/users/{id}',
      add: [...target(secret)],
      expected: '/users/{id}',
    },
    {
      name: 'older metric, http.target twice',
      legacy: true,
      first: raw,
      add: [...target(secret)],
      expected: '/accounts/{account}',
    },
  ];
}

function duplicateRouteBody(item, service, timeMs) {
  const body = simpleBody(service, { count: 2, route: item.first, timeMs });
  const point = firstPoint(body);
  if (item.legacy) {
    const metric = body.resourceMetrics[0].scopeMetrics[0].metrics[0];
    metric.name = LEGACY;
    metric.unit = 'ms';
    point.explicitBounds = BOUNDS_S.map((seconds) => Math.round(seconds * 1000));
    point.attributes = attributes({
      'http.target': item.first,
      'http.method': 'GET',
      'http.status_code': 200,
    });
  }
  point.attributes.push(...item.add);
  return body;
}

async function sendDuplicateRoutes(prefix, raw, context) {
  const cases = duplicateRouteCases(`/accounts/${raw}`);
  for (const [i, item] of cases.entries()) {
    item.service = `${prefix}-${i}`;
    const body = duplicateRouteBody(item, item.service, context.BASE_MS);
    item.answer = await send(body, context.tokenA, item.encoding);
  }
  return cases;
}

async function duplicateKeptKeys(context) {
  clearRows();
  const raw = strkey('G', 991);
  const prefix = `duproute-${runTag}`;
  // The writer answers 503, so what the collector queued stays on its disk.
  await setWriterMode('503');
  const from = captureLength();
  const cases = await sendDuplicateRoutes(prefix, raw, context);
  await waitFor('the writer to refuse the queued batch', () =>
    capture(from).some((entry) => entry.outcome === 'answered-503'),
  );
  await sleep(1500);
  const queued = queueHolds(`${prefix}-0`);
  const rawQueued = queueHolds(raw);
  record(
    4,
    'required',
    'raw address sent in a duplicated http.route or http.target: in the queue directory',
    'absent (the services are found)',
    `${rawQueued ? 'found' : 'absent'} (the services are ${queued ? 'found' : 'absent'})`,
    queued && !rawQueued,
  );
  await setWriterMode('ok');
  await waitFor(
    'the queued points',
    () => storedRows(`${prefix}-%`).length >= cases.length,
    20_000,
  ).catch(() => {});
  await settle(context.tokenA);
  const rows = storedRows(`${prefix}-%`);
  for (const item of cases) {
    const routes = rows.filter((row) => row.service === item.service).map((row) => row.route);
    record(
      4,
      'required',
      `${item.name}: stored route`,
      item.expected,
      routes.join(' | ') || 'no row',
      routes.length === 1 && routes[0] === item.expected,
    );
  }
  const inDump = databaseDump().includes(raw);
  record(
    4,
    'required',
    'raw address sent in a duplicated key: in the database dump',
    'absent',
    inDump ? 'found' : 'absent',
    !inDump,
  );

  await useConfig('no-attribute-rebuild');
  await setWriterMode('503');
  const controlRaw = strkey('G', 992);
  const controlFrom = captureLength();
  await sendDuplicateRoutes(`duproute-off-${runTag}`, controlRaw, context);
  await waitFor('the writer to refuse the queued batch', () =>
    capture(controlFrom).some((entry) => entry.outcome === 'answered-503'),
  );
  await sleep(1500);
  record(
    4,
    'control',
    'attribute rebuild removed: the raw address of a duplicated key is in the queue directory',
    'found',
    queueHolds(controlRaw) ? 'found' : 'absent',
    queueHolds(controlRaw),
  );
  await setWriterMode('ok');
  await settle(context.tokenA);
  await useConfig('design');
}

// ---------------------------------------------------------------- unstorable batches

const POISON = {
  'NUL in the service name': (body) => {
    body.resourceMetrics[0].resource.attributes[0].value.stringValue += '\u0000x';
  },
  'NUL in the method': (body) => {
    firstPoint(body).attributes.find(
      (item) => item.key === 'http.request.method',
    ).value.stringValue = 'GE\u0000T';
  },
  'negative sum': (body) => {
    firstPoint(body).sum = -5;
  },
  'count of 2^64-1': (body) => {
    firstPoint(body).count = '18446744073709551615';
  },
  'one bucket count for 14 bounds': (body) => {
    firstPoint(body).bucketCounts = ['3'];
  },
  'status code 99': (body) => {
    firstPoint(body).attributes.find(
      (item) => item.key === 'http.response.status_code',
    ).value.intValue = '99';
  },
  'bucket counts that do not add up to the count': (body) => {
    firstPoint(body).count = '4';
  },
  'service name of 3,000 characters': (body) => {
    body.resourceMetrics[0].resource.attributes[0].value.stringValue += 'x'.repeat(3000);
  },
};

async function arrivalMs(service, limitMs) {
  const started = Date.now();
  const arrived = await waitFor('a row', () => storedRows(service).length > 0, limitMs).catch(
    () => false,
  );
  return arrived ? Date.now() - started : null;
}

async function unstorableBatches(context) {
  const { tokenA, tokenB, key, BASE_MS } = context;
  clearRows();
  const from = captureLength();
  const kinds = Object.keys(POISON);
  const answers = [];
  // Twenty-four batches, more than the exporter's ten queue consumers.
  for (let i = 0; i < 24; i += 1) {
    const body = simpleBody(`poison-${runTag}-${i}`, { count: 3, timeMs: BASE_MS });
    POISON[kinds[i % kinds.length]](body);
    answers.push((await post('/v1/metrics', body, { token: tokenA })).status);
  }
  // A correctly signed token for a tenant that is not enrolled.
  const stranger = signRs256(tenantClaims('00000000-0000-4000-8000-000000000000'), key);
  for (let i = 0; i < 4; i += 1) {
    answers.push(
      (
        await post(
          '/v1/metrics',
          simpleBody(`poison-${runTag}-stranger-${i}`, { timeMs: BASE_MS }),
          { token: stranger },
        )
      ).status,
    );
  }
  const service = `after-poison-${runTag}`;
  const sent = await post('/v1/metrics', simpleBody(service, { count: 5, timeMs: BASE_MS }), {
    token: tokenB,
  });
  const took = await arrivalMs(service, 15_000);
  record(
    9,
    'required',
    `tenant B's batch after ${answers.length} unstorable batches of tenant A`,
    'stored within 5,000 ms',
    took === null ? 'not stored within 15,000 ms' : `stored after ${took} ms`,
    sent.status === 200 && took !== null && took <= 5000,
  );
  await settle(tokenB).catch(() => {});
  const entries = capture(from);
  const retried = entries.filter((entry) =>
    ['storage-error', 'answered-503', 'writer-bug'].includes(entry.outcome),
  ).length;
  record(
    9,
    'required',
    'writer answers 503 or storage errors while the unstorable batches pass',
    0,
    retried,
    retried === 0,
  );
  const refused = entries
    .flatMap((entry) => entry.refused ?? [])
    .filter((item) => String(item.resource['service.name']).startsWith(`poison-${runTag}`));
  const reasons = [...new Set(refused.map((item) => item.reason))].sort();
  record(
    9,
    'required',
    'unstorable points refused for good, each with a reason',
    `${answers.length} refused, 0 rows`,
    `${refused.length} refused, ${storedRows(`poison-${runTag}%`).length} rows (${reasons.join('; ')})`,
    refused.length === answers.length && storedRows(`poison-${runTag}%`).length === 0,
  );
  record(
    9,
    'finding',
    "what the tenant's exporter sees for an unstorable batch",
    'HTTP 200 from the collector',
    `HTTP ${[...new Set(answers)].join(',')}`,
    answers.every((status) => status === 200),
  );
}

async function writerAnswers(context) {
  const { TENANT_A, BASE_MS } = context;
  clearRows();
  const direct = (body) => post('/v1/metrics', body, { base: WRITER });
  const stamped = (service, change = () => {}) => {
    const body = simpleBody(service, {
      count: 3,
      timeMs: BASE_MS,
      resource: { 'tenant.id': TENANT_A },
    });
    change(body);
    return body;
  };
  const undecodable = await direct('{"resourceMetrics":[{"oops"');
  context.expected.undecodable = 1;
  record(
    9,
    'required',
    'writer, undecodable body',
    'HTTP 400',
    `HTTP ${undecodable.status}`,
    undecodable.status === 400,
  );

  const good = `direct-good-${runTag}`;
  const mixed = stamped(good);
  mixed.resourceMetrics.push(
    stamped(`direct-bad-${runTag}`, POISON['negative sum']).resourceMetrics[0],
  );
  const partial = await direct(mixed);
  const rejected = JSON.parse(partial.text).partialSuccess?.rejectedDataPoints;
  record(
    9,
    'required',
    'writer, one storable and one unstorable point in a batch',
    'HTTP 200, 1 rejected, 3 requests stored',
    `HTTP ${partial.status}, ${rejected ?? 0} rejected, ${requestsOf(good)} requests stored`,
    partial.status === 200 && rejected === '1' && requestsOf(good) === 3,
  );

  const duplicated = stamped(`direct-dup-${runTag}`, (body) =>
    firstPoint(body).attributes.push(...attributes({ 'http.route': '/other' })),
  );
  const refusedDuplicate = await direct(duplicated);
  record(
    9,
    'required',
    'writer, a point with a duplicated attribute key',
    'HTTP 200, 1 rejected, 0 rows',
    `HTTP ${refusedDuplicate.status}, ${JSON.parse(refusedDuplicate.text).partialSuccess?.rejectedDataPoints ?? 0} rejected, ${storedRows(`direct-dup-${runTag}`).length} rows`,
    JSON.parse(refusedDuplicate.text).partialSuccess?.rejectedDataPoints === '1' &&
      storedRows(`direct-dup-${runTag}`).length === 0,
  );

  const zero = stamped(`direct-zero-${runTag}`, (body) => {
    const point = firstPoint(body);
    // As the collector's JSON export writes a zero-count point: no count, no sum, no min, no max.
    for (const field of ['count', 'sum', 'min', 'max']) delete point[field];
    point.bucketCounts = new Array(15).fill('0');
  });
  const emptyAnswer = await direct(zero);
  record(
    9,
    'required',
    'writer, a zero-count point without a count field',
    'HTTP 200, 0 rejected, 0 rows',
    `HTTP ${emptyAnswer.status}, ${JSON.parse(emptyAnswer.text).partialSuccess?.rejectedDataPoints ?? 0} rejected, ${storedRows(`direct-zero-${runTag}`).length} rows`,
    emptyAnswer.status === 200 &&
      !JSON.parse(emptyAnswer.text).partialSuccess &&
      storedRows(`direct-zero-${runTag}`).length === 0,
  );
}

async function databaseOutage(context) {
  const { tokenA, BASE_MS } = context;
  clearRows();
  const service = `pg-outage-${runTag}`;
  const from = captureLength();
  await stopPostgres();
  const answer = await post('/v1/metrics', simpleBody(service, { count: 9, timeMs: BASE_MS }), {
    token: tokenA,
  });
  await waitFor(
    'the writer to meet the stopped database',
    () => capture(from).some((entry) => entry.outcome === 'storage-error'),
    20_000,
  ).catch(() => {});
  await sleep(1500);
  const errors = capture(from).filter((entry) => entry.outcome === 'storage-error').length;
  const kept = queueHolds(service);
  record(
    7,
    'required',
    'PostgreSQL stopped: the writer answers 503 and the collector keeps the batch',
    'accepted, on disk, storage errors > 0',
    `HTTP ${answer.status}, ${kept ? 'on disk' : 'not on disk'}, ${errors} storage errors`,
    answer.status === 200 && kept && errors > 0,
  );
  await startPostgres();
  await waitFor('the kept batch', () => requestsOf(service) >= 9, 30_000).catch(() => {});
  await sleep(4000);
  record(
    7,
    'required',
    'PostgreSQL started again: the kept batch is stored once',
    9,
    requestsOf(service),
    requestsOf(service) === 9,
  );
  context.expected['storage-error'] = capture(from).filter(
    (entry) => entry.outcome === 'storage-error',
  ).length;
}

// ---------------------------------------------------------------- a tenant Collector in front

const TENANT_PLAN = [
  {
    method: 'GET',
    path: (i) => `/users/${2000 + i}`,
    times: 40,
    route: '/users/{id}',
    status: 200,
  },
  { method: 'GET', path: () => '/health', times: 10, route: '/health', status: 200 },
];

async function cumulativeToDelta(context) {
  const { TENANT_B, tokenA, tokenB } = context;
  clearRows();
  await startTenantCollector(tokenB);
  const service = `c2d-${runTag}`;
  const from = captureLength();
  // The SDK's default cumulative temporality; four idle seconds follow the requests.
  const { sent } = await driveRealService({
    serviceName: service,
    temporality: 'cumulative',
    plan: TENANT_PLAN,
    token: 'unused',
    exportTo: TENANT_COLLECTOR,
    idleMs: 4000,
  });
  await waitFor('the converted points', () => requestsOf(service) >= sent, 20_000).catch(() => {});
  await settle(tokenA);
  const seen = writerSaw(service, from);
  record(
    9,
    'control',
    'cumulativetodelta in front: zero-count delta points reach the writer',
    'more than 0',
    seen.empty.length,
    seen.empty.length > 0,
  );
  const expected = TENANT_PLAN.map(
    (item) => `${item.route}|${item.method}|${item.status}=${item.times}`,
  )
    .sort()
    .join('; ');
  const totals = new Map();
  for (const row of storedRows(service)) {
    const rowKey = `${row.route}|${row.method}|${row.status_code}`;
    totals.set(rowKey, (totals.get(rowKey) ?? 0) + row.request_count);
  }
  const observed = [...totals]
    .map(([rowKey, count]) => `${rowKey}=${count}`)
    .sort()
    .join('; ');
  const tenants = [...new Set(storedRows(service).map((row) => row.tenant_id))];
  record(
    9,
    'required',
    `cumulativetodelta in front: ${sent} real requests of a cumulative SDK, summed over minutes`,
    expected,
    observed || 'no rows',
    observed === expected && tenants.length === 1 && tenants[0] === TENANT_B,
  );
  const errors = capture(from).filter((entry) =>
    ['storage-error', 'writer-bug'].includes(entry.outcome),
  ).length;
  record(
    9,
    'required',
    'cumulativetodelta in front: storage errors and refused points',
    '0 errors, 0 refused',
    `${errors} errors, ${seen.refused.length} refused`,
    errors === 0 && seen.refused.length === 0,
  );
}

// ---------------------------------------------------------------- what reaches the disk queue

function leakBody(service, mark, timeMs) {
  const body = simpleBody(service, {
    count: 3,
    route: '/users/{id}',
    timeMs,
    resource: { 'host.name': mark('host'), 'process.command_line': mark('cmdline') },
    pointAttrs: {
      'user.id': mark('user'),
      'url.query': mark('query'),
      'client.address': mark('client'),
    },
  });
  const resourceMetrics = body.resourceMetrics[0];
  const scopeMetrics = resourceMetrics.scopeMetrics[0];
  const metric = scopeMetrics.metrics[0];
  const point = firstPoint(body);
  point.exemplars = [
    {
      timeUnixNano: point.timeUnixNano,
      asDouble: 0.02,
      traceId: 'aaaabbbbccccddddeeeeffff00001111',
      spanId: '1234567890abcdef',
      filteredAttributes: attributes({ 'url.path': `/users/${mark('exemplar')}` }),
    },
  ];
  metric.description = mark('description');
  metric.metadata = attributes({ note: mark('metadata') });
  scopeMetrics.scope = {
    name: mark('scopename'),
    version: mark('scopeversion'),
    attributes: attributes({ library: mark('scopeattr') }),
  };
  scopeMetrics.schemaUrl = `https://example.org/${mark('scopeschema')}`;
  resourceMetrics.schemaUrl = `https://example.org/${mark('resourceschema')}`;
  return body;
}

const LEAK_MARKS = [
  'host',
  'cmdline',
  'user',
  'query',
  'client',
  'exemplar',
  'description',
  'metadata',
  'scopename',
  'scopeversion',
  'scopeattr',
  'scopeschema',
  'resourceschema',
];
const TRACE_ID = 'aaaabbbbccccddddeeeeffff00001111';

/** The marker strings, and the exemplar's trace ID as text or bytes, found in the queue. */
function marksInQueue(mark) {
  const found = LEAK_MARKS.filter((name) => queueHolds(mark(name)));
  if (queueHolds(TRACE_ID) || queueHolds(Buffer.from(TRACE_ID, 'hex')))
    found.push('exemplar trace ID');
  return found;
}

async function queueContents(context) {
  clearRows();
  const send = async (service, mark) => {
    await setWriterMode('503');
    const from = captureLength();
    await post('/v1/metrics', leakBody(service, mark, context.BASE_MS), { token: context.tokenA });
    await waitFor('the writer to refuse the queued batch', () =>
      capture(from).some((entry) => entry.outcome === 'answered-503'),
    );
    await sleep(1500);
    const result = { queued: queueHolds(service), found: marksInQueue(mark) };
    await setWriterMode('ok');
    await waitFor('the queued point', () => storedRows(service).length > 0, 20_000).catch(() => {});
    return result;
  };
  const service = `leak-${runTag}`;
  const main = await send(service, (name) => `MRK${name}${runTag}`);
  record(
    5,
    'required',
    'exemplar, description, metadata, scope, schema URLs and other attributes: markers in the queue directory',
    'none (the service name is found)',
    `${main.found.join(', ') || 'none'} (the service name is ${main.queued ? 'found' : 'absent'})`,
    main.queued && main.found.length === 0,
  );
  record(
    5,
    'required',
    'the same point is stored',
    '3 requests',
    `${requestsOf(service)} requests`,
    requestsOf(service) === 3,
  );

  await useConfig('keep-exemplars');
  const control = await send(`leak-exemplars-${runTag}`, (name) => `MRKCTL${name}${runTag}`);
  record(
    5,
    'control',
    'exemplar statement removed: the exemplar is in the queue directory',
    'exemplar, exemplar trace ID',
    control.found.join(', ') || 'none',
    control.found.includes('exemplar') && control.found.includes('exemplar trace ID'),
  );
  await settle(context.tokenA);
  await useConfig('design');
}

// ---------------------------------------------------------------- routes that are not strings

const ROUTE_VALUES = {
  integer: { intValue: '123' },
  boolean: { boolValue: true },
  double: { doubleValue: 1.5 },
  array: { arrayValue: { values: [{ stringValue: '/users/123' }] } },
  'key-value list': {
    kvlistValue: { values: [{ key: 'path', value: { stringValue: '/users/123' } }] },
  },
  bytes: { bytesValue: Buffer.from('/users/123').toString('base64') },
  'empty value': {},
};

async function routeTypes(context) {
  clearRows();
  const names = Object.keys(ROUTE_VALUES);
  for (const [i, name] of names.entries()) {
    const body = simpleBody(`routetype-${runTag}-${i}`, { timeMs: context.BASE_MS });
    firstPoint(body).attributes.find((item) => item.key === 'http.route').value =
      ROUTE_VALUES[name];
    await post('/v1/metrics', body, { token: context.tokenA });
  }
  await settle(context.tokenA);
  const rows = storedRows(`routetype-${runTag}-%`);
  const observed = names.map(
    (name, i) =>
      `${name}: ${
        rows
          .filter((row) => row.service === `routetype-${runTag}-${i}`)
          .map((row) => row.route)
          .join('|') || 'no row'
      }`,
  );
  const expected = names.map((name) => `${name}: (unmatched)`);
  record(
    4,
    'required',
    'http.route sent as something other than a string',
    expected.join('; '),
    observed.join('; '),
    observed.join('; ') === expected.join('; '),
  );
}

// ---------------------------------------------------------------- stated, not fixed

async function silentAndRepeated(context) {
  const { tokenA, BASE_MS } = context;
  clearRows();
  const cases = {
    'bucket bounds other than the 14 advised': (body) => {
      firstPoint(body).explicitBounds = [0.1, 1];
      firstPoint(body).bucketCounts = ['3', '0', '0'];
    },
    'the older SDK bounds, which start at 0': (body) => {
      firstPoint(body).explicitBounds = [0, ...BOUNDS_S];
      firstPoint(body).bucketCounts = ['0', ...firstPoint(body).bucketCounts];
    },
    'status code sent as a string': (body) => {
      firstPoint(body).attributes.find((item) => item.key === 'http.response.status_code').value = {
        stringValue: '200',
      };
    },
  };
  const outcomes = [];
  for (const [i, name] of Object.keys(cases).entries()) {
    const service = `silent-${runTag}-${i}`;
    const body = simpleBody(service, { count: 3, timeMs: BASE_MS });
    cases[name](body);
    const answer = await post('/v1/metrics', body, { token: tokenA });
    outcomes.push({ name, service, status: answer.status });
  }
  const repeated = simpleBody(`repeated-${runTag}`, { count: 4, timeMs: BASE_MS });
  for (let i = 0; i < 3; i += 1) await post('/v1/metrics', repeated, { token: tokenA });
  await settle(tokenA);
  for (const item of outcomes) {
    const rows = storedRows(item.service).length;
    record(
      9,
      'finding',
      `${item.name}: answered as a success and stored nowhere`,
      'HTTP 200, 0 rows',
      `HTTP ${item.status}, ${rows} rows`,
      item.status === 200 && rows === 0,
    );
  }
  const stored = requestsOf(`repeated-${runTag}`);
  // Round one recorded 12 here as a finding. Round two added the point-level key.
  record(
    9,
    'required',
    'one batch of 4 requests sent 3 times is counted once',
    '4 requests stored',
    `${stored} requests stored`,
    stored === 4,
  );
}

export function reviewPhases(context) {
  const phases = [
    duplicateStampedKeys,
    duplicateKeptKeys,
    unstorableBatches,
    writerAnswers,
    databaseOutage,
    cumulativeToDelta,
    queueContents,
    routeTypes,
    silentAndRepeated,
  ];
  // Named wrappers, so that the progress lines and an aborted phase carry the phase's name.
  return phases.map((phase) =>
    Object.defineProperty(() => phase(context), 'name', { value: phase.name }),
  );
}
