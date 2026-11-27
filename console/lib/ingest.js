// POST /v1/metrics: OTLP/HTTP JSON from a project's OpenTelemetry exporter, with its ingest
// token as Bearer. The standard OTLP path, so OTEL_EXPORTER_OTLP_ENDPOINT can name this host.
// Answers follow OTLP: 200, with partialSuccess for points refused for good; 400 for a body
// that can never be read; 503 when storage is down, which exporters retry.
// https://opentelemetry.io/docs/specs/otlp/#otlphttp-response
import { verifyIngestToken } from './ingest-tokens.js';
import { storePoints } from './metrics-store.js';
import { readRequest } from './otlp-metrics.js';

// The product's collector refuses larger bodies too.
const MAX_BODY_BYTES = 1_048_576;
const CHALLENGE = 'Bearer realm="pulse"';
const INVALID = `${CHALLENGE}, error="invalid_token"`;

function answer(status, body, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function bearer(request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match ? match[1] : null;
}

/** The body as text, or null when it is larger than the limit. */
async function bodyText(request) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_BODY_BYTES ? null : new TextDecoder().decode(bytes);
}

function partialSuccess(refused) {
  if (refused.length === 0) return {};
  const rejectedDataPoints = String(refused.length);
  return { partialSuccess: { rejectedDataPoints, errorMessage: refused[0].reason } };
}

export async function handleIngest(request) {
  if (request.method !== 'POST') return answer(405, { message: 'Use POST.' }, { allow: 'POST' });
  const token = bearer(request);
  if (!token) {
    return answer(401, { message: 'Send an ingest token.' }, { 'www-authenticate': CHALLENGE });
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return answer(415, { message: 'Send OTLP/HTTP JSON (application/json).' });
  }
  try {
    const granted = await verifyIngestToken(token);
    if (!granted) {
      return answer(401, { message: 'The ingest token is unknown, expired or revoked.' }, {
        'www-authenticate': INVALID,
      });
    }
    const text = await bodyText(request);
    if (text === null) return answer(413, { message: 'The body is larger than 1 MiB.' });
    let read;
    try {
      read = readRequest(JSON.parse(text), granted.tenantId);
    } catch {
      return answer(400, { message: 'The body is not an OTLP/HTTP JSON export request.' });
    }
    const stored = await storePoints(read.accepted, read.refused);
    return answer(200, partialSuccess(stored.refused));
  } catch (error) {
    console.error(`ingest: storage unavailable: ${error.message}`);
    return answer(503, { message: 'Metrics cannot be stored right now. Retry later.' });
  }
}
