// The metrics API for machine consumers: the operator figures behind an operator API key
// (`npm run api-key`). Versioned under /api/v1 so the answer can change without breaking callers.
import { verifyKey } from './api-keys.js';
import { listSites } from './db.js';
import { operatorFigures } from './operator-api.js';
import { badRange, json, rangeParam, unavailable } from './web-read.js';

// RFC 6750 section 3: a request with no key gets the bare challenge, a bad key `invalid_token`.
const CHALLENGE = 'Bearer realm="pulse"';
const INVALID = `${CHALLENGE}, error="invalid_token"`;
// Requests a key may make in one minute. The product's limit is to be agreed with SCF.
const DEFAULT_REQUESTS_PER_MINUTE = 60;

// Read once, so a wrong value stops the function at start instead of failing every request.
const REQUESTS_PER_MINUTE = requestsPerMinute();

function requestsPerMinute() {
  const value = Number(process.env.API_KEY_REQUESTS_PER_MINUTE ?? DEFAULT_REQUESTS_PER_MINUTE);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('API_KEY_REQUESTS_PER_MINUTE must be a whole number of 1 or more.');
  }
  return value;
}

function tooMany(limit) {
  const wait = 60 - new Date().getUTCSeconds();
  return json(429, { error: `This key may make ${limit} requests a minute. Retry later.` }, {
    'retry-after': String(wait),
  });
}

function bearer(request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  return match ? match[1] : null;
}

function refused(challenge, error) {
  return json(401, { error }, { 'www-authenticate': challenge });
}

/** GET /api/v1/projects?days=7|30|90 with `Authorization: Bearer <key>`. */
export async function handleMetricsProjects(request) {
  if (request.method !== 'GET') return json(405, { error: 'Use GET.' }, { allow: 'GET' });
  const key = bearer(request);
  if (!key) return refused(CHALLENGE, 'Send an operator API key as a Bearer token.');
  try {
    const granted = await verifyKey(key);
    if (!granted) return refused(INVALID, 'The API key is unknown or revoked.');
    if (granted.requests > REQUESTS_PER_MINUTE) return tooMany(REQUESTS_PER_MINUTE);
    const dayCount = rangeParam(request);
    if (!dayCount) return badRange();
    const sites = (await listSites()).filter(
      (site) => granted.tenantId === null || site.tenantId === granted.tenantId,
    );
    return json(200, await operatorFigures(sites, dayCount));
  } catch (error) {
    return unavailable(error);
  }
}
