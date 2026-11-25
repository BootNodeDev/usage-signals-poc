// Plumbing of check 05: the isolated stack, the collector configurations, HTTP and SQL access,
// and the list of results. The experiment itself is in run.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { BOUNDS_S, histogramMetric, histogramPoint, resourceMetrics } from './lib.mjs';

export const HERE = import.meta.dirname;
export const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-05-r2-'));
export const runTag = Date.now().toString(36);
const COMPOSE = ['compose', '-p', 'us-check-05-r2', '-f', path.join(HERE, 'compose.yml')];

// The edge collector under test: the Builder's output by default, the unmodified contrib
// distribution with CHECK_EDGE=contrib.
const EDGES = {
  builder: { image: 'us-check-05-r2-edge:0.165.0', binary: '/usage-signals-edge' },
  contrib: {
    image:
      'otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea',
    binary: '/otelcol-contrib',
  },
};
export const edgeName = process.env.CHECK_EDGE ?? 'builder';
const EDGE = EDGES[edgeName];
if (!EDGE) throw new Error('CHECK_EDGE must be builder or contrib');

// Host addresses of the published ports. Docker picks the ports, and picks again whenever a
// container starts, so these are read again after every start.
export let COLLECTOR;
export let WRITER;
export let WRITER_2;
export let TENANT_COLLECTOR;
const CAPTURE = path.join(scratch, 'writer-capture.jsonl');
const QUEUE = path.join(scratch, 'queue');
const BASE_CONFIG = readFileSync(path.join(HERE, 'collector.yaml'), 'utf8');

export const results = [];

/** Records one assertion. `kind` is "required", "control" or "finding". */
export function record(point, kind, label, expected, observed, pass) {
  results.push({
    point,
    kind,
    label,
    expected: String(expected),
    observed: String(observed),
    pass: Boolean(pass),
  });
}

