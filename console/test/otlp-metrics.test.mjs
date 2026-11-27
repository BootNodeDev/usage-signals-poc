// Reading an OTLP/HTTP JSON export request: the check 5 writer's rules, with the tenant taken
// from the ingest token and the routes normalised as the collector would.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOUNDS_S,
  CUMULATIVE,
  histogramMetric,
  histogramPoint,
  resourceMetrics,
} from '../../checks/check-05/lib.mjs';
import { readRequest } from '../lib/otlp-metrics.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const NAME = 'http.server.request.duration';
const NOW = Date.now();
const ATTRS = {
  'http.route': '/users/123',
  'http.request.method': 'GET',
  'http.response.status_code': 200,
};

function request(options) {
  const { attrs = ATTRS, durations = [0.02, 0.3], metric = {}, resource = {} } = options;
  const { timeMs = NOW } = options;
  const point = histogramPoint({ attrs, durations, bounds: BOUNDS_S, timeMs });
  const { name = NAME, unit = 's', temporality } = metric;
  const built = histogramMetric(name, unit, [point], temporality);
  const attributes = { 'service.name': 'demo-api', ...resource };
  return { resourceMetrics: [resourceMetrics(attributes, [built])] };
}

const reasons = (result) => result.refused.map((item) => item.reason);

