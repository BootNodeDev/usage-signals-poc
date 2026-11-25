// Round two of check 05, the edge: a bound on every stored path segment (D) and what a tenant
// sees on each refusal path (E).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HERE,
  WRITER,
  post,
  record,
  runTag,
  setWriterMode,
  settle,
  simpleBody,
  sleep,
  sql,
  storedRows,
  useConfig,
  waitFor,
} from './harness.mjs';
import {
  BOUNDS_MS,
  BOUNDS_S,
  CUMULATIVE,
  histogramMetric,
  histogramPoint,
  resourceMetrics,
  seededRandom,
  signRs256,
  strkey,
  tenantClaims,
} from './lib.mjs';

const sum = (values) => values.reduce((total, value) => total + value, 0);
const requestsOf = (service) => sum(storedRows(service).map((row) => row.request_count));
const STABLE = 'http.server.request.duration';
const LEGACY = 'http.server.duration';

// ---------------------------------------------------------------- D. the bound on a segment

const MAX_SEGMENT = 36;
const SEGMENT = new RegExp(`^[ -~]{0,${MAX_SEGMENT}}$`);
/** The guarantee: every segment is at most MAX_SEGMENT printable ASCII characters. */
const withinBound = (route) => route.split('/').every((segment) => SEGMENT.test(segment));
const longestSegment = (route) => Math.max(...route.split('/').map((segment) => segment.length));

// Templates of routes.json with a segment over the bound: 8 of Slack, 1 of DigitalOcean.
const LONG_TEMPLATES = 9;

const TEMPLATES = JSON.parse(readFileSync(path.join(HERE, 'routes.json'), 'utf8')).groups.flatMap(
  (group) => group.paths.map((template) => ({ group: group.name, template })),
);

/** Chooses the bound from the templates: the smallest one that changes none of them. */
function chooseBound() {
  const changed = (bound) =>
    TEMPLATES.filter(({ template }) => longestSegment(template) > bound).length;
  console.log(`  templates with a segment longer than N, of ${TEMPLATES.length}:`);
  for (const bound of [16, 20, 24, 28, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40])
    console.log(`    N = ${bound}: ${changed(bound)}`);
  const share = (count) => `${count} of ${TEMPLATES.length} (${((100 * count) / TEMPLATES.length).toFixed(2)}%)`;
  record(
    'D',
    'required',
    `public route templates with a segment longer than the bound of ${MAX_SEGMENT} characters`,
    share(LONG_TEMPLATES),
    share(changed(MAX_SEGMENT)),
    changed(MAX_SEGMENT) === LONG_TEMPLATES && TEMPLATES.length >= 150,
  );
  // 95 printable ASCII characters carry log2(95) bits each.
  const bits = MAX_SEGMENT * Math.log2(95);
  record(
    'D',
    'control',
    'a segment within the bound holds fewer bits than the 256 of a secret key, in any encoding',
    'fewer than 256 bits',
    `at most ${bits.toFixed(1)} bits`,
    bits < 256,
  );
}

/** Sends each route as the only point of a service of its own and returns the stored routes. */
async function storedFor(prefix, routes, token, timeMs) {
  const resources = routes.map((route, i) =>
    resourceMetrics({ 'service.name': `${prefix}-${i}` }, [
      histogramMetric(STABLE, 's', [
        histogramPoint({
          attrs: {
            'http.route': route,
            'http.request.method': 'GET',
            'http.response.status_code': 200,
          },
          durations: [0.02],
          bounds: BOUNDS_S,
          timeMs,
        }),
      ]),
    ]),
  );
  for (let i = 0; i < resources.length; i += 200) {
    const body = { resourceMetrics: resources.slice(i, i + 200) };
    const answer = await post('/v1/metrics', body, { token });
    if (answer.status !== 200) throw new Error(`templates answered ${answer.status}`);
  }
  await settle(token);
  const stored = new Map(storedRows(`${prefix}-%`).map((row) => [row.service, row.route]));
  return routes.map((_, i) => stored.get(`${prefix}-${i}`));
}

