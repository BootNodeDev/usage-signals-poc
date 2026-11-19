// Check 05: "The collector pipeline runs end to end as configured, and the path rules run as
// collector statements."
// Starts an isolated stack, runs every case, prints the tables and the verdict, and exits
// non-zero when any figure differs from what the verdict and the README rest on.
// Usage: node run.mjs   (CHECK_KEEP_STACK=1 leaves the containers up afterwards)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  COLLECTOR,
  HERE,
  capture,
  captureLength,
  clearRows,
  compose,
  databaseDump,
  headersOnly,
  post,
  queueFiles,
  queueHolds,
  record,
  results,
  runTag,
  scratch,
  setWriterMode,
  settle,
  simpleBody,
  sleep,
  sql,
  startStack,
  startWriter,
  stopStack,
  storedRows,
  useConfig,
  waitFor,
  writerSaw,
} from './harness.mjs';
import {
  AUDIENCE,
  BOUNDS_MS,
  BOUNDS_S,
  CUMULATIVE,
  DELTA,
  attributes,
  bucketIndex,
  histogramMetric,
  histogramPoint,
  newSigningKey,
  resourceMetrics,
  seededRandom,
  signHs256WithPublicKey,
  signRs256,
  strkey,
  strkeyOf,
  tenantClaims,
  unsignedToken,
  withSwappedClaims,
} from './lib.mjs';
import { VECTORS } from './vectors.mjs';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const key = newSigningKey('edge-key-1');
const attackerKey = newSigningKey('edge-key-1');
const tokenA = signRs256(tenantClaims(TENANT_A), key);
const tokenB = signRs256(tenantClaims(TENANT_B), key);
// Two minutes back, on a minute boundary plus 30 seconds: hand-written points never straddle.
const BASE_MS = (Math.floor(Date.now() / 60_000) - 5) * 60_000 + 30_000;
const minuteOf = (timeMs) => Math.floor(timeMs / 60_000);
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const pathTables = { vectors: [], auth: [] };

// ---------------------------------------------------------------- 0. the experiment's own tools

// The module that implements each component type named in collector.yaml.
const MODULE_OF = {
  oidc: 'extension/oidcauthextension',
  file_storage: 'extension/storage/filestorage',
  otlp: 'receiver/otlpreceiver',
  memory_limiter: 'processor/memorylimiterprocessor',
  resource: 'processor/resourceprocessor',
  filter: 'processor/filterprocessor',
  transform: 'processor/transformprocessor',
  otlp_http: 'exporter/otlphttpexporter',
  nop: 'exporter/nopexporter',
};

/** Component types under the top-level sections of collector.yaml, read by indentation. */
function configuredModules() {
  const modules = new Set();
  let section = null;
  for (const line of readFileSync(path.join(HERE, 'collector.yaml'), 'utf8').split('\n')) {
    const top = /^([a-z]+):/.exec(line);
    if (top) section = top[1];
    const component = /^ {2}([a-z_]+)(?:\/[a-z_]+)?:/.exec(line);
    if (component && ['extensions', 'receivers', 'processors', 'exporters'].includes(section)) {
      if (!MODULE_OF[component[1]])
        throw new Error(`no module known for component type ${component[1]}`);
      modules.add(MODULE_OF[component[1]]);
    }
  }
  return [...modules].sort();
}

function checkTools() {
  // SEP-23, test vector 1: this public key and this address.
  const sepKey = Buffer.from(
    '3f0c34bf93ad0d9971d04ccc90f705511c838aad9734a4a2fb0d7a03fc7fe89a',
    'hex',
  );
  const sepAddress = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
  record(
    4,
    'control',
    "the experiment's strkey encoder reproduces SEP-23 test vector 1",
    sepAddress,
    strkeyOf('G', [...sepKey]),
    strkeyOf('G', [...sepKey]) === sepAddress,
  );
  const manifest = readFileSync(path.join(HERE, 'builder-manifest.yaml'), 'utf8');
  const listed = [
    ...manifest.matchAll(
      /^ {2}- gomod: \S+?\/((?:extension|receiver|processor|exporter)\/\S+) v/gm,
    ),
  ]
    .map((match) => match[1])
    .sort();
  record(
    8,
    'control',
    'builder-manifest.yaml lists exactly the components collector.yaml uses',
    configuredModules().join(', '),
    listed.join(', '),
    sameList(listed, configuredModules()),
  );
}

// ---------------------------------------------------------------- 1. authentication

const STABLE = 'http.server.request.duration';
const LEGACY = 'http.server.duration';

