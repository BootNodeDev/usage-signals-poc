// Reads an OTLP/HTTP JSON export request into data points to store, zero-count points and
// points refused for good with a reason. These are the check 5 writer's rules
// (`checks/check-05/writer.mjs`), with two jobs of the product's collector done here as well:
// the tenant comes from the ingest token, never from the request, and routes are normalised.
// OTLP JSON sends 64-bit integers as strings and enums as integers.
import { createHash } from 'node:crypto';
import { BOUNDS_MS } from './api-read.js';
import { normalizeRoute } from './route-rules.js';

const METRIC_NAME = 'http.server.request.duration';
// AGGREGATION_TEMPORALITY_DELTA in opentelemetry-proto.
const DELTA = 1;
// PostgreSQL text cannot hold a NUL, and no stored name has a use for control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;
// The primary key is a B-tree entry, which has a size limit; these keep a row well below it.
const MAX_BYTES = { service: 255, route: 1024, method: 32 };
const SEGMENT = /^[ -~]{0,36}$/;
const MAX_COUNT = BigInt(Number.MAX_SAFE_INTEGER);
const DAY_MS = 86_400_000;
const MAX_TIME_MS = Date.UTC(9999, 11, 31);
// De-duplication keys are kept this many whole UTC days, and an older point is refused: its key
// may be gone, so it could not be told from a redelivery. Check 5 found the document's 2 days
// too short for a 7-day queue.
export const KEY_DAYS = 8;

const today = () => Math.floor(Date.now() / DAY_MS);
export const dateOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const dayOf = (timeUnixNano) => Number(BigInt(timeUnixNano) / 1_000_000n / BigInt(DAY_MS));

// The value of an attribute and its OTLP type.
function attributeValue(value) {
  if (value.stringValue !== undefined) return ['string', value.stringValue];
  if (value.intValue !== undefined) return ['int', Number(value.intValue)];
  if (value.doubleValue !== undefined) return ['double', value.doubleValue];
  if (value.boolValue !== undefined) return ['bool', value.boolValue];
  return ['other', JSON.stringify(value)];
}

/**
 * The attributes the stored row needs, as the collector's allowlist keeps them: a name only as
 * text and the status code only as an integer; any other type counts as not sent. Also the
 * keys that appear more than once.
 */
function readAttributes(list) {
  const map = {};
  const types = {};
  const duplicated = [];
  for (const { key, value } of list ?? []) {
    if (Object.hasOwn(map, key)) duplicated.push(key);
    [types[key], map[key]] = attributeValue(value ?? {});
  }
  const keep = (key, type) => (types[key] === type ? map[key] : undefined);
  const kept = {
    'service.name': keep('service.name', 'string'),
    'service.instance.id': keep('service.instance.id', 'string'),
    'http.route': keep('http.route', 'string'),
    'http.request.method': keep('http.request.method', 'string'),
    'http.response.status_code': keep('http.response.status_code', 'int'),
  };
  return { map: kept, duplicated };
}

function boundsMatchLayout(explicitBounds) {
  if (explicitBounds?.length !== BOUNDS_MS.length) return false;
  return explicitBounds.every((seconds, i) => Math.abs(seconds * 1000 - BOUNDS_MS[i]) < 1e-6);
}

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

function resourceRefusal(resource, duplicated) {
  if (duplicated.length > 0) return `resource attribute sent more than once: ${duplicated[0]}`;
  return nameRefusal('service', resource['service.name'] ?? '(unknown)');
}

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

const segmentRefusal = (route) =>
  route.split('/').every((segment) => SEGMENT.test(segment))
    ? null
    : 'route with a segment outside the bound';

function ageRefusal(time) {
  return dayOf(time) < today() - KEY_DAYS
    ? 'older than the de-duplication keys that are kept'
    : null;
}

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

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest();

/**
 * The key of a point: what identifies it in the metrics data model (resource, metric,
 * attributes, start and end time). The time of receipt is not part of it, so a retry by the
 * project's SDK has the same key.
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
  const parts = [[0, 8], [8, 12], [12, 16], [16, 20], [20, 32]];
  const key = parts.map(([from, to]) => hex.slice(from, to)).join('-');
  const numbers = hashOf([point.count, point.sum, point.min, point.max, point.bucketCounts]);
  return { key, day: dateOf(dayOf(point.timeUnixNano)), numbers: numbers.readInt32BE(0) };
}

function readPoint(point, base, result, pending) {
  const { map: attributes, duplicated } = readAttributes(point.attributes);
  attributes['http.route'] = normalizeRoute(attributes['http.route']);
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
    bucketCounts: numbers.bucketCounts ?? point.bucketCounts,
  };
  const reason = pointRefusal(point, attributes, duplicated, numbers);
  if (reason) result.refused.push({ ...seen, reason });
  else if (numbers.count === 0) result.empty.push(seen);
  else pending.push(seen);
}

const identityOf = (point) =>
  JSON.stringify([
    point.resource['service.name'] ?? '(unknown)',
    point.resource['service.instance.id'] ?? '',
    point.attributes['http.route'],
    point.attributes['http.request.method'],
    point.attributes['http.response.status_code'],
    String(point.startTimeUnixNano ?? '0'),
    String(point.timeUnixNano),
  ]);

/**
 * Adds up the points of one request that have the same identity once their routes are
 * normalised, as the collector's merge does; otherwise /users/1 and /users/3 with equal numbers
 * would look like one point sent twice.
 */
function mergeSame(points) {
  const merged = new Map();
  for (const point of points) {
    const identity = identityOf(point);
    const into = merged.get(identity);
    if (!into) {
      merged.set(identity, { ...point, bucketCounts: [...point.bucketCounts] });
      continue;
    }
    into.count += point.count;
    into.sum += point.sum;
    into.bucketCounts = into.bucketCounts.map((count, i) => count + point.bucketCounts[i]);
    into.min = Math.min(into.min ?? Infinity, point.min ?? Infinity);
    into.max = Math.max(into.max ?? -Infinity, point.max ?? -Infinity);
  }
  return [...merged.values()];
}

/**
 * Splits an export request of the project `tenantId` into `accepted`, `empty` and `refused`
 * points. Throws when the body is not an export request at all.
 */
export function readRequest(body, tenantId) {
  const result = { accepted: [], empty: [], refused: [] };
  const pending = [];
  if (!Array.isArray(body?.resourceMetrics)) throw new Error('resourceMetrics is not a list');
  for (const resourceMetrics of body.resourceMetrics) {
    const { map: sent, duplicated } = readAttributes(resourceMetrics.resource?.attributes);
    const resource = { ...sent, 'service.name': sent['service.name'] ?? '(unknown)' };
    resource['tenant.id'] = tenantId;
    const resourceReason = resourceRefusal(resource, duplicated);
    const metrics = (resourceMetrics.scopeMetrics ?? []).flatMap((scope) => scope.metrics ?? []);
    for (const metric of metrics) {
      const base = { resource, metric: metric.name };
      const metricReason = resourceReason ?? metricRefusal(metric);
      if (metricReason) {
        result.refused.push({ ...base, reason: metricReason });
        continue;
      }
      for (const point of metric.histogram.dataPoints ?? []) {
        readPoint(point, base, result, pending);
      }
    }
  }
  result.accepted = mergeSame(pending).map((point) => ({ ...point, ...identify(point) }));
  return result;
}
