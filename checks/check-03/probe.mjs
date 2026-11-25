// Drift probe for two ingest locations. It answers one question without reading or printing
// any setting: would the two locations give one visitor the same identity?
//
//   node probe.mjs umami <probe-website-id> <umami-url-a> <umami-url-b>
//   node probe.mjs gateways <probe-website-id> <gateway-url-a> <gateway-url-b> [YYYY-MM-DD ...]
//
// Exit code 0 when the locations agree, 1 when they do not. The website is one kept for the
// probe, so that its events never appear in a tenant's figures.
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 30_000;

// What a forwarder sends to Umami: the placeholder address and a User-Agent that Umami's bot
// check accepts. Any fixed values serve, because both instances receive the same ones.
const UMAMI_PROBE_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (usage-signals forwarder)',
  'cf-connecting-ip': '192.0.2.1',
};
const PROBE_PAGE = { hostname: 'probe.usage-signals.invalid', url: '/usage-signals-probe' };
// The synthetic visitor of the gateway probe. The address is deliberately not in canonical
// form, so two locations that normalise differently disagree as well. `x-forwarded-for` is
// how a caller states its address to the stand-in platform of this check (serve.mjs).
const GATEWAY_PROBE_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'usage-signals-probe',
  'x-forwarded-for': '2001:DB8:0:0:0:0:0:1%probe',
};
const PROBE_SALTS = ['usage-signals-probe-value-1', 'usage-signals-probe-value-2'];

/**
 * The instants at which the probe compares identities.
 *
 * Umami hashes the start of the event's day, week or month (SALT_ROTATION) and the start of
 * its hour, each taken in the time zone of the process and written as a UTC time. Two
 * instances agree at an instant when those starts are the same moment for both. The probe
 * looks at the current period and one period ahead of each kind, so that a difference which
 * begins tomorrow, next week or next month (a daylight-saving change in one zone only, or
 * two rotation periods that happen to start together today) is found before it counts.
 */
export function probeInstants(now = new Date()) {
  const instant = Math.floor(now.getTime() / 1000) * 1000;
  const midNextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15, 12);
  return [instant, instant + DAY_MS, instant + 7 * DAY_MS, midNextMonth];
}

async function postJson(url, headers, body) {
  // One connection per request: a pooled connection to an instance that has been restarted
  // since fails the next request instead of reconnecting.
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, connection: 'close' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, answer: await response.json().catch(() => ({})) };
}

/** The session and visit one Umami instance derives for the synthetic event at `instant`. */
async function umamiIdentity(umamiUrl, websiteId, instant, salt) {
  const payload = { website: websiteId, ...PROBE_PAGE, timestamp: instant / 1000, salt };
  const { status, answer } = await postJson(`${umamiUrl}/api/send`, UMAMI_PROBE_HEADERS, { type: 'event', payload });
  if (status !== 200 || !answer.sessionId) {
    const reason = answer.sessionId ? '' : ` ${JSON.stringify(answer)}`;
    throw new Error(`${umamiUrl} did not store the probe event: HTTP ${status}${reason}`);
  }
  return { sessionId: answer.sessionId, visitId: answer.visitId };
}

/**
 * Compares the identities two Umami instances derive for the same synthetic events.
 *
 * Returns `{ ok, compared, findings }`. A difference in APP_SECRET, ENABLE_CLIENT_SALT,
 * SALT_ROTATION or time zone shows as a finding. `instants` and `salts` exist so that the
 * check can weaken the probe on purpose.
 */
export async function compareUmami([urlA, urlB], websiteId, { instants = probeInstants(), salts = PROBE_SALTS } = {}) {
  const identitiesOf = (url, salt) => Promise.all(instants.map((instant) => umamiIdentity(url, websiteId, instant, salt)));
  const [a, b] = await Promise.all([urlA, urlB].map((url) => identitiesOf(url, salts[0])));
  const findings = [];
  const differing = instants.filter((_, index) => a[index].sessionId !== b[index].sessionId || a[index].visitId !== b[index].visitId);
  if (differing.length > 0) {
    const first = new Date(differing[0]).toISOString();
    findings.push(`identity differs at ${differing.length} of ${instants.length} instants, first at ${first}`);
  }
  if (salts.length > 1) {
    for (const [location, url, withFirstSalt] of [['A', urlA, a[0]], ['B', urlB, b[0]]]) {
      const withSecondSalt = await umamiIdentity(url, websiteId, instants[0], salts[1]);
      if (withSecondSalt.sessionId === withFirstSalt.sessionId) {
        findings.push(`location ${location} ignores the per-visitor value (ENABLE_CLIENT_SALT is not in effect)`);
      }
    }
  }
  return { ok: findings.length === 0, compared: instants.length, differing: differing.length, findings };
}

async function gatewayIdentity(gatewayUrl, websiteId, day) {
  const { status, answer } = await postJson(
    `${gatewayUrl}/api/probe`,
    GATEWAY_PROBE_HEADERS,
    { website: websiteId, day },
  ).catch((error) => ({ status: 0, answer: { error: error.message } }));
  if (status === 200 && answer.sessionId) return answer;
  return { error: answer.error ?? `HTTP ${status}` };
}

function dayStatus([a, b]) {
  if (a.error) return 'no answer from A';
  if (b.error) return 'no answer from B';
  return a.sessionId === b.sessionId && a.visitId === b.visitId ? 'agree' : 'disagree';
}

/**
 * Calls each gateway as one synthetic visitor on each UTC day and compares the identities
 * Umami derived.
 *
 * Returns `{ ok, days, findings }`, where `days` maps each day to `agree`, `disagree`,
 * `no answer from A` or `no answer from B`. A difference in the daily salt, the placeholder
 * address, the forwarder User-Agent, the normalisation of the address or the header the
 * address is read from shows as one of the last three; so does any difference between the
 * two Umami instances, which `compareUmami` tells apart.
 */
export async function compareGateways(gatewayUrls, websiteId, days) {
  const statusOfDay = {};
  const findings = [];
  for (const day of days) {
    const answers = await Promise.all(gatewayUrls.map((url) => gatewayIdentity(url, websiteId, day)));
    statusOfDay[day] = dayStatus(answers);
    if (statusOfDay[day] === 'agree') continue;
    const reasons = answers.map((answer) => answer.error).filter(Boolean);
    findings.push(`${day}: ${[statusOfDay[day], ...reasons].join(': ')}`);
  }
  return { ok: findings.length === 0, days: statusOfDay, findings };
}

async function commandLine([kind, websiteId, urlA, urlB, ...days]) {
  if (!['umami', 'gateways'].includes(kind) || !urlB) {
    console.error('Usage: node probe.mjs umami|gateways <probe-website-id> <url-a> <url-b> [YYYY-MM-DD ...]');
    return 2;
  }
  const today = new Date().toISOString().slice(0, 10);
  const result =
    kind === 'umami'
      ? await compareUmami([urlA, urlB], websiteId)
      : await compareGateways([urlA, urlB], websiteId, days.length > 0 ? days : [today]);
  console.log(`probe ${kind}: ${result.ok ? 'PASS, the locations agree' : 'DRIFT'}`);
  for (const finding of result.findings) console.log(`  ${finding}`);
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await commandLine(process.argv.slice(2)).catch((error) => {
    console.error(`probe did not complete: ${error.message}`);
    return 2;
  });
}
