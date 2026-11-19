// The writer of check 05: only what the experiment needs. It receives what the collector
// exports (OTLP/HTTP, JSON encoding), refuses anything that is not a delta HTTP server duration
// histogram with a tenant, and adds each point to usage_signals.api_metric_minute.
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

function attributeValue(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return JSON.stringify(value);
}

function attributeMap(list) {
  const map = {};
  for (const { key, value } of list ?? []) map[key] = attributeValue(value);
  return map;
}

function boundsMatchLayout(explicitBounds) {
  if (explicitBounds?.length !== BOUNDS_MS.length) return false;
  return explicitBounds.every((seconds, i) => Math.abs(seconds * 1000 - BOUNDS_MS[i]) < 1e-6);
}

/** Why a metric as a whole cannot be stored, or null. */
function metricRefusal(metric) {
  if (!metric.histogram) return 'not a histogram';
  if (metric.name !== METRIC_NAME) return 'not the HTTP server duration metric';
  if (metric.unit !== 's') return 'unit is not seconds';
  if (metric.histogram.aggregationTemporality !== DELTA) return 'temporality is not delta';
  return null;
}

/** Why a point cannot be stored, or null. */
function pointRefusal(point, attributes) {
  if (typeof attributes['http.route'] !== 'string') return 'no route';
  if (typeof attributes['http.request.method'] !== 'string') return 'no method';
  const status = attributes['http.response.status_code'];
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'no valid status code';
  if (!boundsMatchLayout(point.explicitBounds)) return 'bucket bounds differ from the layout';
  if (point.sum === undefined) return 'no sum';
  return null;
}

/** Splits one export request into points to store and points refused, with the reason. */
function readRequest(body) {
  const accepted = [];
  const refused = [];
  for (const resourceMetrics of body.resourceMetrics ?? []) {
    const resource = attributeMap(resourceMetrics.resource?.attributes);
    const metrics = (resourceMetrics.scopeMetrics ?? []).flatMap((scope) => scope.metrics ?? []);
    for (const metric of metrics) {
      const base = {
        resource,
        metric: metric.name,
        unit: metric.unit,
        temporality: metric.histogram?.aggregationTemporality,
      };
      const tenantMissing = typeof resource['tenant.id'] === 'string' ? null : 'no tenant.id';
      const metricReason = tenantMissing ?? metricRefusal(metric);
      if (metricReason) {
        refused.push({ ...base, reason: metricReason });
        continue;
      }
      for (const point of metric.histogram.dataPoints ?? []) {
        const attributes = attributeMap(point.attributes);
        const seen = {
          ...base,
          attributes,
          timeUnixNano: point.timeUnixNano,
          count: Number(point.count),
          sum: point.sum,
          min: point.min,
          max: point.max,
          explicitBounds: point.explicitBounds,
          bucketCounts: (point.bucketCounts ?? []).map(Number),
        };
        const reason = pointRefusal(point, attributes);
        if (reason) refused.push({ ...seen, reason });
        else accepted.push(seen);
      }
    }
  }
  return { accepted, refused };
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
const keyOf = (row) => JSON.stringify(row.slice(0, KEY_COLUMNS));

async function store(points) {
  // Rows are written in key order: two batches that touch the same rows in different orders
  // deadlock in PostgreSQL.
  const rows = points
    .map(rowOf)
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) await client.query(UPSERT, row);
    await client.query('COMMIT');
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

async function handle(request, response) {
  if (request.method !== 'POST' || request.url !== '/v1/metrics') {
    capture({ outcome: 'unexpected-request', method: request.method, url: request.url });
    return answer(response, 404, {});
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (existsSync(MODE_FILE) && readFileSync(MODE_FILE, 'utf8').trim() === '503') {
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
  try {
    await store(parsed.accepted);
  } catch (error) {
    capture({ outcome: 'storage-error', error: String(error) });
    return answer(response, 503, { message: 'storage unavailable' });
  }
  // Written after the commit, so a captured point is a stored point.
  capture({ outcome: 'stored', accepted: parsed.accepted, refused: parsed.refused });
  const partialSuccess =
    parsed.refused.length > 0
      ? {
          rejectedDataPoints: String(parsed.refused.length),
          errorMessage: parsed.refused[0].reason,
        }
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