describe('reading an OTLP export request', () => {
  it('accepts a delta histogram under the token tenant, with the route normalised', () => {
    const sentTenant = 'b0000000-0000-4000-8000-000000000002';
    const result = readRequest(request({ resource: { 'tenant.id': sentTenant } }), TENANT);
    assert.equal(result.accepted.length, 1);
    const [point] = result.accepted;
    assert.equal(point.resource['tenant.id'], TENANT, 'the token decides the tenant');
    assert.equal(point.attributes['http.route'], '/users/{id}');
    assert.equal(point.count, 2);
    assert.match(point.key, /^[0-9a-f-]{36}$/);
  });

  it('names a point without a route (unmatched)', () => {
    const { 'http.route': _, ...rest } = ATTRS;
    const [point] = readRequest(request({ attrs: rest }), TENANT).accepted;
    assert.equal(point.attributes['http.route'], '(unmatched)');
  });

  it('refuses other metrics, cumulative data, other units and other bounds, with a reason', () => {
    const refused = [
      readRequest(request({ metric: { name: 'http.client.request.duration' } }), TENANT),
      readRequest(request({ metric: { temporality: CUMULATIVE } }), TENANT),
      readRequest(request({ metric: { unit: 'ms' } }), TENANT),
    ].flatMap(reasons);
    assert.deepEqual(refused, [
      'not the HTTP server duration metric',
      'temporality is not delta',
      'unit is not seconds',
    ]);
    const body = request({});
    const [point] = body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
    point.explicitBounds = [0, 5, 10];
    assert.deepEqual(reasons(readRequest(body, TENANT)), ['bucket bounds differ from the layout']);
  });

  it('refuses a point without a status code, and one older than the kept keys', () => {
    const { 'http.response.status_code': _, ...rest } = ATTRS;
    const noStatus = readRequest(request({ attrs: rest }), TENANT);
    assert.deepEqual(reasons(noStatus), ['no valid status code']);
    const old = request({ timeMs: NOW - 10 * 86_400_000 });
    const tooOld = reasons(readRequest(old, TENANT));
    assert.deepEqual(tooOld, ['older than the de-duplication keys that are kept']);
  });

  it('keeps a zero-count point apart, as valid with nothing to store', () => {
    const result = readRequest(request({ durations: [] }), TENANT);
    const sizes = [result.accepted.length, result.empty.length, result.refused.length];
    assert.deepEqual(sizes, [0, 1, 0]);
  });

  it('gives a redelivered point the same key, and another point another key', () => {
    const body = request({});
    const [first] = readRequest(body, TENANT).accepted;
    const [again] = readRequest(structuredClone(body), TENANT).accepted;
    const failed = request({ attrs: { ...ATTRS, 'http.response.status_code': 500 } });
    const [other] = readRequest(failed, TENANT).accepted;
    assert.equal(first.key, again.key);
    assert.notEqual(first.key, other.key);
  });

  it('throws on a body that is not an export request', () => {
    assert.throws(() => readRequest({}, TENANT), /resourceMetrics/);
    assert.throws(() => readRequest(null, TENANT), /resourceMetrics/);
  });

  it('names a route that is not text (unmatched), and keeps the rest of the request', () => {
    const shapes = [
      { intValue: '5' },
      { boolValue: true },
      { doubleValue: 1.5 },
      { arrayValue: { values: [{ stringValue: '/users/123' }] } },
      { kvlistValue: { values: [] } },
      { bytesValue: 'AAAA' },
    ];
    for (const value of shapes) {
      const body = request({});
      const [point] = body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
      const swap = (a) => (a.key === 'http.route' ? { key: a.key, value } : a);
      point.attributes = point.attributes.map(swap);
      const { accepted } = readRequest(body, TENANT);
      assert.equal(accepted[0]?.attributes['http.route'], '(unmatched)', JSON.stringify(value));
    }
  });

  it('keeps only an integer status code and a text service name, as the collector does', () => {
    const body = request({});
    const [point] = body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
    point.attributes = point.attributes.map((a) =>
      a.key === 'http.response.status_code' ? { key: a.key, value: { doubleValue: 200 } } : a,
    );
    assert.deepEqual(reasons(readRequest(body, TENANT)), ['no valid status code']);
    const numeric = request({ resource: { 'service.name': 7 } });
    assert.equal(readRequest(numeric, TENANT).accepted[0].resource['service.name'], '(unknown)');
  });

  it('adds up points whose routes become the same, as the collector merges them', () => {
    const body = request({ attrs: { ...ATTRS, 'http.route': '/users/1' } });
    const [metric] = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const twin = structuredClone(metric.histogram.dataPoints[0]);
    twin.attributes = twin.attributes.map((a) =>
      a.key === 'http.route' ? { key: a.key, value: { stringValue: '/users/3' } } : a,
    );
    metric.histogram.dataPoints.push(twin);
    const { accepted } = readRequest(body, TENANT);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].attributes['http.route'], '/users/{id}');
    assert.equal(accepted[0].count, 4);
    assert.equal(accepted[0].bucketCounts.reduce((a, b) => a + b, 0), 4);
  });

  it('refuses a point more than 5 minutes ahead of the clock', () => {
    const ahead = readRequest(request({ timeMs: Date.now() + 10 * 60_000 }), TENANT);
    assert.deepEqual(reasons(ahead), ['in the future']);
    const soon = readRequest(request({ timeMs: Date.now() + 60_000 }), TENANT);
    assert.equal(soon.accepted.length, 1);
  });

  it('counts every data point of a refused metric', () => {
    const body = request({ metric: { temporality: CUMULATIVE } });
    const [metric] = body.resourceMetrics[0].scopeMetrics[0].metrics;
    metric.histogram.dataPoints.push(structuredClone(metric.histogram.dataPoints[0]));
    metric.histogram.dataPoints.push(structuredClone(metric.histogram.dataPoints[0]));
    assert.equal(readRequest(body, TENANT).refused.length, 3);
  });

  it('refuses a malformed data point alone and keeps the others', () => {
    const body = request({});
    const [metric] = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const good = metric.histogram.dataPoints[0];
    metric.histogram.dataPoints = [
      { ...good, bucketCounts: 'not a list' },
      { ...good, attributes: 'not a list' },
      null,
      { ...good, explicitBounds: '0123456789abcd' },
      good,
    ];
    const result = readRequest(body, TENANT);
    assert.equal(result.accepted.length, 1);
    assert.deepEqual([...new Set(reasons(result))], ['malformed data point']);
    assert.equal(result.refused.length, 4);
  });

  it('takes at most 1,000 points from one request and refuses the rest', () => {
    const body = request({});
    const [metric] = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const good = metric.histogram.dataPoints[0];
    metric.histogram.dataPoints = Array.from({ length: 1005 }, (_, i) => {
      const point = structuredClone(good);
      point.attributes = point.attributes.map((a) =>
        a.key === 'http.route' ? { key: a.key, value: { stringValue: `/r${i}` } } : a,
      );
      return point;
    });
    const result = readRequest(body, TENANT);
    assert.equal(result.accepted.length, 1000);
    assert.deepEqual(reasons(result), Array(5).fill('more points than one request may carry'));
  });

  it('counts an exact copy of a point inside one request once', () => {
    const body = request({});
    const [metric] = body.resourceMetrics[0].scopeMetrics[0].metrics;
    metric.histogram.dataPoints.push(structuredClone(metric.histogram.dataPoints[0]));
    const { accepted } = readRequest(body, TENANT);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].count, 2);
  });

  it('counts every data point of a refused gauge, sum or summary', () => {
    const points = [{ asDouble: 1 }, { asDouble: 2 }, { asDouble: 3 }];
    for (const shape of ['gauge', 'sum', 'summary', 'exponentialHistogram']) {
      const body = { resourceMetrics: [{
        resource: { attributes: [] },
        scopeMetrics: [{ metrics: [{ name: 'x', [shape]: { dataPoints: points } }] }],
      }] };
      assert.equal(readRequest(body, TENANT).refused.length, 3, shape);
    }
  });

  it('refuses a null metric or scope as malformed and keeps the rest', () => {
    const body = request({});
    body.resourceMetrics[0].scopeMetrics.push(null);
    body.resourceMetrics[0].scopeMetrics[0].metrics.push(null);
    const result = readRequest(body, TENANT);
    assert.equal(result.accepted.length, 1);
    assert.deepEqual(reasons(result), ['malformed metric', 'malformed metric']);
  });
});
