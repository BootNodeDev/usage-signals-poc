// One ingest location as the architecture document describes it, reduced to what check 03
// needs: the per-visitor value and how it travels to Umami. Enrollment, tokens, spool and
// bot list are out of scope here. Needs GATEWAY_PORT, UMAMI_URL and DAILY_SALTS.
import { createHmac } from 'node:crypto';
import { serve } from './serve.mjs';

// Same list as console/lib/gateway.js: a caller must never choose the salt.
const REFUSED_FIELDS = ['ip', 'userAgent', 'timestamp', 'id', 'salt', 'browser', 'os', 'device'];
// "A fixed placeholder address in the proxy header": an RFC 5737 documentation address.
// Umami ignores the country header for local or invalid addresses (src/lib/detect.ts:91).
const PLACEHOLDER_ADDRESS = '192.0.2.1';
// Umami hashes the address and the User-Agent it receives into the session id
// (src/lib/collection-session.ts:111), so both must be identical at every location, and its
// bot check silently drops requests whose User-Agent isbot matches (src/app/api/send/route.ts:97).
const FORWARDER_USER_AGENT = 'Mozilla/5.0 (usage-signals forwarder)';
const FORWARD_TIMEOUT_MS = 5_000;

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

/** The per-visitor value: full IP, raw User-Agent and site id, keyed with the daily salt. */
function visitorValue({ salt, address, userAgent, websiteId }) {
  return createHmac('sha256', salt).update([websiteId, address, userAgent].join('\n')).digest('hex');
}

// A stand-in for the document's reduction of the header; which parser does it is not
// part of this check.
function reduceUserAgent(userAgent) {
  const browser = /Firefox\//.test(userAgent) ? 'firefox' : /Chrome\//.test(userAgent) ? 'chrome' : 'safari';
  const os = /Windows/.test(userAgent) ? 'Windows 10' : /Mac OS X/.test(userAgent) ? 'Mac OS' : 'Linux';
  return { browser, os, device: /Mobile/.test(userAgent) ? 'mobile' : 'desktop' };
}

async function forward(payload, country) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': FORWARDER_USER_AGENT,
    'cf-connecting-ip': PLACEHOLDER_ADDRESS,
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
}

async function acceptEvent(request) {
  const body = await request.json();
  const forged = REFUSED_FIELDS.filter((field) => field in body || field in body.payload);
  if (forged.length > 0) {
    return Response.json({ error: `Set by the gateway, must not be sent: ${forged.join(', ')}.` }, { status: 400 });
  }
  const address = request.headers.get('x-vercel-forwarded-for');
  const userAgent = request.headers.get('user-agent');
  const instant = receivedAt(request);
  const { website, url, referrer } = body.payload;
  const websiteId = website.toLowerCase();
  const salt = visitorValue({ salt: saltOfDay(instant), address, userAgent, websiteId });
  const payload = {
    website: websiteId,
    hostname: new URL(request.headers.get('origin')).hostname,
    url,
    referrer,
    timestamp: Math.floor(instant.getTime() / 1000),
    salt,
    ...reduceUserAgent(userAgent),
  };
  await forward(payload, request.headers.get('x-vercel-ip-country'));
  return Response.json({}, { status: 202 });
}

serve(`gateway-design:${port}`, port, async (request) => {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST.' }, { status: 405 });
  try {
    return await acceptEvent(request);
  } catch (error) {
    console.error(`gateway-design:${port}: event not forwarded: ${error.message}`);
    return Response.json({ error: 'The event was not recorded.' }, { status: 503 });
  }
});
