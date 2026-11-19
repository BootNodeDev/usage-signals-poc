// Helpers of check 05: tenant tokens, OTLP/HTTP JSON payloads and SEP-23 strkeys.
import { createHmac, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';

export const ISSUER = 'https://ingest.usage-signals.invalid/tokens';
export const AUDIENCE = 'usage-signals-ingest';
export const DELTA = 1;
export const CUMULATIVE = 2;
// The bucket boundaries the semantic conventions advise for http.server.request.duration.
export const BOUNDS_S = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
export const BOUNDS_MS = BOUNDS_S.map((seconds) => Math.round(seconds * 1000));

const base64url = (value) => Buffer.from(value).toString('base64url');

export function newSigningKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  return { kid, privateKey, publicKey, jwk };
}

/** The claims of a tenant token that is valid now. */
export function tenantClaims(tenantId, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: tenantId,
    tenant_id: tenantId,
    jti: randomUUID(),
    iat: now - 5,
    exp: now + 3600,
    ...overrides,
  };
}

export function signRs256(claims, key, kid = key.kid) {
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const signingInput = `${head}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function unsignedToken(claims) {
  const head = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  return `${head}.${base64url(JSON.stringify(claims))}.`;
}

/** The algorithm-confusion attack: HMAC keyed with the public key. */
export function signHs256WithPublicKey(claims, key) {
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: key.kid }));
  const signingInput = `${head}.${base64url(JSON.stringify(claims))}`;
  const secret = key.publicKey.export({ type: 'spki', format: 'pem' });
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** Keeps the signature of a token and swaps its claims. */
export function withSwappedClaims(token, claims) {
  const [head, , signature] = token.split('.');
  return `${head}.${base64url(JSON.stringify(claims))}.${signature}`;
}

function anyValue(value) {
  if (typeof value === 'string') return { stringValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  throw new Error(`unsupported attribute value: ${value}`);
}

export function attributes(map) {
  return Object.entries(map).map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** Index of the bucket that holds a value, for upper-inclusive bounds. */
export function bucketIndex(value, bounds) {
  const index = bounds.findIndex((bound) => value <= bound);
  return index === -1 ? bounds.length : index;
}

/**
 * One histogram data point built from the durations of individual requests.
 * `durations` and `bounds` are in the same unit.
 */
export function histogramPoint({ attrs, durations, bounds, timeMs, withMinMax = true }) {
  const bucketCounts = new Array(bounds.length + 1).fill(0);
  for (const duration of durations) bucketCounts[bucketIndex(duration, bounds)] += 1;
  const point = {
    attributes: attributes(attrs),
    startTimeUnixNano: `${BigInt(timeMs - 60_000) * 1_000_000n}`,
    timeUnixNano: `${BigInt(timeMs) * 1_000_000n}`,
    count: String(durations.length),
    sum: durations.reduce((total, duration) => total + duration, 0),
    bucketCounts: bucketCounts.map(String),
    explicitBounds: bounds,
  };
  if (withMinMax) {
    point.min = Math.min(...durations);
    point.max = Math.max(...durations);
  }
  return point;
}

export function histogramMetric(name, unit, dataPoints, aggregationTemporality = DELTA) {
  return { name, unit, histogram: { aggregationTemporality, dataPoints } };
}

export function resourceMetrics(resourceAttrs, metrics) {
  return {
    resource: { attributes: attributes(resourceAttrs) },
    scopeMetrics: [{ scope: { name: 'check-05' }, metrics }],
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes) {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let text = '';
  for (let i = 0; i < bits.length; i += 5) {
    text += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return text;
}

function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// SEP-23 base values (the type, before the shift by three bits) and payload lengths in bytes.
const STRKEY_TYPES = {
  G: [6, 32],
  M: [12, 40],
  S: [18, 32],
  T: [19, 32],
  X: [23, 32],
  C: [2, 32],
  L: [11, 32],
  B: [1, 33],
  W: [22, 40],
};

/** SEP-23 encoding: version byte, payload, CRC-16 (low byte first), in base 32. */
export function strkeyOf(type, payload) {
  const [base, length] = STRKEY_TYPES[type];
  if (payload.length !== length) throw new Error(`a ${type} strkey holds ${length} bytes`);
  const body = [base << 3, ...payload];
  const crc = crc16Xmodem(body);
  return base32([...body, crc & 0xff, crc >> 8]);
}

/** A strkey with a valid checksum over a payload derived from the seed. */
export function strkey(type, seed) {
  const length = STRKEY_TYPES[type][1];
  return strkeyOf(
    type,
    Array.from({ length }, (_, i) => (seed * 31 + i * 17 + 7) & 0xff),
  );
}

/** A small deterministic generator, so that a run can be repeated from its seed. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