export function docker(args, options = {}) {
  const env = { ...process.env, CHECK_SCRATCH: scratch, CHECK_EDGE_IMAGE: EDGE.image };
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

export const compose = (...args) => docker([...COMPOSE, ...args]);

/** A compose command that runs beside the script; resolves with its exit code. */
export function composeInBackground(args, input) {
  const env = { ...process.env, CHECK_SCRATCH: scratch, CHECK_EDGE_IMAGE: EDGE.image };
  const child = spawn('docker', [...COMPOSE, ...args], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(input ?? '');
  return once(child, 'exit').then(([code]) => code);
}

/** Runs SQL in the stack's PostgreSQL and returns the rows of a SELECT as objects. */
export function sql(statement, { rows = false } = {}) {
  const text = rows ? `SELECT coalesce(json_agg(t), '[]') FROM (${statement}) t` : statement;
  const psql = [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'poc',
    '-d',
    'poc',
    '-q',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
  ];
  const output = docker([...COMPOSE, ...psql], { input: text });
  return rows ? JSON.parse(output) : output;
}

export function storedRows(servicePattern = '%') {
  return sql(
    `SELECT tenant_id, extract(epoch FROM minute)::bigint / 60 AS minute, service, route, method,
            status_code, request_count::float8 AS request_count, duration_sum_ms, bucket_counts
     FROM usage_signals.api_metric_minute
     WHERE service LIKE '${servicePattern}' AND service NOT LIKE 'sentinel-%'
     ORDER BY tenant_id, minute, service, route, method, status_code`,
    { rows: true },
  );
}

export const clearRows = () => sql('TRUNCATE usage_signals.api_metric_minute');
export const databaseDump = () =>
  docker([...COMPOSE, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'poc', '--data-only', 'poc']);

export async function waitFor(what, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** The host address Docker gave a published port, or null while the container is not up. */
function published(service, port) {
  try {
    const address = compose('port', service, String(port)).trim();
    return address ? `http://${address}` : null;
  } catch {
    return null;
  }
}

async function answers(base) {
  if (!base) return false;
  try {
    await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function collectorAnswers() {
  COLLECTOR = published('collector', 4318);
  return answers(COLLECTOR);
}

/** Waits for a collector that was stopped and started outside useConfig. */
export const collectorIsBack = () => waitFor('the collector', collectorAnswers);

/** The Builder's image: docker build runs the Builder on builder-manifest.yaml. */
export function buildEdge() {
  if (edgeName !== 'builder') return;
  docker(['build', '-q', '-f', path.join(HERE, 'Dockerfile.edge'), '-t', EDGE.image, HERE]);
}

/** What the collector binary says about itself: its version and the components built in. */
export function edgeSelfReport() {
  const run = (...args) => compose('exec', '-T', 'collector', EDGE.binary, ...args);
  return { version: run('--version').trim(), components: run('components') };
}

/** Edits of collector.yaml that make the negative controls. Each one must change the file. */
const VARIANTS = {
  design: (text) => text,
  'no-filter': (text) => text.replace(', filter/http_server_only', ''),
  'no-path-rules': (text) => text.replace(', transform/path_rules', ''),
  'no-merge': (text) => text.replace(', transform/merge]', ']'),
  'no-discard-pipelines': (text) =>
    text.replace(/ {4}# BEGIN discard pipelines[\s\S]*# END discard pipelines\n/, ''),
  'tiny-memory-limit': (text) =>
    text
      .replace('limit_mib: 400', 'limit_mib: 2')
      .replace('spike_limit_mib: 80', 'spike_limit_mib: 1'),
  // What the first review proposed: delete_key, which removes one occurrence of a key.
  'strip-first-duplicate-only': (text) =>
    text.replace(
      /^( +)- delete_matching_keys\(resource\.attributes, .*\n/m,
      '$1- delete_key(resource.attributes, "tenant.id")\n$1- delete_key(resource.attributes, "usage_signals.token_id")\n',
    ),
  'no-attribute-rebuild': (text) =>
    text.replace(/^ +- keep_keys\(datapoint\.attributes, \[\]\)\n/m, ''),
  'keep-exemplars': (text) => text.replace(/^ +- set\(datapoint\.exemplars, nil\)\n/m, ''),
  // Round two.
  'no-length-cap': (text) => text.replace(/^ +- replace_pattern\(.*"\/\{long\}\/"\)\n/m, ''),
  'no-ascii-rule': (text) => text.replace(/^ +- replace_pattern\(.*"\/\{non_ascii\}\/"\)\n/m, ''),
  'tiny-queue': (text) => text.replace('queue_size: 10000', 'queue_size: 3'),
};

/** Restarts the collector with the design configuration or one of its negative controls. */
export async function useConfig(variant) {
  const text = VARIANTS[variant](BASE_CONFIG);
  if (variant !== 'design' && text === BASE_CONFIG)
    throw new Error(`variant ${variant} changed nothing`);
  writeFileSync(path.join(scratch, 'collector-active.yaml'), text);
  writeFileSync(path.join(scratch, `collector-${variant}.yaml`), text);
  compose('up', '-d', '--force-recreate', '--no-deps', 'collector');
  await waitFor(`the collector with configuration "${variant}"`, collectorAnswers);
}

export async function startStack(jwks) {
  mkdirSync(QUEUE);
  // The collector image runs as a non-root user and writes the queue here.
  chmodSync(scratch, 0o777);
  chmodSync(QUEUE, 0o777);
  writeFileSync(path.join(scratch, 'jwks.json'), JSON.stringify(jwks));
  writeFileSync(CAPTURE, '');
  chmodSync(CAPTURE, 0o666);
  writeWriterMode('ok');
  compose('down', '-v', '--remove-orphans');
  compose('up', '-d', '--wait', 'postgres');
  // The image reports healthy while its first start still runs a temporary server and then
  // restarts, so the first connection can fail. The schema only creates what is missing.
  const schema =
    readFileSync(path.join(HERE, '../../console/db/schema.sql'), 'utf8') +
    readFileSync(path.join(HERE, 'dedup.sql'), 'utf8');
  // PostgreSQL stops when the Docker disk fills, which shows as an unrelated failure later.
  const freeKb = Number(
    compose('exec', '-T', 'postgres', 'df', '-Pk', '/var/lib/postgresql').trim().split('\n').pop().split(/\s+/)[3],
  );
  if (!(freeKb > 1024 * 1024))
    throw new Error(
      `the Docker disk has ${Math.round(freeKb / 1024)} MB free; this check needs 1 GB. Free some space and run again.`,
    );
  await waitFor('PostgreSQL to take the schema', () => {
    try {
      sql(schema);
      return true;
    } catch {
      return false;
    }
  });
  writeFileSync(path.join(scratch, 'writer-2-capture.jsonl'), '');
  chmodSync(path.join(scratch, 'writer-2-capture.jsonl'), 0o666);
  compose('up', '-d', 'writer', 'writer-2');
  await waitFor('the writers', writersAnswer);
}

async function writersAnswer() {
  WRITER = published('writer', 43195);
  WRITER_2 = published('writer-2', 43195);
  return (await answers(WRITER)) && (await answers(WRITER_2));
}

async function writerAnswers() {
  WRITER = published('writer', 43195);
  return answers(WRITER);
}

/** Sets the writer's experiment controls (see writer.mjs) and returns all of them. */
export async function writerSettings(change = {}, base = WRITER) {
  const response = await fetch(`${base}/experiment`, {
    method: 'POST',
    body: JSON.stringify(change),
  });
  return response.json();
}

export const purgeKeys = async () =>
  (await fetch(`${WRITER}/experiment/purge`, { method: 'POST' })).json();

export const clearKeys = () =>
  sql('TRUNCATE usage_signals.api_point_key, usage_signals.api_refusal');

export async function startWriter() {
  compose('start', 'writer');
  await waitFor('the writer', writerAnswers);
}

export const stopStack = () => compose('down', '-v', '--remove-orphans');

function writeWriterMode(mode) {
  writeFileSync(path.join(scratch, 'writer-mode'), mode);
  chmodSync(path.join(scratch, 'writer-mode'), 0o666);
}

/**
 * Makes the writer answer 503 ("503") or work normally ("ok"), and returns once the writer
 * itself reports the new mode: a file written on the host reaches a container with a delay.
 */
export async function setWriterMode(mode) {
  writeWriterMode(mode);
  await waitFor(`the writer to enter mode ${mode}`, async () => {
    const response = await fetch(`${WRITER}/mode`).catch(() => null);
    return response?.ok && (await response.json()).mode === mode;
  });
}

/** Every entry a writer logged from the given line on. */
export function capture(fromLine = 0, file = CAPTURE) {
  const text = readFileSync(file, 'utf8');
  // The writer may be in the middle of a line; only complete lines are read.
  const lines = text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean);
  return lines.slice(fromLine).map((line) => JSON.parse(line));
}

export const captureLength = () => capture().length;
export const captureOfWriter2 = () => capture(0, path.join(scratch, 'writer-2-capture.jsonl'));

/** Points the writer stored and points it refused for one service, from a capture position. */
export function writerSaw(service, fromLine = 0) {
  const entries = capture(fromLine).filter((entry) => entry.outcome === 'stored');
  const ofService = (item) => item.resource['service.name'] === service;
  return {
    accepted: entries.flatMap((entry) => entry.accepted.filter(ofService)),
    refused: entries.flatMap((entry) => entry.refused.filter(ofService)),
    // Zero-count points: valid, and nothing to store.
    empty: entries.flatMap((entry) => (entry.empty ?? []).filter(ofService)),
    // Points whose key was already counted: redeliveries.
    duplicates: entries.flatMap((entry) => (entry.duplicates ?? []).filter(ofService)),
  };
}

/** True when any file of the disk queue holds the text. */
export function queueHolds(text) {
  const needle = Buffer.from(text);
  return readdirSync(QUEUE).some((name) => readFileSync(path.join(QUEUE, name)).includes(needle));
}

export const queueFiles = () => (existsSync(QUEUE) ? readdirSync(QUEUE) : []);

export async function post(
  route,
  body,
  {
    token,
    authorization,
    gzip = false,
    headers = {},
    contentType = 'application/json',
    base = COLLECTOR,
  } = {},
) {
  const requestHeaders = { 'content-type': contentType, ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (authorization !== undefined) requestHeaders.authorization = authorization;
  let payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (gzip) {
    payload = gzipSync(payload);
    requestHeaders['content-encoding'] = 'gzip';
  }
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: requestHeaders,
    body: payload,
  });
  return {
    status: response.status,
    text: await response.text(),
    bytes: Buffer.byteLength(payload),
  };
}

/**
 * Sends request headers that announce a body and then sends no body. Returns the status line
 * the server answers within the wait, or null when it stays silent.
 */
export function headersOnly(authorization, waitMs = 1500) {
  return new Promise((resolve, reject) => {
    const { port, host } = new URL(COLLECTOR);
    const socket = net.connect(Number(port), '127.0.0.1');
    let received = '';
    const lines = [
      'POST /v1/metrics HTTP/1.1',
      `Host: ${host}`,
      'Content-Type: application/json',
      'Content-Length: 500000',
    ];
    if (authorization) lines.push(`Authorization: ${authorization}`);
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(received ? received.split('\r\n')[0] : null);
    }, waitMs);
  });
}

/** One request body with a single stable-convention point of `count` requests. */
export function simpleBody(
  service,
  { count = 1, route = '/simple', timeMs, resource = {}, pointAttrs = {} },
) {
  const point = histogramPoint({
    attrs: {
      'http.route': route,
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      ...pointAttrs,
    },
    durations: new Array(count).fill(0.02),
    bounds: BOUNDS_S,
    timeMs,
  });
  const metric = histogramMetric('http.server.request.duration', 's', [point]);
  return { resourceMetrics: [resourceMetrics({ 'service.name': service, ...resource }, [metric])] };
}

let sentinels = 0;

/**
 * Sends one more valid point and waits until the writer has stored it, so that "nothing else
 * arrived" is read after the pipeline has demonstrably delivered something sent later.
 */
export async function settle(token) {
  sentinels += 1;
  const service = `sentinel-${runTag}-${sentinels}`;
  const from = captureLength();
  const { status } = await post('/v1/metrics', simpleBody(service, { timeMs: Date.now() }), {
    token,
  });
  if (status !== 200) throw new Error(`the sentinel was answered ${status}`);
  await waitFor('the sentinel point', () => writerSaw(service, from).accepted.length > 0);
  await sleep(500);
}


/**
 * Starts a second collector in the role of a tenant's own Collector: it converts cumulative
 * histograms to delta and forwards them to the edge with the tenant's token.
 */
export async function startTenantCollector(token) {
  const config = `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  filter/only_http_server:
    metric_conditions:
      - metric.name != "http.server.request.duration"
  cumulativetodelta:
exporters:
  otlp_http:
    endpoint: http://collector:4318
    headers:
      authorization: "Bearer ${token}"
    sending_queue:
      enabled: false
service:
  telemetry:
    metrics:
      level: none
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [filter/only_http_server, cumulativetodelta]
      exporters: [otlp_http]
`;
  writeFileSync(path.join(scratch, 'tenant-collector.yaml'), config);
  compose('up', '-d', '--no-deps', 'tenant-collector');
  await waitFor('the tenant collector', () => {
    TENANT_COLLECTOR = published('tenant-collector', 4318);
    return answers(TENANT_COLLECTOR);
  });
}

export async function stopPostgres() {
  compose('stop', 'postgres');
}

export async function startPostgres() {
  compose('up', '-d', '--wait', '--no-deps', 'postgres');
}

/**
 * Starts service.cjs, sends it the planned HTTP requests, leaves it idle for a while and stops
 * it so that it flushes.
 */
export async function driveRealService({
  serviceName,
  temporality,
  plan,
  token,
  exportTo = COLLECTOR,
  idleMs = 0,
}) {
  const env = {
    ...process.env,
    CHECK_TEMPORALITY: temporality,
    CHECK_COLLECTOR: exportTo,
    CHECK_TOKEN: token,
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
  await sleep(idleMs);
  child.kill('SIGTERM');
  await once(child, 'exit');
  return { sent: calls.length, answeredAsPlanned: statuses.filter(Boolean).length };
}

export { sleep };
