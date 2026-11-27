// The demo API of Demo site A: a small Stellar-style API that measures its own requests with the
// OpenTelemetry SDK and sends them to POST /v1/metrics with an ingest token, as any project
// would. The scheduled run calls it a few dozen times; anyone else can call it too.
// Its metrics need CONSOLE_URL (where /v1/metrics is) and DEMO_API_INGEST_TOKEN; without them it
// answers and sends nothing.
import { randomUUID } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';

export const DEMO_API_SERVICE = 'demo-api';
// The boundaries the conventions advise; the SDK's defaults differ and /v1/metrics refuses them.
const BOUNDS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const KNOWN_ACCOUNTS = 1000;
// The semantic conventions record any other method as _OTHER, so a caller cannot make a new
// series per invented method (https://opentelemetry.io/docs/specs/semconv/http/http-spans/).
const KNOWN_METHODS = new Set([
  'CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE',
]);
// The scheduled run's calls: each gets this long, and the run stops calling after its budget.
const CALL_TIMEOUT_MS = 5000;
const RUN_BUDGET_MS = 60_000;
// The answers the demo API gives. Any other one (401, 403, 5xx) means CONSOLE_URL does not point
// at it, so the scheduled run fails instead of counting the calls.
const DEMO_STATUSES = new Set([200, 201, 400, 404, 405]);
// An export that fails or hangs must not hold the answer: the exporter gives up after this long,
// and the measurement is lost and logged.
const EXPORT_TIMEOUT_MS = 2000;
// ExportResultCode.SUCCESS of @opentelemetry/core, which is not a direct dependency.
const EXPORT_SUCCESS = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Work that takes a while, as a database or Horizon call would.
const work = (medianMs) => sleep(medianMs * (0.5 + Math.random()));

async function account(id) {
  await work(30);
  if (Number(id) > KNOWN_ACCOUNTS) return [404, { error: 'No such account.' }];
  return [200, { id, balance: (Number(id) * 7.31).toFixed(2), asset: 'XLM' }];
}

async function payments(id) {
  await work(80);
  if (Number(id) > KNOWN_ACCOUNTS) return [404, { error: 'No such account.' }];
  return [200, { id, payments: [{ amount: '12.50', asset: 'USDC' }] }];
}

async function prices() {
  await work(20);
  return [200, { XLM: '0.41', USDC: '1.00' }];
}

async function transaction(request) {
  await work(300);
  const body = await request.json().catch(() => null);
  if (!body?.source || !body?.amount) return [400, { error: 'Send a source and an amount.' }];
  return [201, { hash: randomUUID().replaceAll('-', ''), status: 'pending' }];
}

// [method, path pattern, route template, handler]
const ROUTES = [
  ['GET', /^\/demo\/api\/accounts\/(\d+)$/, '/demo/api/accounts/{id}', (_, id) => account(id)],
  [
    'GET',
    /^\/demo\/api\/accounts\/(\d+)\/payments$/,
    '/demo/api/accounts/{id}/payments',
    (_, id) => payments(id),
  ],
  ['GET', /^\/demo\/api\/prices$/, '/demo/api/prices', () => prices()],
  ['POST', /^\/demo\/api\/transactions$/, '/demo/api/transactions', (req) => transaction(req)],
  ['GET', /^\/demo\/api\/health$/, '/demo/api/health', async () => [200, { status: 'ok' }]],
];

let instruments;