async function templatesThroughTheCollector({ tokenA, BASE_MS }) {
  const stored = await storedFor(
    `tpl-${runTag}`,
    TEMPLATES.map((item) => item.template),
    tokenA,
    BASE_MS,
  );
  const changed = TEMPLATES.map((item, i) => ({ ...item, stored: stored[i] })).filter(
    (item) => item.stored !== item.template,
  );
  const byBound = changed.filter((item) => /\{(long|non_ascii)\}/.test(item.stored ?? ''));
  const bySlash = changed.filter((item) => item.stored === item.template.replace(/\/+$/, ''));
  const other = changed.filter((item) => !byBound.includes(item) && !bySlash.includes(item));
  for (const item of other)
    console.log(`  template changed: ${item.template} -> ${item.stored} (${item.group})`);
  record(
    'D',
    'required',
    `${TEMPLATES.length} public route templates sent as http.route: changed by the two bounding rules`,
    `${LONG_TEMPLATES} of ${TEMPLATES.length}; stored: ${TEMPLATES.length}`,
    `${byBound.length} of ${TEMPLATES.length}; stored: ${stored.filter(Boolean).length}`,
    byBound.length === LONG_TEMPLATES && stored.every(Boolean),
  );
  record(
    'D',
    'finding',
    'the same templates: changed by the rules of round one',
    '64 lose a trailing slash, 0 changed otherwise',
    `${bySlash.length} lose a trailing slash, ${other.length} changed otherwise`,
    bySlash.length === 64 && other.length === 0,
  );
}

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const ALPHABETS = [
  ASCII,
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  'abcdefghijklmnopqrstuvwxyz234567',
  '0123456789abcdef',
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz_-.',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  '%0123456789ABCDEF',
  // Outside printable ASCII: other scripts, full-width forms, a zero-width space, a
  // no-break space, a C1 control, a combining accent, and characters beyond the basic plane.
  [...'١٢٣ＳＡ​ \u0085é漢字é\u{1f600}\u{1d54a}'],
];

const pick = (random, list) => list[Math.floor(random() * list.length)];

/** A segment of any alphabet, with lengths crowded around the bound. */
function randomSegment(random) {
  const zone = random();
  const length =
    zone < 0.35
      ? MAX_SEGMENT - 4 + Math.floor(random() * 9)
      : zone < 0.7
        ? Math.floor(random() * 30)
        : 41 + Math.floor(random() * 60);
  const alphabet = pick(random, ALPHABETS);
  const other = random() < 0.2 ? pick(random, ALPHABETS) : alphabet;
  let text = '';
  for (let i = 0; i < length; i += 1) text += pick(random, random() < 0.9 ? alphabet : other);
  return text;
}

/** A secret seed cut, re-cased, wrapped or partly percent-encoded. */
function seedVariant(random) {
  let text = strkey('S', Math.floor(random() * 250));
  const start = Math.floor(random() * 8);
  text = text.slice(start, start + 1 + Math.floor(random() * 56));
  if (random() < 0.3) text = text.toLowerCase();
  if (random() < 0.3)
    text = [...text]
      .map((c) => (random() < 0.2 ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : c))
      .join('');
  if (random() < 0.2) text = `${pick(random, ['key=', 'seed:', 'S', 'x-'])}${text}`;
  if (random() < 0.2) text = `${text}${pick(random, ['.json', ':sign', '~', '​'])}`;
  return text;
}

function randomRoute(random) {
  const segments = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
    random() < 0.2 ? seedVariant(random) : randomSegment(random),
  );
  let route = `${random() < 0.9 ? '/' : ''}${segments.join('/')}`;
  if (random() < 0.05) route = `https://${randomSegment(random)}${route}`;
  if (random() < 0.03) route = `${route}${pick(random, ['\n', '\t', '\u007f'])}${randomSegment(random)}`;
  return route;
}

const PROPERTY_ROUTES = 12_000;
const PER_REQUEST = 300;

/** One request: half the routes on the stable metric, half as http.target on the older one. */
function propertyBody(service, routes, timeMs) {
  const point = (attrs, duration, bounds) =>
    histogramPoint({ attrs, durations: [duration], bounds, timeMs });
  const stable = routes
    .filter((_, i) => i % 2 === 0)
    .map((route) =>
      point(
        { 'http.route': route, 'http.request.method': 'GET', 'http.response.status_code': 200 },
        0.02,
        BOUNDS_S,
      ),
    );
  const legacy = routes
    .filter((_, i) => i % 2 === 1)
    .map((route) =>
      // Another duration than the stable points: an exact copy in one request counts once.
      point({ 'http.target': route, 'http.method': 'GET', 'http.status_code': 200 }, 30, BOUNDS_MS),
    );
  return {
    resourceMetrics: [
      resourceMetrics({ 'service.name': service }, [
        histogramMetric(STABLE, 's', stable),
        histogramMetric(LEGACY, 'ms', legacy),
      ]),
    ],
  };
}

