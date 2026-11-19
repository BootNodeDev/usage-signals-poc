// Plumbing of check 05: the isolated stack, the collector configurations, HTTP and SQL access,
// and the list of results. The experiment itself is in run.mjs.
import { spawnSync } from 'node:child_process';
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
export const COLLECTOR = 'http://127.0.0.1:43185';
export const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-05-'));
export const runTag = Date.now().toString(36);
const COMPOSE = ['compose', '-p', 'us-check-05', '-f', path.join(HERE, 'compose.yml')];
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
  const env = { ...process.env, CHECK_SCRATCH: scratch };
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

async function collectorAnswers() {
  try {
    await fetch(`${COLLECTOR}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
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
  setWriterMode('ok');
  compose('down', '-v', '--remove-orphans');
  compose('up', '-d', '--wait', 'postgres');
  docker(
    [
      ...COMPOSE,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'poc',
      '-d',
      'poc',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      input: readFileSync(path.join(HERE, '../../console/db/schema.sql'), 'utf8'),
    },
  );
  compose('up', '-d', 'writer');
  await waitFor('the writer', writerAnswers);
}

async function writerAnswers() {
  try {
    await fetch('http://127.0.0.1:43195/', { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

export async function startWriter() {
  compose('start', 'writer');
  await waitFor('the writer', writerAnswers);
}

export const stopStack = () => compose('down', '-v', '--remove-orphans');

export function setWriterMode(mode) {
  writeFileSync(path.join(scratch, 'writer-mode'), mode);
  chmodSync(path.join(scratch, 'writer-mode'), 0o666);
}

/** Every entry the writer logged from the given line on. */
export function capture(fromLine = 0) {
  const text = readFileSync(CAPTURE, 'utf8');
  // The writer may be in the middle of a line; only complete lines are read.
  const lines = text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean);
  return lines.slice(fromLine).map((line) => JSON.parse(line));
}

export const captureLength = () => capture().length;

/** Points the writer stored and points it refused for one service, from a capture position. */
export function writerSaw(service, fromLine = 0) {
  const entries = capture(fromLine).filter((entry) => entry.outcome === 'stored');
  const ofService = (item) => item.resource['service.name'] === service;
  return {
    accepted: entries.flatMap((entry) => entry.accepted.filter(ofService)),
    refused: entries.flatMap((entry) => entry.refused.filter(ofService)),
  };
}

/** True when any file of the disk queue holds the text. */
export function queueHolds(text) {
  const needle = Buffer.from(text);
  return readdirSync(QUEUE).some((name) => readFileSync(path.join(QUEUE, name)).includes(needle));
}

export const queueFiles = () => (existsSync(QUEUE) ? readdirSync(QUEUE) : []);

export async function post(route, body, { token, authorization, gzip = false, headers = {} } = {}) {
  const requestHeaders = { 'content-type': 'application/json', ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (authorization !== undefined) requestHeaders.authorization = authorization;
  let payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (gzip) {
    payload = gzipSync(payload);
    requestHeaders['content-encoding'] = 'gzip';
  }
  const response = await fetch(`${COLLECTOR}${route}`, {
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
    const socket = net.connect(43185, '127.0.0.1');
    let received = '';
    const lines = [
      'POST /v1/metrics HTTP/1.1',
      'Host: 127.0.0.1:43185',
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

export { sleep };
