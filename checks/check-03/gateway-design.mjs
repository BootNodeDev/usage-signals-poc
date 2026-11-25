// One ingest location as the architecture document describes it, reduced to what check 03
// needs: the per-visitor value and how it travels to Umami. Enrollment, tokens, spool and
// bot list are out of scope here. Needs GATEWAY_PORT, UMAMI_URL and DAILY_SALTS.
import { createHmac } from 'node:crypto';
import { canonicalAddress } from './address.mjs';
import { serve } from './serve.mjs';

// Same list as console/lib/gateway.js: a caller must never choose the salt.
const REFUSED_FIELDS = ['ip', 'userAgent', 'timestamp', 'id', 'salt', 'browser', 'os', 'device'];
// "A fixed placeholder address in the proxy header": an RFC 5737 documentation address.
// Umami ignores the country header for local or invalid addresses (src/lib/detect.ts:91).
// Read from the environment so that the check can make one location drift.
const PLACEHOLDER_ADDRESS = process.env.PLACEHOLDER_ADDRESS ?? '192.0.2.1';
// Umami hashes the address and the User-Agent it receives into the session id
// (src/lib/collection-session.ts:111), so both must be identical at every location, and its
// bot check silently drops requests whose User-Agent isbot matches (src/app/api/send/route.ts:97).
const FORWARDER_USER_AGENT = process.env.FORWARDER_USER_AGENT ?? 'Mozilla/5.0 (usage-signals forwarder)';
const FORWARD_TIMEOUT_MS = 5_000;
// The header in which the platform in front of the gateway puts the client address. Read
// from the environment so that the check can make one location read another header.
const CLIENT_ADDRESS_HEADER = process.env.CLIENT_ADDRESS_HEADER ?? 'x-vercel-forwarded-for';
const PROBE_PAGE = { hostname: 'probe.usage-signals.invalid', url: '/usage-signals-probe' };

// Test only: negative controls replace the normaliser to show that the check notices.
const ADDRESS_MUTATIONS = {
  'no-address-normalisation': (text) => text,
  'address-truncated-to-prefix': (text) => canonicalAddress(text).split(':').slice(0, 2).join(':'),
};
const addressForValue = ADDRESS_MUTATIONS[process.env.CHECK_MUTATION] ?? canonicalAddress;

// Test only: a negative control makes the probe ignore the request it arrived in.
const probeIgnoresRequest = process.env.CHECK_MUTATION === 'probe-skips-address-reading';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set.`);
  return value;
}

const port = Number(requireEnv('GATEWAY_PORT'));
const umamiUrl = requireEnv('UMAMI_URL');
// {"YYYY-MM-DD": "<salt>"}: the salts "generated a few days ahead", one per UTC day.
const dailySalts = JSON.parse(requireEnv('DAILY_SALTS'));
// Test only: lets the check place an event on another UTC day. It stands in for the
// original timestamp a spooled record carries.
const acceptsTestClock = process.env.CHECK_TEST_CLOCK === '1';

function receivedAt(request) {
  const forced = acceptsTestClock ? request.headers.get('x-check-clock') : null;
  return forced ? new Date(forced) : new Date();
}

function saltOfDay(instant) {
  const utcDay = instant.toISOString().slice(0, 10);
  const salt = dailySalts[utcDay];
  if (!salt) throw new Error(`no daily salt for UTC day ${utcDay}`);
  return salt;
}

/** Who sent the request, as this location sees it. */
function visitorOf(request) {
  return { address: request.headers.get(CLIENT_ADDRESS_HEADER), userAgent: request.headers.get('user-agent') };
}

/** The per-visitor value: full IP, raw User-Agent and site id, keyed with the daily salt. */
function visitorValue({ salt, address, userAgent, websiteId }) {
  const fields = [websiteId, addressForValue(address), userAgent];
  return createHmac('sha256', salt).update(fields.join('\n')).digest('hex');
}

// A stand-in for the document's reduction of the header; which parser does it is not
// part of this check.
function reduceUserAgent(userAgent) {
  const browser = /Firefox\//.test(userAgent) ? 'firefox' : /Chrome\//.test(userAgent) ? 'chrome' : 'safari';
  const os = /Windows/.test(userAgent) ? 'Windows 10' : /Mac OS X/.test(userAgent) ? 'Mac OS' : 'Linux';
  return { browser, os, device: /Mobile/.test(userAgent) ? 'mobile' : 'desktop' };
}

/** What the forwarder posts to Umami for one page view of one visitor. */
function umamiPayload({ websiteId, hostname, url, referrer, instant, address, userAgent }) {
  return {
    website: websiteId,
    hostname,
    url,
    referrer,
    timestamp: Math.floor(instant.getTime() / 1000),
    salt: visitorValue({ salt: saltOfDay(instant), address, userAgent, websiteId }),
    ...reduceUserAgent(userAgent),
  };
}

/** Posts one event to Umami and returns the session and visit Umami assigned to it. */
async function forward(payload, country) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': FORWARDER_USER_AGENT,
    'cf-connecting-ip': PLACEHOLDER_ADDRESS,
    // The check restarts Umami instances; a pooled connection would fail the next event.
    connection: 'close',
  };
  if (country) headers['cf-ipcountry'] = country;
  const response = await fetch(`${umamiUrl}/api/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'event', payload }),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  const answer = await response.json().catch(() => ({}));
  // Umami answers 200 {"beep":"boop"} when its bot check discards the event.
  if (!response.ok || !answer.sessionId) {
    throw new Error(`Umami did not store the event: HTTP ${response.status} ${JSON.stringify(answer)}`);
  }
  return { sessionId: answer.sessionId, visitId: answer.visitId };
}

async function acceptEvent(request) {
  const body = await request.json();
  const forged = REFUSED_FIELDS.filter((field) => field in body || field in body.payload);
  if (forged.length > 0) {
    return Response.json({ error: `Set by the gateway, must not be sent: ${forged.join(', ')}.` }, { status: 400 });
  }
  const { website, url, referrer } = body.payload;
  const payload = umamiPayload({
    websiteId: website.toLowerCase(),
    hostname: new URL(request.headers.get('origin')).hostname,
    url,
    referrer,
    instant: receivedAt(request),
    ...visitorOf(request),
  });
  await forward(payload, request.headers.get('x-vercel-ip-country'));
  return Response.json({}, { status: 202 });
}

// The drift probe. The caller is the synthetic visitor: its address and User-Agent are read
// from the request exactly as for a page view, then the per-visitor value for the given UTC
// day is computed and forwarded as for a page view, and the identity Umami derived is the
// answer. Two locations that would count one visitor twice give different answers. Unlike a
// page view, the probe takes the day and the website from its body, and skips the refused
// fields check and the Origin header. In production this route belongs on the authenticated
// link between the locations; here it is open on loopback.
async function probeEvent(request) {
  const { website, day } = await request.json();
  const instant = new Date(`${day}T12:00:00Z`);
  try {
    const visitor = probeIgnoresRequest ? { address: '192.0.2.99', userAgent: 'fixed' } : visitorOf(request);
    const payload = umamiPayload({ websiteId: website.toLowerCase(), instant, ...PROBE_PAGE, ...visitor });
    return Response.json(await forward(payload));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 503 });
  }
}

serve(`gateway-design:${port}`, port, async (request) => {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405 });
  if (new URL(request.url).pathname === '/api/probe') return probeEvent(request);
  try {
    return await acceptEvent(request);
  } catch (error) {
    console.error(`gateway-design:${port}: event not forwarded: ${error.message}`);
    return Response.json({ error: 'The event was not recorded.' }, { status: 503 });
  }
});