function authCases() {
  const expired = tenantClaims(TENANT_A, { exp: Math.floor(Date.now() / 1000) - 60 });
  const spoof = {
    resource: { 'tenant.id': TENANT_B, 'usage_signals.token_id': 'forged' },
    pointAttrs: { 'tenant.id': TENANT_B },
  };
  return [
    {
      name: 'valid token of tenant A',
      authorization: `Bearer ${tokenA}`,
      status: 200,
      tenant: TENANT_A,
    },
    {
      name: 'valid token of tenant B',
      authorization: `Bearer ${tokenB}`,
      status: 200,
      tenant: TENANT_B,
    },
    {
      name: 'token of A, payload claims tenant.id = B',
      authorization: `Bearer ${tokenA}`,
      status: 200,
      tenant: TENANT_A,
      body: spoof,
    },
    { name: 'no Authorization header', authorization: undefined, status: 401, tenant: null },
    { name: 'token without the Bearer scheme', authorization: tokenA, status: 401, tenant: null },
    { name: 'malformed token', authorization: 'Bearer not-a-token', status: 401, tenant: null },
    {
      name: 'expired token, correctly signed',
      authorization: `Bearer ${signRs256(expired, key)}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'signed with another key, same key ID',
      authorization: `Bearer ${signRs256(tenantClaims(TENANT_A), attackerKey)}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'signed with another key, unknown key ID',
      authorization: `Bearer ${signRs256(tenantClaims(TENANT_A), attackerKey, 'other')}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'token of A with claims swapped to B, signature kept',
      authorization: `Bearer ${withSwappedClaims(tokenA, tenantClaims(TENANT_B))}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'unsigned token (alg none)',
      authorization: `Bearer ${unsignedToken(tenantClaims(TENANT_A))}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'HMAC keyed with the public key',
      authorization: `Bearer ${signHs256WithPublicKey(tenantClaims(TENANT_A), key)}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'correctly signed, another issuer',
      authorization: `Bearer ${signRs256(tenantClaims(TENANT_A, { iss: 'https://elsewhere.invalid' }), key)}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'correctly signed, another audience',
      authorization: `Bearer ${signRs256(tenantClaims(TENANT_A, { aud: 'someone-else' }), key)}`,
      status: 401,
      tenant: null,
    },
    {
      name: 'correctly signed, no tenant_id claim',
      authorization: `Bearer ${signRs256(tenantClaims(TENANT_A, { tenant_id: undefined }), key)}`,
      status: 200,
      tenant: null,
    },
  ];
}

async function checkAuthentication() {
  clearRows();
  const cases = authCases();
  const from = captureLength();
  const before = Date.now();
  for (const [i, item] of cases.entries()) {
    item.service = `auth-${runTag}-${i}`;
    const body = simpleBody(item.service, { timeMs: BASE_MS, ...item.body });
    item.answer = await post('/v1/metrics', body, { authorization: item.authorization });
  }
  await settle(tokenA);
  const after = Date.now();
  const rows = storedRows(`auth-${runTag}-%`);
  for (const item of cases) {
    const stored = rows.filter((row) => row.service === item.service).map((row) => row.tenant_id);
    const expectedRows = item.tenant ? [item.tenant] : [];
    const pass = item.answer.status === item.status && sameList(stored, expectedRows);
    pathTables.auth.push({ ...item, stored, pass });
    record(
      1,
      'required',
      `auth: ${item.name}`,
      `HTTP ${item.status}, rows for ${item.tenant ?? 'nobody'}`,
      `HTTP ${item.answer.status}, rows for ${stored.join(',') || 'nobody'}`,
      pass,
    );
  }
  const noTenant = writerSaw(cases.at(-1).service, from);
  const reached = noTenant.accepted.length + noTenant.refused.length;
  record(
    1,
    'required',
    'a resource without a tenant is dropped in the collector, before the writer',
    '0 metrics at the writer',
    `${reached} metrics at the writer`,
    cases.at(-1).answer.status === 200 && reached === 0,
  );
  const rowsOfB = rows.filter((row) => row.tenant_id === TENANT_B).map((row) => row.service);
  record(
    1,
    'required',
    'rows of tenant B come only from the token of B',
    cases[1].service,
    rowsOfB.join(','),
    sameList(rowsOfB, [cases[1].service]),
  );

  const spoofed = writerSaw(cases[2].service, from).accepted[0]?.resource ?? {};
  const tokenId = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url')).jti;
  record(
    1,
    'required',
    'token ID carried to the writer, forged value replaced',
    tokenId,
    spoofed['usage_signals.token_id'],
    spoofed['usage_signals.token_id'] === tokenId,
  );
  const receivedMs = Number(spoofed['usage_signals.received_at_unix_nano']) / 1e6;
  record(
    1,
    'required',
    'time of receipt stamped by the collector',
    `between ${before} and ${after} ms`,
    Math.round(receivedMs),
    receivedMs >= before && receivedMs <= after,
  );

  const refused = await headersOnly(undefined);
  record(
    1,
    'required',
    'no token, headers sent and body withheld',
    'HTTP/1.1 401 Unauthorized',
    refused,
    refused === 'HTTP/1.1 401 Unauthorized',
  );
  const waiting = await headersOnly(`Bearer ${tokenA}`);
  record(
    1,
    'control',
    'valid token, headers sent and body withheld: the server waits for the body',
    'no answer',
    waiting ?? 'no answer',
    waiting === null,
  );
}

// ---------------------------------------------------------------- 2. the filter and the mapping

function mixBody(service) {
  const stableDurations = [0.004, 0.03, 0.2];
  const legacyDurationsMs = [3, 40, 800, 12000];
  const at = (attrs, durations, bounds) =>
    histogramPoint({ attrs, durations, bounds, timeMs: BASE_MS });
  const stableAttrs = {
    'http.route': '/mix/stable',
    'http.request.method': 'GET',
    'http.response.status_code': 200,
    'server.address': 'api.example.org',
    'url.scheme': 'https',
  };
  const legacyAttrs = {
    'http.target': '/mix/legacy/42?page=2',
    'http.method': 'POST',
    'http.status_code': 503,
    'net.host.name': 'api.example.org',
    'http.flavor': '1.1',
  };
  const number = { asDouble: 1, timeUnixNano: `${BigInt(BASE_MS) * 1_000_000n}` };
  const exponential = {
    timeUnixNano: number.timeUnixNano,
    count: '1',
    sum: 0.1,
    scale: 0,
    zeroCount: '0',
    positive: { offset: 0, bucketCounts: ['1'] },
    negative: { offset: 0, bucketCounts: [] },
  };
  const metrics = [
    histogramMetric(STABLE, 's', [at(stableAttrs, stableDurations, BOUNDS_S)]),
    histogramMetric(LEGACY, 'ms', [at(legacyAttrs, legacyDurationsMs, BOUNDS_MS)]),
    histogramMetric('http.client.request.duration', 's', [
      at(
        { 'http.request.method': 'GET', 'server.address': 'horizon.example.org' },
        [0.1],
        BOUNDS_S,
      ),
    ]),
    histogramMetric('db.client.operation.duration', 's', [
      at({ 'db.system.name': 'postgresql' }, [0.1], BOUNDS_S),
    ]),
    histogramMetric(STABLE, 'ms', [at(stableAttrs, [5], BOUNDS_MS)]),
    {
      name: 'process.cpu.time',
      unit: 's',
      sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints: [number] },
    },
    {
      name: 'http.server.active_requests',
      unit: '{request}',
      sum: { aggregationTemporality: DELTA, isMonotonic: false, dataPoints: [number] },
    },
    { name: STABLE, unit: 's', gauge: { dataPoints: [number] } },
    {
      name: STABLE,
      unit: 's',
      exponentialHistogram: { aggregationTemporality: DELTA, dataPoints: [exponential] },
    },
  ];
  const body = {
    resourceMetrics: [resourceMetrics({ 'service.name': service, 'host.name': 'node-1' }, metrics)],
  };
  return { body, stableDurations, legacyDurationsMs };
}

function expectedPoint(durations, bounds, toSeconds) {
  const buckets = new Array(bounds.length + 1).fill(0);
  for (const duration of durations) buckets[bucketIndex(duration, bounds)] += 1;
  return {
    count: durations.length,
    sum: sum(durations) * toSeconds,
    min: Math.min(...durations) * toSeconds,
    max: Math.max(...durations) * toSeconds,
    buckets,
  };
}

function pointMatches(seen, expected) {
  return (
    Boolean(seen) &&
    seen.count === expected.count &&
    close(seen.sum, expected.sum) &&
    close(seen.min, expected.min) &&
    close(seen.max, expected.max) &&
    sameList(seen.bucketCounts, expected.buckets) &&
    seen.explicitBounds.length === BOUNDS_S.length &&
    seen.explicitBounds.every((bound, i) => close(bound, BOUNDS_S[i]))
  );
}

const describePoint = (p) =>
  p
    ? `count ${p.count}, sum ${p.sum}, min ${p.min}, max ${p.max}, buckets ${(p.bucketCounts ?? p.buckets).join(' ')}`
    : 'no such point';

async function checkFilter() {
  clearRows();
  const service = `mix-${runTag}`;
  const { body, stableDurations, legacyDurationsMs } = mixBody(service);
  const from = captureLength();
  const answer = await post('/v1/metrics', body, { token: tokenA });
  await settle(tokenA);
  const seen = writerSaw(service, from);
  const all = [...seen.accepted, ...seen.refused];
  const names = [...new Set(all.map((item) => `${item.metric} [${item.unit}]`))];
  record(
    2,
    'required',
    'mixed request answered',
    'HTTP 200',
    `HTTP ${answer.status}`,
    answer.status === 200,
  );
  record(
    2,
    'required',
    'metrics that reach the writer, of 9 sent',
    `${STABLE} [s], 2 points`,
    `${names.join(', ')}, ${all.length} points`,
    sameList(names, [`${STABLE} [s]`]) && all.length === 2 && seen.refused.length === 0,
  );

  const stable = seen.accepted.find((point) => point.attributes['http.route'] === '/mix/stable');
  const expectedStable = expectedPoint(stableDurations, BOUNDS_S, 1);
  record(
    2,
    'required',
    'stable metric passes unchanged',
    describePoint(expectedStable),
    describePoint(stable),
    pointMatches(stable, expectedStable),
  );

  const legacy = seen.accepted.find(
    (point) => point.attributes['http.route'] === '/mix/legacy/{id}',
  );
  const expectedLegacy = expectedPoint(legacyDurationsMs, BOUNDS_MS, 0.001);
  record(
    2,
    'required',
    'older metric rescaled from ms to s',
    describePoint(expectedLegacy),
    describePoint(legacy),
    pointMatches(legacy, expectedLegacy),
  );
  const expectedAttrs = JSON.stringify({
    'http.request.method': 'POST',
    'http.response.status_code': 503,
    'http.route': '/mix/legacy/{id}',
  });
  const legacyAttrs = JSON.stringify(
    Object.fromEntries(Object.entries(legacy?.attributes ?? {}).sort()),
  );
  record(
    2,
    'required',
    'older attribute names mapped, others deleted',
    expectedAttrs,
    legacyAttrs,
    legacyAttrs === expectedAttrs,
  );
  const resourceKeys = Object.keys(stable?.resource ?? {})
    .sort()
    .join(', ');
  const allowedKeys = [
    'service.name',
    'tenant.id',
    'usage_signals.received_at_unix_nano',
    'usage_signals.token_id',
  ].join(', ');
  record(
    5,
    'required',
    'resource attributes outside the allowlist deleted (host.name was sent)',
    allowedKeys,
    resourceKeys,
    resourceKeys === allowedKeys,
  );

  await useConfig('no-filter');
  const controlService = `mix-nofilter-${runTag}`;
  const controlFrom = captureLength();
  await post('/v1/metrics', mixBody(controlService).body, { token: tokenA });
  await settle(tokenA);
  const control = writerSaw(controlService, controlFrom);
  const controlNames = new Set(
    [...control.accepted, ...control.refused].map((item) => item.metric),
  );
  const leaked = [
    'process.cpu.time',
    'http.client.request.duration',
    'db.client.operation.duration',
  ].filter((name) => controlNames.has(name));
  record(
    2,
    'control',
    'filter removed: unrelated and client-side metrics reach the writer',
    '3 of 3 named metrics',
    `${leaked.length} of 3 (${leaked.join(', ')})`,
    leaked.length === 3,
  );
  await useConfig('design');
}

// ---------------------------------------------------------------- 3. traces and logs

function traceBody(marker) {
  const span = {
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: 'eee19b7ec3c1b174',
    name: marker,
    kind: 2,
    startTimeUnixNano: `${BigInt(BASE_MS) * 1_000_000n}`,
    endTimeUnixNano: `${BigInt(BASE_MS + 5) * 1_000_000n}`,
    attributes: attributes({ 'http.route': `/traced/${marker}` }),
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ 'service.name': marker }) },
        scopeSpans: [{ scope: { name: 'check-05' }, spans: [span] }],
      },
    ],
  };
}

function logBody(marker) {
  const logRecord = {
    timeUnixNano: `${BigInt(BASE_MS) * 1_000_000n}`,
    severityText: 'INFO',
    body: { stringValue: marker },
  };
  return {
    resourceLogs: [
      {
        resource: { attributes: attributes({ 'service.name': marker }) },
        scopeLogs: [{ scope: { name: 'check-05' }, logRecords: [logRecord] }],
      },
    ],
  };
}

async function checkDiscard() {
  clearRows();
  const markers = {
    span: `span-marker-${runTag}`,
    log: `log-marker-${runTag}`,
    metric: `queued-marker-${runTag}`,
  };
  const rawAddress = strkey('G', 77);
  // The writer answers 503, so whatever the collector queued stays on its disk.
  setWriterMode('503');
  const from = captureLength();
  const traces = await post('/v1/traces', traceBody(markers.span), { token: tokenA });
  const logs = await post('/v1/logs', logBody(markers.log), { token: tokenA });
  const metrics = await post(
    '/v1/metrics',
    simpleBody(markers.metric, { count: 7, route: `/accounts/${rawAddress}`, timeMs: BASE_MS }),
    { token: tokenA },
  );
  record(
    3,
    'required',
    'traces from a valid tenant are answered',
    'HTTP 200',
    `HTTP ${traces.status}`,
    traces.status === 200,
  );
  record(
    3,
    'required',
    'logs from a valid tenant are answered',
    'HTTP 200',
    `HTTP ${logs.status}`,
    logs.status === 200,
  );
  const unauthenticated = await post('/v1/traces', traceBody(markers.span));
  record(
    3,
    'required',
    'traces without a token are refused',
    'HTTP 401',
    `HTTP ${unauthenticated.status}`,
    unauthenticated.status === 401,
  );
  await waitFor('the writer to refuse the queued batch', () =>
    capture(from).some((entry) => entry.outcome === 'answered-503'),
  );
  await sleep(1500);

  record(
    3,
    'control',
    'the queue scan finds the metric sent in the same second',
    'found',
    queueHolds(markers.metric) ? 'found' : 'absent',
    metrics.status === 200 && queueHolds(markers.metric),
  );
  record(
    3,
    'required',
    'span name in the queue directory',
    'absent',
    queueHolds(markers.span) ? 'found' : 'absent',
    !queueHolds(markers.span),
  );
  record(
    3,
    'required',
    'log body in the queue directory',
    'absent',
    queueHolds(markers.log) ? 'found' : 'absent',
    !queueHolds(markers.log),
  );
  record(
    4,
    'required',
    'raw address in the queue directory (normalized route is there)',
    'raw absent, /accounts/{account} found',
    `raw ${queueHolds(rawAddress) ? 'found' : 'absent'}, /accounts/{account} ${queueHolds('/accounts/{account}') ? 'found' : 'absent'}`,
    !queueHolds(rawAddress) && queueHolds('/accounts/{account}'),
  );
  record(
    3,
    'required',
    'rows stored while the writer answers 503',
    0,
    storedRows().length,
    storedRows().length === 0,
  );

  setWriterMode('ok');
  await waitFor('the queued metric', () => storedRows(markers.metric).length > 0);
  await settle(tokenA);
  const dump = databaseDump();
  const count = sum(storedRows(markers.metric).map((row) => row.request_count));
  record(
    7,
    'required',
    'batch kept while the writer answered 503, stored once afterwards',
    7,
    count,
    count === 7,
  );
  record(
    3,
    'control',
    'the database dump finds the metric',
    'found',
    dump.includes(markers.metric) ? 'found' : 'absent',
    dump.includes(markers.metric),
  );
  record(
    3,
    'required',
    'span name and log body in the database dump',
    'absent, absent',
    `${dump.includes(markers.span) ? 'found' : 'absent'}, ${dump.includes(markers.log) ? 'found' : 'absent'}`,
    !dump.includes(markers.span) && !dump.includes(markers.log),
  );

  await useConfig('no-discard-pipelines');
  const without = await post('/v1/traces', traceBody(markers.span), { token: tokenA });
  record(
    3,
    'control',
    'no-op pipelines removed: a tenant sending traces gets an error',
    'HTTP 404',
    `HTTP ${without.status}`,
    without.status === 404,
  );
  await useConfig('design');
}

// ---------------------------------------------------------------- 4. path rules

function vectorRequests(prefix) {
  const resources = VECTORS.flatMap((vector, i) => {
    const stablePoint = histogramPoint({
      attrs: {
        'http.route': vector.raw,
        'http.request.method': 'GET',
        'http.response.status_code': 200,
      },
      durations: [0.02],
      bounds: BOUNDS_S,
      timeMs: BASE_MS,
    });
    const legacyPoint = histogramPoint({
      attrs: { 'http.target': vector.raw, 'http.method': 'GET', 'http.status_code': 200 },
      durations: [20],
      bounds: BOUNDS_MS,
      timeMs: BASE_MS,
    });
    return [
      resourceMetrics({ 'service.name': `${prefix}-route-${i}` }, [
        histogramMetric(STABLE, 's', [stablePoint]),
      ]),
      resourceMetrics({ 'service.name': `${prefix}-target-${i}` }, [
        histogramMetric(LEGACY, 'ms', [legacyPoint]),
      ]),
    ];
  });
  const requests = [];
  for (let i = 0; i < resources.length; i += 40)
    requests.push({ resourceMetrics: resources.slice(i, i + 40) });
  return requests;
}

async function storedRoutes(prefix) {
  clearRows();
  for (const body of vectorRequests(prefix)) {
    const answer = await post('/v1/metrics', body, { token: tokenA });
    if (answer.status !== 200)
      throw new Error(`vector request answered ${answer.status}: ${answer.text}`);
  }
  await settle(tokenA);
  const routes = new Map();
  for (const row of storedRows(`${prefix}-%`)) {
    routes.set(row.service, [...(routes.get(row.service) ?? []), row.route]);
  }
  const one = (service) =>
    routes.get(service)?.length === 1
      ? routes.get(service)[0]
      : `(${routes.get(service)?.length ?? 0} rows)`;
  return VECTORS.map((_, i) => ({
    viaRoute: one(`${prefix}-route-${i}`),
    viaTarget: one(`${prefix}-target-${i}`),
  }));
}

async function checkPathRules() {
  const observed = await storedRoutes(`vec-${runTag}`);
  let passed = 0;
  for (const [i, vector] of VECTORS.entries()) {
    const pass =
      observed[i].viaRoute === vector.expected && observed[i].viaTarget === vector.expected;
    passed += pass ? 1 : 0;
    pathTables.vectors.push({ ...vector, ...observed[i], pass });
  }
  record(
    4,
    'required',
    `path vectors, each sent as http.route and as http.target`,
    `${VECTORS.length} of ${VECTORS.length}`,
    `${passed} of ${VECTORS.length}`,
    passed === VECTORS.length,
  );

  await useConfig('no-path-rules');
  const raw = await storedRoutes(`vecraw-${runTag}`);
  const changing = VECTORS.map((vector, i) => ({ vector, seen: raw[i] })).filter(
    ({ vector }) => vector.expected !== vector.raw,
  );
  const stillRaw = changing.filter(
    ({ vector, seen }) => seen.viaRoute === vector.raw && seen.viaTarget === vector.raw,
  );
  record(
    4,
    'control',
    'path rules removed: the raw path is stored',
    `${changing.length} of ${changing.length} rewritten vectors arrive raw`,
    `${stillRaw.length} of ${changing.length}`,
    changing.length > 0 && stillRaw.length === changing.length,
  );
  await useConfig('design');
}

// ---------------------------------------------------------------- 5. allowlist and merge

const MERGE_POINTS = [
  {
    route: '/orders/1',
    status: 200,
    extra: { 'server.address': 'a.example.org' },
    durations: [0.004, 0.03],
    minute: 0,
    minMax: true,
  },
  {
    route: '/orders/2',
    status: 200,
    extra: { 'server.address': 'b.example.org' },
    durations: [0.3, 7, 20],
    minute: 0,
    minMax: true,
  },
  {
    route: '/orders/{id}',
    status: 200,
    extra: { 'user_agent.original': 'curl/8' },
    durations: [0.0005],
    minute: 0,
    minMax: true,
  },
  { route: '/orders/3', status: 404, extra: {}, durations: [0.06, 0.09], minute: 0, minMax: true },
  { route: '/orders/4', status: 200, extra: {}, durations: [0.4], minute: 1, minMax: true },
  { route: '/orders/5', status: 200, extra: {}, durations: [0.008, 2], minute: 0, minMax: false },
];

function mergeBody(service, temporality = DELTA) {
  const points = MERGE_POINTS.map((item) =>
    histogramPoint({
      attrs: {
        'http.route': item.route,
        'http.request.method': 'GET',
        'http.response.status_code': item.status,
        ...item.extra,
      },
      durations: item.durations,
      bounds: BOUNDS_S,
      timeMs: BASE_MS + item.minute * 60_000,
      withMinMax: item.minMax,
    }),
  );
  return {
    resourceMetrics: [
      resourceMetrics({ 'service.name': service }, [
        histogramMetric(STABLE, 's', points, temporality),
      ]),
    ],
  };
}

/** Groups the sent points by a key and gives the durations of each group. */
function groupDurations(keyOf) {
  const groups = new Map();
  for (const item of MERGE_POINTS)
    groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), ...item.durations]);
  return groups;
}

function checkMergedRows(point, label, service) {
  const expected = groupDurations((item) => `${item.status}|${minuteOf(BASE_MS) + item.minute}`);
  const rows = storedRows(service);
  const good =
    rows.length === expected.size &&
    rows.every((row) => {
      const durations = expected.get(`${row.status_code}|${row.minute}`);
      if (!durations || row.route !== '/orders/{id}') return false;
      const want = expectedPoint(durations, BOUNDS_S, 1000);
      return (
        row.request_count === want.count &&
        close(row.duration_sum_ms, want.sum) &&
        sameList(row.bucket_counts, want.buckets)
      );
    });
  const text = (count, total) => `${count} rows, ${total} requests`;
  record(
    point,
    'required',
    label,
    text(expected.size, sum(MERGE_POINTS.map((item) => item.durations.length))),
    text(rows.length, sum(rows.map((row) => row.request_count))),
    good,
  );
}

async function checkMerge() {
  clearRows();
  const service = `merge-${runTag}`;
  const from = captureLength();
  await post('/v1/metrics', mergeBody(service), { token: tokenA });
  await settle(tokenA);
  const seen = writerSaw(service, from).accepted;
  // Upstream combines points that share attributes, timestamps and the presence of min and max.
  const expected = groupDurations((item) => `${item.status}|${item.minute}|${item.minMax}`);
  record(
    5,
    'required',
    `${MERGE_POINTS.length} points sent, points that reach the writer`,
    expected.size,
    seen.length,
    seen.length === expected.size,
  );
  const merged = seen.find(
    (point) =>
      point.attributes['http.response.status_code'] === 200 &&
      point.min !== undefined &&
      minuteOf(Number(BigInt(point.timeUnixNano) / 1_000_000n)) === minuteOf(BASE_MS),
  );
  const want = expectedPoint(expected.get('200|0|true'), BOUNDS_S, 1);
  record(
    5,
    'required',
    'three points that became identical are one point with added numbers',
    describePoint(want),
    describePoint(merged),
    pointMatches(merged, want),
  );
  const bare = seen.find((point) => point.min === undefined);
  const wantBare = expectedPoint(expected.get('200|0|false'), BOUNDS_S, 1);
  const bareGood =
    Boolean(bare) &&
    bare.max === undefined &&
    bare.count === wantBare.count &&
    close(bare.sum, wantBare.sum) &&
    sameList(bare.bucketCounts, wantBare.buckets);
  record(
    5,
    'required',
    'a point without min and max is kept apart and gains none',
    `count ${wantBare.count}, no min, no max`,
    bare ? `count ${bare.count}, min ${bare.min}, max ${bare.max}` : 'no such point',
    bareGood,
  );
  const keys = [...new Set(seen.flatMap((point) => Object.keys(point.attributes)))]
    .sort()
    .join(', ');
  record(
    5,
    'required',
    'point attributes that reach the writer',
    'http.request.method, http.response.status_code, http.route',
    keys,
    keys === 'http.request.method, http.response.status_code, http.route',
  );
  checkMergedRows(5, 'rows after the writer adds what the collector left apart', service);

  const cumulativeService = `merge-cumulative-${runTag}`;
  const cumulativeFrom = captureLength();
  await post('/v1/metrics', mergeBody(cumulativeService, CUMULATIVE), { token: tokenA });
  await settle(tokenA);
  const cumulative = writerSaw(cumulativeService, cumulativeFrom);
  const reasons = [...new Set(cumulative.refused.map((item) => item.reason))].join(', ');
  record(
    9,
    'required',
    'cumulative histogram: refused by the writer, nothing stored',
    'refused: temporality is not delta; 0 rows',
    `refused: ${reasons || 'nothing'}; ${storedRows(cumulativeService).length} rows`,
    reasons === 'temporality is not delta' &&
      cumulative.accepted.length === 0 &&
      storedRows(cumulativeService).length === 0,
  );
  record(
    9,
    'finding',
    'the collector accepts a cumulative histogram and passes it on',
    'writer is reached',
    cumulative.refused.length > 0 ? 'writer is reached' : 'writer is not reached',
    cumulative.refused.length > 0,
  );

  await useConfig('no-merge');
  clearRows();
  const controlService = `merge-off-${runTag}`;
  const controlFrom = captureLength();
  await post('/v1/metrics', mergeBody(controlService), { token: tokenA });
  await settle(tokenA);
  const unmerged = writerSaw(controlService, controlFrom).accepted;
  record(
    5,
    'control',
    'merge statement removed: every point reaches the writer',
    MERGE_POINTS.length,
    unmerged.length,
    unmerged.length === MERGE_POINTS.length,
  );
  checkMergedRows(
    5,
    'merge statement removed: the writer alone produces the same rows',
    controlService,
  );
  await useConfig('design');
}

// ---------------------------------------------------------------- 6. limits

function paddedBody(service, padBytes) {
  const body = simpleBody(service, { timeMs: BASE_MS });
  body.resourceMetrics[0].resource.attributes.push({
    key: 'padding',
    value: { stringValue: 'x'.repeat(padBytes) },
  });
  return body;
}

const RETRYABLE = [429, 502, 503, 504];
const exporterView = (status) =>
  status === 200
    ? 'success'
    : RETRYABLE.includes(status)
      ? 'retryable'
      : 'not retryable, the batch is dropped';

async function checkLimits() {
  clearRows();
  const cap = 1_048_576;
  const tag = `cap-${runTag}`;
  const under = await post('/v1/metrics', paddedBody(`${tag}-under`, 600_000), { token: tokenA });
  const over = await post('/v1/metrics', paddedBody(`${tag}-over`, 2 * cap), { token: tokenA });
  const overGzip = await post('/v1/metrics', paddedBody(`${tag}-overgzip`, 2 * cap), {
    token: tokenA,
    gzip: true,
  });
  const smallGzip = await post('/v1/metrics', paddedBody(`${tag}-smallgzip`, 1000), {
    token: tokenA,
    gzip: true,
  });
  await settle(tokenA);
  const stored = (name) => storedRows(`${tag}-${name}`).length;
  record(
    6,
    'control',
    `body of ${under.bytes} bytes, under the cap of ${cap}`,
    'HTTP 200, 1 row',
    `HTTP ${under.status}, ${stored('under')} row`,
    under.status === 200 && stored('under') === 1,
  );
  record(
    6,
    'required',
    `body of ${over.bytes} bytes, over the cap`,
    'refused, 0 rows',
    `HTTP ${over.status} ${over.text.trim()}, ${stored('over')} rows`,
    over.status >= 400 && stored('over') === 0,
  );
  record(
    6,
    'required',
    `gzip body of ${overGzip.bytes} bytes that inflates over the cap`,
    'refused, 0 rows',
    `HTTP ${overGzip.status} ${overGzip.text.trim()}, ${stored('overgzip')} rows`,
    overGzip.bytes < cap && overGzip.status >= 400 && stored('overgzip') === 0,
  );
  record(
    6,
    'control',
    'small gzip body',
    'HTTP 200, 1 row',
    `HTTP ${smallGzip.status}, ${stored('smallgzip')} row`,
    smallGzip.status === 200 && stored('smallgzip') === 1,
  );
  record(
    6,
    'finding',
    'what the exporter sees for an oversized body',
    'HTTP 400: not retryable, the batch is dropped',
    `HTTP ${over.status}: ${exporterView(over.status)}`,
    over.status === 400 && overGzip.status === 400,
  );

  await useConfig('tiny-memory-limit');
  await sleep(2500);
  const limited = await post('/v1/metrics', simpleBody(`${tag}-memory`, { timeMs: BASE_MS }), {
    token: tokenA,
  });
  await sleep(1000);
  record(
    6,
    'required',
    'memory limiter over its limit (limit forced to 2 MiB)',
    'refused, 0 rows',
    `HTTP ${limited.status} ${limited.text.trim()}, ${stored('memory')} rows`,
    limited.status >= 400 && stored('memory') === 0,
  );
  record(
    6,
    'finding',
    'what the exporter sees from the memory limiter',
    'HTTP 503: retryable',
    `HTTP ${limited.status}: ${exporterView(limited.status)}`,
    limited.status === 503,
  );
  await useConfig('design');
}

// ---------------------------------------------------------------- 7. the disk queue

const queueRandom = seededRandom(7);

async function sendCounted(service) {
  const random = queueRandom;
  let accepted = 0;
  for (let i = 0; i < 20; i += 1) {
    const count = 1 + Math.floor(random() * 9);
    const answer = await post(
      '/v1/metrics',
      simpleBody(service, { count, route: '/queued', timeMs: BASE_MS }),
      { token: tokenA },
    );
    if (answer.status === 200) accepted += count;
  }
  return accepted;
}

async function arrivesOnce(label, service, accepted) {
  const total = () => sum(storedRows(service).map((row) => row.request_count));
  await waitFor(`${label}: the queued requests`, () => total() >= accepted, 60_000).catch(() => {});
  // Longer than the longest retry interval, so a second delivery would show.
  await sleep(4000);
  record(
    7,
    'required',
    `${label}: requests stored after the writer returns`,
    accepted,
    total(),
    accepted > 0 && total() === accepted,
  );
}

async function queueCase(label, betweenSendAndWriter) {
  clearRows();
  const service = `queue-${label.replaceAll(' ', '-')}-${runTag}`;
  compose('stop', 'writer');
  const accepted = await sendCounted(service);
  await sleep(1500);
  const onDisk = queueHolds(service);
  const rowsWhileDown = storedRows(service).length;
  record(
    7,
    'required',
    `${label}: accepted with the writer stopped, on disk, not stored`,
    'on disk, 0 rows',
    `${onDisk ? 'on disk' : 'not on disk'}, ${rowsWhileDown} rows`,
    accepted > 0 && onDisk && rowsWhileDown === 0,
  );
  await betweenSendAndWriter();
  await startWriter();
  await arrivesOnce(label, service, accepted);
}

async function restartCollector(stopCommand) {
  compose(stopCommand, 'collector');
  compose('start', 'collector');
  await waitFor(
    'the collector after its restart',
    async () =>
      (await post('/v1/logs', logBody('ready'), { token: tokenA }).catch(() => ({}))).status ===
      200,
  );
}

async function checkQueue() {
  record(
    7,
    'required',
    'files in the queue directory',
    'exporter_otlp_http_writer_metrics',
    queueFiles().join(', '),
    sameList(queueFiles(), ['exporter_otlp_http_writer_metrics']),
  );
  await queueCase('writer stopped', async () => {});
  await queueCase('collector stopped and started', () => restartCollector('stop'));
  await queueCase('collector killed and started', () => restartCollector('kill'));
}

// ---------------------------------------------------------------- 8. end to end

const TEMPLATES = [
  { route: '/users/{id}', raw: (r) => `/users/${Math.floor(r() * 1e6)}` },
  {
    route: '/tx/{hash}',
    raw: (r) =>
      `/tx/${Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')}`,
  },
  {
    route: '/accounts/{account}/payments',
    raw: (r) => `/accounts/${strkey('G', Math.floor(r() * 1e6))}/payments`,
  },
  {
    route: '/contracts/{contract}',
    raw: (r) => `/contracts/${strkey('C', Math.floor(r() * 1e6))}/`,
  },
  { route: '/orders/{uuid}', raw: () => `/orders/${randomUUID()}` },
  { route: '/v2/health', raw: () => '/v2/health' },
];
const pick = (random, list) => list[Math.floor(random() * list.length)];

/** Individual requests, as the tenants' services would have served them. */
function simulateRequests(total, seed) {
  const random = seededRandom(seed);
  return Array.from({ length: total }, () => {
    const template = pick(random, TEMPLATES);
    const tenant = pick(random, [TENANT_A, TENANT_B]);
    const service = pick(random, ['api', 'rpc']);
    return {
      tenant,
      service: `e2e-${service}`,
      legacy: service === 'rpc',
      instance: `${service}-${pick(random, [1, 2])}`,
      minute: minuteOf(BASE_MS) + pick(random, [0, 1, 2]),
      route: template.route,
      raw: template.raw(random),
      method: pick(random, ['GET', 'POST']),
      status: pick(random, [200, 200, 200, 404, 500]),
      // Whole milliseconds from 1 ms to about 20 s, most of them short.
      durationMs: Math.max(1, Math.round(Math.exp(random() * 9.9))),
    };
  });
}

/** What the tenants' SDKs would export: one request per tenant, instance and minute. */
function exportsOf(requests) {
  const exports = new Map();
  for (const request of requests) {
    const exportKey = `${request.tenant}|${request.instance}|${request.minute}`;
    if (!exports.has(exportKey)) exports.set(exportKey, { request, points: new Map() });
    const points = exports.get(exportKey).points;
    const pointKey = `${request.raw}|${request.method}|${request.status}`;
    if (!points.has(pointKey)) points.set(pointKey, { request, durations: [] });
    points.get(pointKey).durations.push(request.durationMs);
  }
  return [...exports.values()].map(({ request, points }) => {
    const dataPoints = [...points.values()].map((point) => {
      const names = request.legacy
        ? {
            'http.target': `${point.request.raw}?cursor=1`,
            'http.method': point.request.method,
            'http.status_code': point.request.status,
          }
        : {
            'http.route': point.request.raw,
            'http.request.method': point.request.method,
            'http.response.status_code': point.request.status,
          };
      const durations = request.legacy ? point.durations : point.durations.map((ms) => ms / 1000);
      return histogramPoint({
        attrs: { ...names, 'server.address': 'api.example.org' },
        durations,
        bounds: request.legacy ? BOUNDS_MS : BOUNDS_S,
        timeMs: request.minute * 60_000 + 30_000,
      });
    });
    const metric = request.legacy
      ? histogramMetric(LEGACY, 'ms', dataPoints)
      : histogramMetric(STABLE, 's', dataPoints);
    // Every tenant claims to be the other one; only the token may decide.
    const claimed = request.tenant === TENANT_A ? TENANT_B : TENANT_A;
    const resource = {
      'service.name': request.service,
      'service.instance.id': request.instance,
      'tenant.id': claimed,
    };
    return {
      tenant: request.tenant,
      body: { resourceMetrics: [resourceMetrics(resource, [metric])] },
    };
  });
}

function expectedRows(requests) {
  const rows = new Map();
  for (const request of requests) {
    const rowKey = [
      request.tenant,
      request.minute,
      request.service,
      request.route,
      request.method,
      request.status,
    ].join('|');
    if (!rows.has(rowKey))
      rows.set(rowKey, { count: 0, sumMs: 0, buckets: new Array(BOUNDS_MS.length + 1).fill(0) });
    const row = rows.get(rowKey);
    row.count += 1;
    row.sumMs += request.durationMs;
    row.buckets[bucketIndex(request.durationMs, BOUNDS_MS)] += 1;
  }
  return rows;
}

/** Waits, without failing, until the rows of a service hold a number of requests. */
function storedAtLeast(servicePattern, requests) {
  const total = () => sum(storedRows(servicePattern).map((row) => row.request_count));
  return waitFor('the stored requests', () => total() >= requests, 30_000).catch(() => {});
}

async function checkEndToEnd() {
  clearRows();
  const total = 6000;
  const requests = simulateRequests(total, 20261119);
  const exports = exportsOf(requests);
  for (const [i, item] of exports.entries()) {
    const answer = await post('/v1/metrics', item.body, {
      token: item.tenant === TENANT_A ? tokenA : tokenB,
      gzip: i % 2 === 0,
    });
    if (answer.status !== 200)
      throw new Error(`export ${i} answered ${answer.status}: ${answer.text}`);
  }
  await storedAtLeast('e2e-%', total);
  await settle(tokenA);
  const expected = expectedRows(requests);
  const rows = storedRows('e2e-%');
  let matching = 0;
  for (const row of rows) {
    const want = expected.get(
      [row.tenant_id, row.minute, row.service, row.route, row.method, row.status_code].join('|'),
    );
    if (
      want &&
      row.request_count === want.count &&
      close(row.duration_sum_ms, want.sumMs) &&
      sameList(row.bucket_counts, want.buckets)
    )
      matching += 1;
  }
  const stored = sum(rows.map((row) => row.request_count));
  record(
    8,
    'required',
    `hand-written exports: ${total} requests in ${exports.length} OTLP requests`,
    `${total} requests`,
    `${stored} requests`,
    stored === total,
  );
  record(
    8,
    'required',
    'rows equal per tenant, service, route, method, status and minute (count, sum, buckets)',
    `${expected.size} of ${expected.size} rows`,
    `${matching} of ${rows.length} rows`,
    rows.length === expected.size && matching === expected.size,
  );
  for (const tenant of [TENANT_A, TENANT_B]) {
    const want = requests.filter((request) => request.tenant === tenant).length;
    const have = sum(
      rows.filter((row) => row.tenant_id === tenant).map((row) => row.request_count),
    );
    record(
      8,
      'required',
      `requests of tenant ${tenant === TENANT_A ? 'A' : 'B'}, who claimed to be the other`,
      want,
      have,
      want === have,
    );
  }
}

// ---------------------------------------------------------------- 8b. a real exporter

const REAL_ADDRESS = strkey('G', 4242);
const REAL_PLAN = [
  {
    method: 'GET',
    path: (i) => `/users/${1000 + i}`,
    times: 120,
    route: '/users/{id}',
    status: 200,
  },
  {
    method: 'DELETE',
    path: (i) => `/users/${1000 + i}`,
    times: 30,
    route: '/users/{id}',
    status: 500,
  },
  { method: 'GET', path: () => '/health', times: 60, route: '/health', status: 200 },
  {
    method: 'GET',
    path: () => `/accounts/${REAL_ADDRESS}/`,
    times: 45,
    route: '/accounts/{account}',
    status: 200,
  },
  { method: 'GET', path: (i) => `/nowhere/${i}`, times: 25, route: '(unmatched)', status: 200 },
];

/** Starts service.cjs, sends it the planned HTTP requests, and stops it so that it flushes. */
async function driveRealService(serviceName, temporality, plan) {
  const env = {
    ...process.env,
    CHECK_TEMPORALITY: temporality,
    CHECK_COLLECTOR: COLLECTOR,
    CHECK_TOKEN: tokenB,
    CHECK_SERVICE_NAME: serviceName,
  };
  const child = spawn(process.execPath, [path.join(HERE, 'service.cjs')], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [firstLine] = await once(child.stdout, 'data');
  const port = Number(String(firstLine).trim().split(' ')[1]);
  const calls = plan.flatMap((item) => Array.from({ length: item.times }, (_, i) => ({ item, i })));
  const statuses = [];
  for (const [n, { item, i }] of calls.entries()) {
    const response = await fetch(`http://127.0.0.1:${port}${item.path(i)}`, {
      method: item.method,
    });
    statuses.push(response.status === item.status);
    await response.arrayBuffer();
    // Spread over several export intervals of one second.
    if (n % 20 === 19) await sleep(250);
  }
  child.kill('SIGTERM');
  await once(child, 'exit');
  return { sent: calls.length, answeredAsPlanned: statuses.filter(Boolean).length };
}

async function checkRealExporter() {
  clearRows();
  const service = `real-${runTag}`;
  const from = captureLength();
  const { sent, answeredAsPlanned } = await driveRealService(service, 'delta', REAL_PLAN);
  await storedAtLeast(service, sent);
  await settle(tokenA);
  const expected = new Map(
    REAL_PLAN.map((item) => [`${item.route}|${item.method}|${item.status}`, item.times]),
  );
  const observed = new Map();
  const rows = storedRows(service);
  for (const row of rows) {
    const rowKey = `${row.route}|${row.method}|${row.status_code}`;
    observed.set(rowKey, (observed.get(rowKey) ?? 0) + row.request_count);
  }
  const equal =
    observed.size === expected.size &&
    [...expected].every(([rowKey, count]) => observed.get(rowKey) === count);
  const text = (map) =>
    [...map]
      .sort()
      .map(([rowKey, count]) => `${rowKey}=${count}`)
      .join('; ');
  record(
    8,
    'required',
    `Node.js SDK exporter: ${sent} real HTTP requests, summed over minutes`,
    text(expected),
    text(observed),
    answeredAsPlanned === sent && equal,
  );
  const tenants = [...new Set(rows.map((row) => row.tenant_id))];
  record(
    8,
    'required',
    "Node.js SDK exporter: rows belong to the token's tenant",
    TENANT_B,
    tenants.join(','),
    sameList(tenants, [TENANT_B]),
  );
  const consistent = rows.filter((row) => sum(row.bucket_counts) === row.request_count).length;
  record(
    8,
    'required',
    'Node.js SDK exporter: bucket counts add up to the request count in every row',
    `${rows.length} of ${rows.length}`,
    `${consistent} of ${rows.length}`,
    rows.length > 0 && consistent === rows.length,
  );
  const seen = writerSaw(service, from);
  const names = [...new Set([...seen.accepted, ...seen.refused].map((item) => item.metric))].join(
    ', ',
  );
  record(
    2,
    'required',
    'Node.js SDK exporter also records a counter and client-side HTTP metrics: names that reach the writer',
    STABLE,
    names,
    names === STABLE && seen.refused.length === 0,
  );
  const exportsSeen = new Set(seen.accepted.map((point) => point.timeUnixNano)).size;
  record(
    8,
    'control',
    'Node.js SDK exporter sent more than one export interval',
    'more than 1',
    exportsSeen,
    exportsSeen > 1,
  );

  const cumulativeService = `real-cumulative-${runTag}`;
  const cumulativeFrom = captureLength();
  await driveRealService(cumulativeService, 'cumulative', [{ ...REAL_PLAN[2], times: 20 }]);
  await settle(tokenA);
  const cumulative = writerSaw(cumulativeService, cumulativeFrom);
  const stored = storedRows(cumulativeService).length;
  record(
    9,
    'control',
    'Node.js SDK exporter with the default cumulative temporality: refused by the writer',
    'refused, 0 rows',
    `${cumulative.refused.length > 0 ? 'refused' : 'not refused'}, ${stored} rows`,
    cumulative.refused.length > 0 && cumulative.accepted.length === 0 && stored === 0,
  );
}

// ---------------------------------------------------------------- report

const POINTS = {
  1: 'Authentication with per-tenant attribution',
  2: 'Only HTTP server duration histograms continue',
  3: 'Traces and logs never reach storage or a queue',
  4: 'Path rules as collector statements',
  5: 'Attribute allowlist and merge',
  6: 'Body-size cap and memory limiter',
  7: 'Queue on local disk, with retries',
  8: 'End to end',
  9: 'The writer',
};

function printReport() {
  const clip = (text, width = 110) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);
  console.log(
    '\n## Path-rule vectors (expected route stated by hand; observed in api_metric_minute)\n',
  );
  for (const [i, vector] of pathTables.vectors.entries()) {
    const observed =
      vector.viaRoute === vector.viaTarget
        ? vector.viaRoute
        : `route: ${vector.viaRoute} | target: ${vector.viaTarget}`;
    console.log(
      `${vector.pass ? 'ok  ' : 'FAIL'} ${String(i + 1).padStart(2)} [${vector.kind}] ${clip(vector.raw, 80)} -> ${clip(observed, 60)}${vector.pass ? '' : ` (expected ${vector.expected})`}  # ${vector.why}`,
    );
  }
  console.log('\n## Every assertion\n');
  for (const point of Object.keys(POINTS)) {
    console.log(`${point}. ${POINTS[point]}`);
    for (const result of results.filter((item) => String(item.point) === point)) {
      console.log(
        `  ${result.pass ? 'ok  ' : 'FAIL'} [${result.kind}] ${result.label}\n         expected: ${clip(result.expected, 200)}\n         observed: ${clip(result.observed, 200)}`,
      );
    }
  }
}

/** The verdict follows from the recorded results and from nothing else. */
function verdict() {
  const failed = (kind) => results.filter((item) => item.kind === kind && !item.pass);
  const pointsHeld = Object.keys(POINTS).filter((point) => {
    const required = results.filter(
      (item) => String(item.point) === point && item.kind === 'required',
    );
    return required.length > 0 && required.every((item) => item.pass);
  });
  console.log('\n## Verdict\n');
  for (const point of Object.keys(POINTS))
    console.log(
      `${pointsHeld.includes(point) ? 'holds        ' : 'DOES NOT HOLD'} ${point}. ${POINTS[point]}`,
    );
  const findings = results.filter((item) => item.kind === 'finding' && item.pass);
  let text;
  if (pointsHeld.length < Object.keys(POINTS).length) text = 'FAILS';
  else if (findings.length > 0)
    text = 'PASSES WITH STATED CORRECTIONS to the design (README.md gives the sentences)';
  else text = 'PASSES AS WRITTEN';
  console.log(`\nCheck 05: ${text}`);
  for (const finding of findings)
    console.log(`  correction rests on: ${finding.label}: ${finding.observed}`);
  const broken = [...failed('required'), ...failed('control'), ...failed('finding')];
  if (broken.length > 0)
    console.log(`\n${broken.length} assertion(s) differ from what the README states. Exit 1.`);
  return broken.length === 0;
}

async function main() {
  console.log(`scratch directory: ${scratch}`);
  await startStack({ keys: [key.jwk] });
  sql(
    `INSERT INTO usage_signals.tenant (id, name, status) VALUES ('${TENANT_A}', 'check-05 A', 'active'), ('${TENANT_B}', 'check-05 B', 'active')`,
  );
  await useConfig('design');
  const version = compose('exec', '-T', 'collector', '/otelcol-contrib', '--version').trim();
  console.log(`collector: ${version}; issuer and audience in the tokens: offline, ${AUDIENCE}`);
  checkTools();
  const phases = [
    checkAuthentication,
    checkFilter,
    checkDiscard,
    checkPathRules,
    checkMerge,
    checkLimits,
    checkQueue,
    checkEndToEnd,
    checkRealExporter,
  ];
  for (const phase of phases) {
    const started = Date.now();
    await phase();
    console.log(`${phase.name} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  const outcomes = {};
  for (const entry of capture()) outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
  const trouble = ['storage-error', 'undecodable', 'writer-bug'].filter(
    (outcome) => outcomes[outcome],
  );
  record(
    9,
    'control',
    'writer outcomes over the whole run: no storage error, no undecodable body',
    'none',
    trouble.join(', ') || 'none',
    trouble.length === 0,
  );
}

let ok = false;
try {
  await main();
  printReport();
  ok = verdict();
} finally {
  if (process.env.CHECK_KEEP_STACK !== '1') stopStack();
}
process.exit(ok ? 0 : 1);
