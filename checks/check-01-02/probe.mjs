// Contract probe: the conditions under which forwarding through Umami's batch route gives the
// same metrics as direct ingestion, checked against a running Umami by sending a few canary
// events through the forwarder and reading them back. Umami answers 200 to events it drops,
// so nothing here trusts a response.
//
//   UMAMI_URL=... UMAMI_USERNAME=... UMAMI_PASSWORD=... node probe.mjs
//   optional: FORWARDER_USER_AGENT, PLACEHOLDER_ADDRESS
//
// Exits 1 and names each violated condition. It creates two websites and deletes them.
import { randomBytes } from 'node:crypto';
import { createForwarder } from './forwarder.mjs';
import { reduceUserAgent } from './gateway.mjs';
import { mutated } from './mutation.mjs';
import { createWebsite, deleteWebsite, login, metrics, post } from './stack.mjs';

const CANARY_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
];
const CANARY_COUNTRIES = ['UY', 'NZ'];

// Every canary is its own visitor. The last one repeats the first one's browser and country,
// so only the salt tells those two apart.
function canaryRecords(site, reduce, timestamp) {
  const combinations = CANARY_COUNTRIES.flatMap((country) =>
    CANARY_USER_AGENTS.map((userAgent) => ({ country, userAgent })),
  );
  return [...combinations, combinations[0]].map(({ country, userAgent }, index) => ({
    site,
    timestamp,
    url: `/probe/${index}`,
    referrer: '',
    country,
    ...reduce(userAgent),
    quality: 'ok',
    visitor: randomBytes(16).toString('hex'),
    pageStart: timestamp,
  }));
}

function expectedCountries(records) {
  const counts = {};
  for (const record of records) counts[record.country] = (counts[record.country] ?? 0) + 1;
  return Object.entries(counts).map(([country, count]) => `${country}=${count}`).sort().join(', ');
}

const labelNames = (breakdown) => breakdown.split(', ').map((pair) => pair.split('=')[0]).join(', ');

function findViolations({ records, acknowledged, direct, forwarded }) {
  const stored = mutated('probe-trusts-response') ? acknowledged : forwarded['page views'];
  if (stored !== records.length) {
    const detail = `Umami acknowledged ${acknowledged} of ${records.length} events and holds ${stored}.`;
    return [{ condition: 'forwarder User-Agent', detail: `${detail} Its bot check drops this User-Agent.` }];
  }
  // Labels and countries are read per visitor, so they mean nothing once visitors collapse.
  if (forwarded['unique visitors'] !== records.length) {
    const detail = `${records.length} visitors sent, Umami counts ${forwarded['unique visitors']}.`;
    return [{ condition: 'ENABLE_CLIENT_SALT', detail: `${detail} It ignores the salt.` }];
  }
  const violations = [];
  for (const label of ['browser', 'os', 'device']) {
    const [sent, own] = [labelNames(forwarded[label]), labelNames(direct[label])];
    if (sent !== own) {
      const detail = `the gateway sends "${sent}", Umami's own detection gives "${own}".`;
      violations.push({ condition: `${label} labels`, detail });
    }
  }
  const expected = expectedCountries(records);
  if (forwarded.country !== expected && !mutated('probe-ignores-country')) {
    const lost = /null|none/.test(forwarded.country);
    const condition = lost ? 'placeholder address' : 'one batch per country';
    const reason = lost ? 'Umami discards the country header.' : 'A batch carried more than one country.';
    violations.push({ condition, detail: `sent "${expected}", stored "${forwarded.country}". ${reason}` });
  }
  return violations;
}

// `forwarder` and `reduce` are the deployment's own: the forwarder options (User-Agent,
// placeholder address, batch planner) and the gateway's User-Agent reducer.
export async function contractProbe({ umamiUrl, auth, forwarder = {}, reduce = reduceUserAgent }) {
  const directSite = await createWebsite(umamiUrl, auth, 'contract probe, direct');
  const forwardedSite = await createWebsite(umamiUrl, auth, 'contract probe, forwarded');
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const userAgent of CANARY_USER_AGENTS) {
      const payload = { website: directSite, hostname: 'check.test', url: '/probe' };
      await post(umamiUrl, '/api/send', { type: 'event', payload }, { 'user-agent': userAgent });
    }
    const records = canaryRecords(forwardedSite, reduce, now - 60);
    const sender = createForwarder({ umamiUrl, ...forwarder });
    await sender.flush(records);
    const range = { startAt: (now - 3600) * 1000, endAt: (now + 60) * 1000 };
    const acknowledged = [...sender.ledger.values()].reduce((sum, count) => sum + count, 0);
    return findViolations({
      records,
      acknowledged,
      direct: await metrics(umamiUrl, auth, directSite, range),
      forwarded: await metrics(umamiUrl, auth, forwardedSite, range),
    });
  } finally {
    await deleteWebsite(umamiUrl, auth, directSite);
    await deleteWebsite(umamiUrl, auth, forwardedSite);
  }
}

if (import.meta.main) {
  const { UMAMI_URL, UMAMI_USERNAME, UMAMI_PASSWORD, FORWARDER_USER_AGENT, PLACEHOLDER_ADDRESS } = process.env;
  if (!UMAMI_URL || !UMAMI_USERNAME || !UMAMI_PASSWORD) {
    throw new Error('Set UMAMI_URL, UMAMI_USERNAME and UMAMI_PASSWORD (an Umami admin).');
  }
  const forwarder = {};
  if (FORWARDER_USER_AGENT) forwarder.userAgent = FORWARDER_USER_AGENT;
  if (PLACEHOLDER_ADDRESS) forwarder.placeholder = PLACEHOLDER_ADDRESS;
  const auth = await login(UMAMI_URL, UMAMI_USERNAME, UMAMI_PASSWORD);
  const violations = await contractProbe({ umamiUrl: UMAMI_URL, auth, forwarder });
  for (const { condition, detail } of violations) console.log(`VIOLATED ${condition}: ${detail}`);
  if (violations.length === 0) console.log('Contract holds: every condition was read back from Umami.');
  process.exit(violations.length === 0 ? 0 : 1);
}