/** The SDK, set up on first use; null when the metrics are not configured. */
function instrumentsOf() {
  if (instruments !== undefined) return instruments;
  const base = process.env.CONSOLE_URL;
  const token = process.env.DEMO_API_INGEST_TOKEN;
  if (!base || !token) {
    console.error('demo API: CONSOLE_URL or DEMO_API_INGEST_TOKEN unset, so no metrics are sent');
    instruments = null;
    return instruments;
  }
  const otlp = new OTLPMetricExporter({
    url: new URL('/v1/metrics', base).href,
    headers: { authorization: `Bearer ${token}` },
    temporalityPreference: AggregationTemporality.DELTA,
    timeoutMillis: EXPORT_TIMEOUT_MS,
  });
  // The SDK reports a failed export only to the exporter's callback, so it is logged here.
  const exporter = {
    export: (batch, done) =>
      otlp.export(batch, (result) => {
        if (result.code !== EXPORT_SUCCESS) {
          console.error(`demo API: metrics not sent: ${result.error?.message ?? 'export failed'}`);
        }
        done(result);
      }),
    forceFlush: () => otlp.forceFlush(),
    shutdown: () => otlp.shutdown(),
    selectAggregationTemporality: (kind) => otlp.selectAggregationTemporality(kind),
  };
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': DEMO_API_SERVICE,
      // Each process is its own instance, so two of them never share a de-duplication key.
      'service.instance.id': randomUUID(),
    }),
    // A function may stop between requests, so each request is exported when it ends.
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 3_600_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS + 500,
      }),
    ],
  });
  const meter = provider.getMeter('pulse-demo-api');
  const duration = meter.createHistogram('http.server.request.duration', {
    unit: 's',
    advice: { explicitBucketBoundaries: BOUNDS_S },
  });
  instruments = { provider, duration };
  return instruments;
}

/** /demo/api/*: answers the request, then records and exports how long it took. */
export async function handleDemoApi(request) {
  const started = performance.now();
  const { pathname } = new URL(request.url);
  const found = ROUTES.map(([method, pattern, route, handler]) => ({
    method, route, handler, match: pathname.match(pattern),
  })).find((candidate) => candidate.match);
  let status;
  let body;
  if (!found) [status, body] = [404, { error: 'Not found.' }];
  else if (found.method !== request.method) {
    [status, body] = [405, { error: `Use ${found.method}.` }];
  }
  else [status, body] = await found.handler(request, found.match[1]);
  const response = Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  const sdk = instrumentsOf();
  if (sdk) {
    const attributes = {
      'http.request.method': KNOWN_METHODS.has(request.method) ? request.method : '_OTHER',
      'http.response.status_code': status,
    };
    if (found) attributes['http.route'] = found.route;
    sdk.duration.record((performance.now() - started) / 1000, attributes);
    await sdk.provider.forceFlush().catch((error) => {
      console.error(`demo API: metrics not sent: ${error.message}`);
    });
  }
  return response;
}

// The scheduled run's callers: mostly reads, some unknown accounts and bad transactions.
const CALLS = [
  [40, () => ['GET', `/demo/api/accounts/${1 + Math.floor(Math.random() * 1100)}`]],
  [20, () => ['GET', `/demo/api/accounts/${1 + Math.floor(Math.random() * 1100)}/payments`]],
  [20, () => ['GET', '/demo/api/prices']],
  [10, () => ['POST', '/demo/api/transactions', Math.random() < 0.85]],
  [10, () => ['GET', '/demo/api/health']],
];

function pickCall() {
  let point = Math.random() * CALLS.reduce((sum, [weight]) => sum + weight, 0);
  for (const [weight, call] of CALLS) {
    point -= weight;
    if (point < 0) return call();
  }
  return CALLS[0][1]();
}

/**
 * Calls the demo API up to `count` times at `base`, within `budgetMs`; returns how many answers
 * each status got, and how many calls timed out. Throws when the demo API cannot be reached or
 * an answer is one it never gives.
 */
export async function callDemoApi(base, count, budgetMs = RUN_BUDGET_MS) {
  const statuses = {};
  const started = Date.now();
  for (let i = 0; i < count && Date.now() - started < budgetMs; i += 1) {
    const [method, path, valid] = pickCall();
    const init = { method };
    if (method === 'POST') {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(valid ? { source: 'G...', amount: '10' } : {});
    }
    init.signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, base), init);
      if (!DEMO_STATUSES.has(response.status)) {
        throw new Error(`answers are not the demo API's: ${response.status} from ${base}`);
      }
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      statuses.timeout = (statuses.timeout ?? 0) + 1;
    }
  }
  return statuses;
}

/** For tests: drops the SDK so the next request reads the settings again. */
export async function resetDemoApi() {
  if (instruments) await instruments.provider.shutdown();
  instruments = undefined;
  metrics.disable();
}