/** Sends the routes and returns what was stored for them. */
async function storedForProperty(prefix, routes, token, timeMs) {
  for (let i = 0; i < routes.length; i += PER_REQUEST) {
    const body = propertyBody(`${prefix}-${i}`, routes.slice(i, i + PER_REQUEST), timeMs);
    const answer = await post('/v1/metrics', body, { token });
    if (answer.status !== 200) throw new Error(`property request answered ${answer.status}`);
  }
  await settle(token);
  const rows = storedRows(`${prefix}-%`);
  return {
    requests: sum(rows.map((row) => row.request_count)),
    routes: [...new Set(rows.map((row) => row.route))],
  };
}

async function propertyTest({ tokenA, BASE_MS }) {
  const random = seededRandom(36);
  const routes = Array.from({ length: PROPERTY_ROUTES }, () => randomRoute(random));
  const outside = routes.filter((route) => !withinBound(route)).length;
  const stored = await storedForProperty(`prop-${runTag}`, routes, tokenA, BASE_MS);
  const violations = stored.routes.filter((route) => !withinBound(route));
  for (const route of violations.slice(0, 5)) console.log(`  outside the bound: ${route}`);
  record(
    'D',
    'required',
    `${PROPERTY_ROUTES} random routes (seed 36), ${outside} of them with a segment outside the bound when sent`,
    `${PROPERTY_ROUTES} requests stored; stored routes with a segment outside the bound: 0`,
    `${stored.requests} requests stored; stored routes with a segment outside the bound: ${violations.length} of ${stored.routes.length} distinct`,
    stored.requests === PROPERTY_ROUTES && violations.length === 0 && outside > 5000,
  );

  const sample = routes.slice(0, 2 * PER_REQUEST);
  for (const [variant, what] of [
    ['no-length-cap', 'the rule for long segments removed'],
    ['no-ascii-rule', 'the rule for characters outside printable ASCII removed'],
  ]) {
    await useConfig(variant);
    const without = await storedForProperty(`prop-${variant}-${runTag}`, sample, tokenA, BASE_MS);
    const broken = without.routes.filter((route) => !withinBound(route)).length;
    const refused = sample.length - without.requests;
    record(
      'D',
      'control',
      `${what}, ${sample.length} random routes: the writer refuses what the edge let through`,
      'refused by the writer: more than 0; stored outside the bound: 0',
      `refused by the writer: ${refused > 0 ? 'more than 0' : refused}; stored outside the bound: ${broken}`,
      refused > 0 && broken === 0,
    );
  }
  await useConfig('design');
}

/** The writer holds the same bound: sent to it directly, a route outside it is refused. */
async function writerHoldsTheBound({ TENANT_A, BASE_MS }) {
  const routes = [`/v1/${'a'.repeat(37)}`, '/users/\u0661\u0662\u0663', `/v1/${'a'.repeat(36)}`];
  const seen = [];
  for (const [i, route] of routes.entries()) {
    const service = `bound-direct-${runTag}-${i}`;
    const body = simpleBody(service, {
      count: 3,
      route,
      timeMs: BASE_MS,
      resource: { 'tenant.id': TENANT_A },
    });
    const answer = await post('/v1/metrics', body, { base: WRITER });
    const rejected = JSON.parse(answer.text).partialSuccess?.errorMessage ?? 'stored';
    seen.push(`${rejected} (${requestsOf(service)} requests)`);
  }
  const refusal = 'route with a segment outside the bound (0 requests)';
  record(
    'D',
    'required',
    'sent to the writer directly: a segment of 37 characters, a segment of non-ASCII digits, a segment of 36 characters',
    [refusal, refusal, 'stored (3 requests)'].join('; '),
    seen.join('; '),
    seen.join('; ') === [refusal, refusal, 'stored (3 requests)'].join('; '),
  );
}

async function segmentBound(context) {
  chooseBound();
  await writerHoldsTheBound(context);
  await templatesThroughTheCollector(context);
  await propertyTest(context);
}

// ---------------------------------------------------------------- E. what a tenant sees

const firstPoint = (body) =>
  body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];
const firstMetric = (body) => body.resourceMetrics[0].scopeMetrics[0].metrics[0];

/** Every refusal the writer has recorded, as "reason" or "reason (other tenant)". */
function recordedRefusals(tenant) {
  const rows = sql('SELECT tenant_id, reason, points FROM usage_signals.api_refusal', {
    rows: true,
  });
  const totals = new Map();
  for (const row of rows) {
    const name = row.tenant_id === tenant ? row.reason : `${row.reason} (for the token's tenant)`;
    totals.set(name, (totals.get(name) ?? 0) + Number(row.points));
  }
  return totals;
}

