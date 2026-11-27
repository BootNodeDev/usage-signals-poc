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
  const { attrs = ATTRS, durations = [0.02, 0.3], metric = {}, resource = {}, timeMs = NOW } = options;
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
});
