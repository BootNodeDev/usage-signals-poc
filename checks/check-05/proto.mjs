// A minimal protobuf encoder for an OTLP metrics export request with histograms, written for
// check 05 so that a request can carry what no SDK would send, such as the same attribute key
// twice. Field numbers are those of opentelemetry-proto v1.9.0 (metrics.proto, common.proto,
// resource.proto). It takes the same object shape as the OTLP JSON bodies in run.mjs.

function varint(value) {
  let rest = BigInt(value);
  const bytes = [];
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest > 0n ? low | 0x80 : low);
  } while (rest > 0n);
  return Buffer.from(bytes);
}

const tag = (field, wireType) => varint((field << 3) | wireType);
const bytesField = (field, buffer) => Buffer.concat([tag(field, 2), varint(buffer.length), buffer]);
const stringField = (field, text) =>
  text ? bytesField(field, Buffer.from(text, 'utf8')) : Buffer.alloc(0);

function fixed64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function double(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return buffer;
}

const fixed64Field = (field, value) => Buffer.concat([tag(field, 1), fixed64(value)]);
const doubleField = (field, value) => Buffer.concat([tag(field, 1), double(value)]);

function anyValue(value) {
  if (value.stringValue !== undefined) return bytesField(1, Buffer.from(value.stringValue, 'utf8'));
  if (value.intValue !== undefined) return Buffer.concat([tag(3, 0), varint(value.intValue)]);
  throw new Error('this encoder writes string and integer attribute values only');
}

const keyValue = ({ key, value }) =>
  Buffer.concat([stringField(1, key), bytesField(2, anyValue(value))]);
const keyValues = (field, list) => (list ?? []).map((item) => bytesField(field, keyValue(item)));

function histogramPoint(point) {
  return Buffer.concat([
    fixed64Field(2, point.startTimeUnixNano),
    fixed64Field(3, point.timeUnixNano),
    fixed64Field(4, point.count),
    doubleField(5, point.sum),
    bytesField(6, Buffer.concat(point.bucketCounts.map(fixed64))),
    bytesField(7, Buffer.concat(point.explicitBounds.map(double))),
    ...keyValues(9, point.attributes),
    ...(point.min === undefined ? [] : [doubleField(11, point.min), doubleField(12, point.max)]),
  ]);
}

function metric(item) {
  const histogram = Buffer.concat([
    ...item.histogram.dataPoints.map((point) => bytesField(1, histogramPoint(point))),
    tag(2, 0),
    varint(item.histogram.aggregationTemporality),
  ]);
  return Buffer.concat([
    stringField(1, item.name),
    stringField(3, item.unit),
    bytesField(9, histogram),
  ]);
}

function scopeMetrics(item) {
  const scope = Buffer.concat([
    stringField(1, item.scope?.name),
    ...keyValues(3, item.scope?.attributes),
  ]);
  return Buffer.concat([
    bytesField(1, scope),
    ...item.metrics.map((m) => bytesField(2, metric(m))),
  ]);
}

function resourceMetrics(item) {
  const resource = Buffer.concat(keyValues(1, item.resource.attributes));
  return Buffer.concat([
    bytesField(1, resource),
    ...item.scopeMetrics.map((scope) => bytesField(2, scopeMetrics(scope))),
  ]);
}

/** The body of POST /v1/metrics with content type application/x-protobuf. */
export function encodeMetricsRequest(body) {
  return Buffer.concat(body.resourceMetrics.map((item) => bytesField(1, resourceMetrics(item))));
}