/** The cases that need nothing but a request. `change` edits a valid export of 3 requests. */
function refusalCases({ tokenA, key, TENANT_A }) {
  const expired = tenantClaims(TENANT_A, { exp: Math.floor(Date.now() / 1000) - 60 });
  const noTenant = tenantClaims(TENANT_A, { tenant_id: undefined });
  const stranger = signRs256(tenantClaims(randomUUID()), key);
  const sent = (change) => ({ change, token: tokenA });
  return [
    { name: 'no token', token: null, status: 401, stored: 0 },
    { name: 'expired token', token: signRs256(expired, key), status: 401, stored: 0 },
    {
      name: 'body larger than 1 MiB',
      ...sent((body) => {
        body.resourceMetrics[0].resource.attributes.push({
          key: 'padding',
          value: { stringValue: 'x'.repeat(2 * 1024 * 1024) },
        });
      }),
      status: 400,
      stored: 0,
    },
    { name: 'body that is not OTLP', token: tokenA, raw: '{"resourceMetrics":[{"oops"', status: 400, stored: 0 },
    { name: 'content type text/plain', token: tokenA, contentType: 'text/plain', status: 415, stored: 0 },
    { name: 'address /v1/metric', token: tokenA, route: '/v1/metric', status: 404, stored: 0 },
    { name: 'token without a tenant claim', token: signRs256(noTenant, key), status: 200, stored: 0 },
    {
      name: 'token whose tenant claim is not a UUID',
      token: signRs256(tenantClaims('tenant-seven'), key),
      status: 200,
      stored: 0,
    },
    {
      name: 'exponential histogram under the stable name',
      ...sent((body) => {
        const metric = firstMetric(body);
        const { timeUnixNano } = firstPoint(body);
        metric.exponentialHistogram = {
          aggregationTemporality: 1,
          dataPoints: [
            {
              timeUnixNano,
              count: '3',
              sum: 0.06,
              scale: 0,
              zeroCount: '0',
              positive: { offset: 0, bucketCounts: ['3'] },
            },
          ],
        };
        delete metric.histogram;
      }),
      status: 200,
      stored: 0,
    },
    {
      name: 'the stable name with unit ms',
      ...sent((body) => {
        firstMetric(body).unit = 'ms';
      }),
      status: 200,
      stored: 0,
      recorded: 'unit is not seconds',
    },
    {
      name: 'the older name with unit s',
      ...sent((body) => {
        firstMetric(body).name = LEGACY;
      }),
      status: 200,
      stored: 0,
      recorded: 'not the HTTP server duration metric',
    },
    {
      name: 'cumulative temporality',
      ...sent((body) => {
        firstMetric(body).histogram.aggregationTemporality = CUMULATIVE;
      }),
      status: 200,
      stored: 0,
      recorded: 'temporality is not delta',
    },
    {
      name: 'bucket bounds other than the 14 advised',
      ...sent((body) => {
        firstPoint(body).explicitBounds = [0.1, 1];
        firstPoint(body).bucketCounts = ['3', '0', '0'];
      }),
      status: 200,
      stored: 0,
      recorded: 'bucket bounds differ from the layout',
    },
    {
      name: 'bucket counts that do not add up to the count',
      ...sent((body) => {
        firstPoint(body).count = '4';
      }),
      status: 200,
      stored: 0,
      recorded: 'bucket counts do not add up to the count',
    },
    {
      name: 'status code sent as a string',
      ...sent((body) => {
        firstPoint(body).attributes.find(
          (item) => item.key === 'http.response.status_code',
        ).value = { stringValue: '200' };
      }),
      status: 200,
      stored: 0,
      recorded: 'no valid status code',
    },
    {
      name: 'interval 10 days old, older than the keys kept',
      ...sent(() => {}),
      daysOld: 10,
      status: 200,
      stored: 0,
      recorded: 'older than the de-duplication keys that are kept',
    },
    {
      name: 'valid token of a tenant that is not enrolled',
      token: stranger,
      status: 200,
      stored: 0,
      recorded: "refused by the database (SQLSTATE 23503) (for the token's tenant)",
    },
    {
      name: 'route that is not a string: stored as (unmatched)',
      ...sent((body) => {
        firstPoint(body).attributes.find((item) => item.key === 'http.route').value = {
          intValue: '7',
        };
      }),
      status: 200,
      stored: 3,
    },
  ];
}

const outcomeText = (status, stored, recorded) =>
  `HTTP ${status}; ${stored} of 3 requests stored; recorded for the setup page: ${recorded}`;

