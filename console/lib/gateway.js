// The only public write path for web events. It decides who the visitor is (address, user
// agent) from the connection and never from the body, then forwards to Umami.
import { truncatedClientAddress } from './client-address.js';
import { findSiteByWebsiteId, isDomainOfActiveTenant } from './db.js';
import { forwardToUmami } from './umami.js';

// Every field Umami's /api/send reads from the payload to identify or date a visitor.
const REFUSED_FIELDS = ['ip', 'userAgent', 'timestamp', 'id', 'salt', 'browser', 'os', 'device'];
const MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 2_048;
const MAX_EVENT_NAME_LENGTH = 50;
const MAX_USER_AGENT_LENGTH = 512;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// The headers the Umami 3.5.0 tracker sends with its cross-origin POST.
const TRACKER_HEADERS = 'content-type, x-umami-website-id, x-umami-hostname, x-umami-cache';
const PREFLIGHT_MAX_AGE_SECONDS = '600';
// The only upstream answers that say the event itself is unacceptable. Every other
// non-2xx answer means Umami could not take it, which the caller sees as 503.
const UPSTREAM_CONTENT_REJECTIONS = [400, 422];

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, body, headers = {}) {
  return Response.json(body, { status, headers });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength;
}

function corsHeaders(origin) {
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

// The hosts the Secure Contexts specification treats as trustworthy without TLS.
function isLoopback(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

function originHost(request) {
  const origin = request.headers.get('origin');
  if (!origin || !URL.canParse(origin)) return null;
  const { protocol, host, hostname } = new URL(origin);
  const allowed = protocol === 'https:' || (protocol === 'http:' && isLoopback(hostname));
  return allowed ? host : null;
}

async function readCappedText(request) {
  const tooLarge = new Refusal(413, `Body exceeds ${MAX_BODY_BYTES} bytes.`);
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw tooLarge;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
}

function hasNul(value) {
  if (typeof value === 'string') return value.includes('\u0000');
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => hasNul(key) || hasNul(nested));
}

async function readEvent(request) {
  const text = await readCappedText(request);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal(400, 'Body is not valid JSON.');
  }
  if (!isPlainObject(body) || body.type !== 'event' || !isPlainObject(body.payload)) {
    throw new Refusal(400, 'Expected {"type":"event","payload":{...}} as sent by the tracker.');
  }
  if (typeof body.payload.website !== 'string' || !UUID.test(body.payload.website)) {
    throw new Refusal(400, 'payload.website must be the website id from the tracking tag.');
  }
  // RFC 9562 allows either case for the same UUID; Umami hashes the text it is given.
  body.payload.website = body.payload.website.toLowerCase();
  return body;
}

async function authorizeOrigin(request, websiteId) {
  const host = originHost(request);
  const site = host && (await findSiteByWebsiteId(websiteId));
  if (!site || site.tenantStatus !== 'active' || site.domain !== host) {
    throw new Refusal(403, 'Origin is not a registered domain of an active project.');
  }
  return { origin: request.headers.get('origin'), hostname: new URL(`http://${host}`).hostname };
}

function refuseForgedFields(body) {
  const forged = REFUSED_FIELDS.filter((field) => field in body || field in body.payload);
  if (forged.length > 0) {
    throw new Refusal(400, `These fields are set by the gateway and must not be sent: ${forged.join(', ')}.`);
  }
}

function allowedEventFields({ url, referrer, name, data }) {
  if (!isText(url, MAX_URL_LENGTH) || url === '') {
    throw new Refusal(400, 'payload.url must be a non-empty string.');
  }
  if (referrer !== undefined && !isText(referrer, MAX_URL_LENGTH)) {
    throw new Refusal(400, 'payload.referrer must be a string.');
  }
  if (name !== undefined && !isText(name, MAX_EVENT_NAME_LENGTH)) {
    throw new Refusal(400, `payload.name must be a string of at most ${MAX_EVENT_NAME_LENGTH} characters.`);
  }
  if (data !== undefined && !isPlainObject(data)) {
    throw new Refusal(400, 'payload.data must be an object.');
  }
  if (hasNul({ url, referrer, name, data })) {
    throw new Refusal(400, 'url, referrer, name and data must not contain NUL characters.');
  }
  return { url, referrer, name, data };
}

// Set by Vercel from the visitor's address; absent elsewhere and for unknown addresses.
function platformCountry(headers) {
  const country = headers.get('x-vercel-ip-country');
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

function visitorIdentity(request) {
  const address = truncatedClientAddress(request.headers);
  if (!address) {
    throw new Error('the platform supplied no valid client address (x-vercel-forwarded-for)');
  }
  const userAgent = request.headers.get('user-agent');
  if (!userAgent || userAgent.length > MAX_USER_AGENT_LENGTH) {
    throw new Refusal(400, 'A User-Agent header is required.');
  }
  return { address, userAgent, country: platformCountry(request.headers) };
}

async function acceptEvent(request) {
  const body = await readEvent(request);
  const { origin, hostname } = await authorizeOrigin(request, body.payload.website);
  refuseForgedFields(body);
  const { userAgent, ...visitor } = visitorIdentity(request);
  const event = { website: body.payload.website, hostname, ...allowedEventFields(body.payload) };
  const status = await forwardToUmami({ ...event, userAgent }, visitor);
  if (UPSTREAM_CONTENT_REJECTIONS.includes(status)) {
    throw new Refusal(400, 'The analytics store rejected the event as malformed.');
  }
  if (status < 200 || status >= 300) throw new Error(`Umami answered HTTP ${status}`);
  return json(202, {}, corsHeaders(origin));
}

async function answerPreflight(request) {
  const host = originHost(request);
  if (!host || !(await isDomainOfActiveTenant(host))) {
    throw new Refusal(403, 'Origin is not a registered domain of an active project.');
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request.headers.get('origin')),
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': TRACKER_HEADERS,
      'access-control-max-age': PREFLIGHT_MAX_AGE_SECONDS,
    },
  });
}

/** Handles the tracker endpoint: 202 accepted, 400/403/413 refused, 503 when a dependency is down. */
export async function handleEvent(request) {
  try {
    if (request.method === 'OPTIONS') return await answerPreflight(request);
    if (request.method === 'POST') return await acceptEvent(request);
    return json(405, { error: 'Use POST.' }, { allow: 'POST, OPTIONS' });
  } catch (error) {
    if (error instanceof Refusal) return json(error.status, { error: error.message });
    console.error(`gateway: event not forwarded: ${error.message}`);
    return json(503, { error: 'The event was not recorded. Retry later.' });
  }
}