async function refusalCase(item, i, { tokenA, TENANT_A, BASE_MS }) {
  const service = `refusal-${runTag}-${i}`;
  const timeMs = item.daysOld ? Date.now() - item.daysOld * 86_400_000 : BASE_MS;
  const body = simpleBody(service, { count: 3, timeMs });
  item.change?.(body);
  const before = recordedRefusals(TENANT_A);
  const answer = await post(item.route ?? '/v1/metrics', item.raw ?? body, {
    token: item.token ?? undefined,
    contentType: item.contentType,
  });
  await settle(tokenA);
  const after = recordedRefusals(TENANT_A);
  const recorded = [...after.keys()].filter((name) => after.get(name) !== before.get(name));
  const stored = requestsOf(service);
  const seen = outcomeText(answer.status, stored, recorded.join(', ') || 'nothing');
  record(
    'E',
    'required',
    item.name,
    outcomeText(item.status, item.stored, item.recorded ?? 'nothing'),
    seen,
    seen === outcomeText(item.status, item.stored, item.recorded ?? 'nothing'),
  );
}

async function writerUnavailable({ tokenA, BASE_MS }) {
  const service = `refusal-503-${runTag}`;
  await setWriterMode('503');
  const answer = await post('/v1/metrics', simpleBody(service, { count: 3, timeMs: BASE_MS }), {
    token: tokenA,
  });
  await sleep(1500);
  const meanwhile = requestsOf(service);
  await setWriterMode('ok');
  await waitFor('the queued batch', () => requestsOf(service) === 3, 30_000).catch(() => {});
  record(
    'E',
    'required',
    'the writer answers 503 (storage unavailable): the batch waits in the disk queue',
    'HTTP 200; 0 of 3 requests stored while it lasts, 3 of 3 after',
    `HTTP ${answer.status}; ${meanwhile} of 3 requests stored while it lasts, ${requestsOf(service)} of 3 after`,
    answer.status === 200 && meanwhile === 0 && requestsOf(service) === 3,
  );
}

async function memoryLimit({ tokenA, BASE_MS }) {
  await useConfig('tiny-memory-limit');
  // The limiter measures memory once a second.
  await sleep(2500);
  const service = `refusal-memory-${runTag}`;
  const answer = await post('/v1/metrics', simpleBody(service, { count: 3, timeMs: BASE_MS }), {
    token: tokenA,
  });
  await useConfig('design');
  await settle(tokenA);
  record(
    'E',
    'required',
    'the memory limiter refuses',
    'HTTP 503; 0 of 3 requests stored',
    `HTTP ${answer.status}; ${requestsOf(service)} of 3 requests stored`,
    answer.status === 503 && requestsOf(service) === 0,
  );
}

const QUEUE_SENDS = 40;

/** A queue of 3 requests and a writer that answers 503: what the tenant gets once it is full. */
async function fullQueue({ tokenA, BASE_MS }) {
  await useConfig('tiny-queue');
  await setWriterMode('503');
  const service = `refusal-queue-${runTag}`;
  const statuses = [];
  for (let i = 0; i < QUEUE_SENDS; i += 1) {
    const body = simpleBody(service, { count: 1, timeMs: BASE_MS + i * 1000 });
    statuses.push((await post('/v1/metrics', body, { token: tokenA })).status);
  }
  const accepted = statuses.filter((status) => status === 200).length;
  const refused = [...new Set(statuses.filter((status) => status !== 200))].join(',');
  await setWriterMode('ok');
  await waitFor('the queued batches', () => requestsOf(service) >= accepted, 60_000).catch(() => {});
  await settle(tokenA);
  const stored = requestsOf(service);
  console.log(`  full queue: ${accepted} of ${QUEUE_SENDS} accepted, the others answered ${refused}`);
  record(
    'E',
    'required',
    `the disk queue is full (${QUEUE_SENDS} exports into a queue of 3 with the writer answering 503)`,
    'some exports answered HTTP 200 and the others HTTP 503; every export answered 200 stored, no other',
    `${accepted > 0 && accepted < QUEUE_SENDS ? 'some' : accepted} exports answered HTTP 200 and the others HTTP ${refused}; ${stored === accepted ? 'every export answered 200 stored, no other' : `${stored} stored for ${accepted} answered 200`}`,
    accepted > 0 && accepted < QUEUE_SENDS && refused === '503' && stored === accepted,
  );
  await useConfig('design');
}

async function refusalPaths(context) {
  for (const [i, item] of refusalCases(context).entries()) await refusalCase(item, i, context);
  await writerUnavailable(context);
  await memoryLimit(context);
  await fullQueue(context);
}

export function edgePhases(context) {
  const phases = [segmentBound, refusalPaths];
  return phases.map((phase) =>
    Object.defineProperty(() => phase(context), 'name', { value: phase.name }),
  );
}
