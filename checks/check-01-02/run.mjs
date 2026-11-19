// Checks 1 and 2 of the architecture document's proof-of-concept list, as one experiment.
// Starts an isolated stack, sends the same visits into Umami 3.5.0 two ways, compares the
// seven metrics, probes placeholder addresses, scans a database dump and the logs for
// addresses, prints the evidence and the verdicts, and exits 1 if a verdict would change.
//
//   node run.mjs          run and bring the stack down
//   node run.mjs --keep   leave the stack up afterwards
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const COMPOSE = ['compose', '-p', 'us-check-01', '-f', path.join(HERE, 'compose.yml')];
const UMAMI = 'http://127.0.0.1:33101'; // ENABLE_CLIENT_SALT=1
const UMAMI_DEFAULTS = 'http://127.0.0.1:33102'; // default settings
const HOUR = 3600;
const MINUTE = 60;
// Five hours ago, on the hour: every event is a replay from the past.
const T0 = Math.floor(Date.now() / 1000 / HOUR) * HOUR - 5 * HOUR;

// What the forwarder sends in place of each visitor's own address and user agent.
const PLACEHOLDER_ADDRESS = '192.0.2.1'; // TEST-NET-1, RFC 5737: never a real visitor
// Umami runs its bot check on this header for every item. A plain product token, or the usual
// "(compatible; Name/1.0)" form, is classed as a bot and the whole batch is dropped in silence.
const FORWARDER_USER_AGENT = 'Mozilla/5.0 UsageSignalsForwarder/1.0';
const DAILY_SECRET = 'check-01-daily-salt';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// `address` and `userAgent` are what a browser shows Umami directly. `country`, `browser`,
// `os` and `device` are what the gateway would work out and hand to the forwarder.
const VISITORS = {
  threePages: { address: '8.8.8.8', userAgent: CHROME_WINDOWS, country: 'US', browser: 'chrome', os: 'Windows 10', device: 'desktop' },
  bounce: { address: '200.45.191.35', userAgent: SAFARI_IPHONE, country: 'AR', browser: 'ios', os: 'iOS', device: 'mobile' },
  acrossTheHour: { address: '8.8.4.4', userAgent: FIREFOX_LINUX, country: 'US', browser: 'firefox', os: 'Linux', device: 'desktop' },
  twoPages: { address: '2a00:1450:4001:81b::200e', userAgent: CHROME_MAC, country: 'DE', browser: 'chrome', os: 'Mac OS', device: 'desktop' },
  // Same browser build as threePages, another household: only the address tells them apart.
  sameBrowser: { address: '1.1.1.1', userAgent: CHROME_WINDOWS, country: 'AU', browser: 'chrome', os: 'Windows 10', device: 'desktop' },
};
const TRUNCATED = ['8.8.8.0', '200.45.191.0', '8.8.4.0', '2a00:1450:4001::', '1.1.1.0'];

const EVENTS = [
  ['threePages', 5 * MINUTE, '/', 'https://stellar.org/learn'],
  ['threePages', 7 * MINUTE, '/pricing', '/'],
  ['threePages', 12 * MINUTE, '/docs', '/pricing'],
  ['bounce', 10 * MINUTE, '/', 'https://news.ycombinator.com/item?id=1'],
  ['acrossTheHour', 50 * MINUTE, '/', ''],
  ['acrossTheHour', 70 * MINUTE, '/docs', '/'],
  ['twoPages', 2 * HOUR + 1 * MINUTE, '/', 'https://stellar.org/'],
  ['twoPages', 2 * HOUR + 4 * MINUTE, '/pricing', '/'],
  ['sameBrowser', 3 * HOUR + 20 * MINUTE, '/', ''],
].map(([visitor, offset, url, referrer]) => ({ visitor, timestamp: T0 + offset, url, referrer }));

function docker(args, options = {}) {
  return execFileSync('docker', [...COMPOSE, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
}

async function post(base, route, body, headers) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function login(base) {
  const { status, body } = await post(base, '/api/auth/login', { username: 'admin', password: 'umami' });
  if (status !== 200) throw new Error(`Umami login at ${base} answered ${status}. Is the us-check-01 stack up?`);
  return { authorization: `Bearer ${body.token}` };
}

async function createWebsite(auth, name) {
  const id = randomUUID();
  const { status } = await post(UMAMI, '/api/websites', { id, name, domain: 'check.test' }, auth);
  if (status !== 200) throw new Error(`Umami refused to create website "${name}" (HTTP ${status}).`);
  return id;
}

function eventPayload(website, event) {
  return { website, hostname: 'check.test', url: event.url, referrer: event.referrer, timestamp: event.timestamp };
}

// (a) Direct: one request per event, the visitor's own address and user agent in the headers.
// The timestamp is the only thing a browser would not send; without it the events could not
// be placed in the past.
async function sendDirect(website) {
  for (const event of EVENTS) {
    const visitor = VISITORS[event.visitor];
    const { status } = await post(UMAMI, '/api/send', { type: 'event', payload: eventPayload(website, event) }, {
      'x-forwarded-for': visitor.address,
      'user-agent': visitor.userAgent,
    });
    if (status !== 200) throw new Error(`Direct ingestion answered ${status} for ${event.visitor} ${event.url}.`);
  }
}

// The per-visitor value: computed by the gateway from the full address and user agent, in
// memory, and the only trace of them that travels on.
function visitorValue(visitor, website) {
  return createHmac('sha256', DAILY_SECRET).update(`${visitor.address}|${visitor.userAgent}|${website}`).digest('hex').slice(0, 32);
}

// (b) Forwarded: Umami's batch route, one batch per country, every visitor attribute supplied.
// `carry` names the payload field that carries the per-visitor value.
async function sendForwarded(base, website, { carry = 'salt', userAgent = FORWARDER_USER_AGENT } = {}) {
  const answers = [];
  for (const country of new Set(Object.values(VISITORS).map((visitor) => visitor.country))) {
    const items = EVENTS.filter((event) => VISITORS[event.visitor].country === country).map((event) => {
      const { browser, os, device } = VISITORS[event.visitor];
      const payload = { ...eventPayload(website, event), browser, os, device };
      if (carry) payload[carry] = visitorValue(VISITORS[event.visitor], website);
      return { type: 'event', payload };
    });
    const { status, body } = await post(base, '/api/batch', items, {
      'x-forwarded-for': PLACEHOLDER_ADDRESS,
      'cf-ipcountry': country,
      'user-agent': userAgent,
    });
    answers.push({ country, status, size: body.size, processed: body.processed, errors: body.errors });
  }
  return answers;
}

async function getJson(auth, pathAndQuery) {
  const response = await fetch(`${UMAMI}${pathAndQuery}`, { headers: auth });
  if (!response.ok) throw new Error(`Umami answered ${response.status} to ${pathAndQuery}.`);
  return response.json();
}

function sortedPairs(rows) {
  return rows.map((row) => `${row.x}=${row.y}`).sort().join(', ') || '(none)';
}

// The seven metrics of the RFP, plus the counts they are derived from.
async function metrics(auth, website) {
  const range = `startAt=${(T0 - HOUR) * 1000}&endAt=${Date.now() + 60_000}`;
  const stats = await getJson(auth, `/api/websites/${website}/stats?${range}`);
  const breakdown = async (type) => sortedPairs(await getJson(auth, `/api/websites/${website}/metrics?${range}&type=${type}`));
  return {
    'page views': stats.pageviews,
    'unique visitors': stats.visitors,
    visits: stats.visits,
    referrers: await breakdown('referrer'),
    'session duration (total s / visits)': `${stats.totaltime} / ${stats.visits}`,
    'bounce rate (bounces / visits)': `${stats.bounces} / ${stats.visits}`,
    country: await breakdown('country'),
    device: await breakdown('device'),
    browser: await breakdown('browser'),
    os: await breakdown('os'),
    pages: await breakdown('path'),
  };
}

function compare(title, left, right, leftName, rightName) {
  console.log(`\n${title}`);
  console.log(`| metric | ${leftName} | ${rightName} | equal |`);
  console.log('|---|---|---|---|');
  let equal = true;
  for (const key of Object.keys(left)) {
    const same = String(left[key]) === String(right[key]);
    equal &&= same;
    console.log(`| ${key} | ${left[key]} | ${right[key]} | ${same ? 'yes' : 'NO'} |`);
  }
  return equal;
}

function psql(sql) {
  return docker(['exec', '-T', 'postgres', 'psql', '-U', 'check', '-d', 'check', '-At', '-F', '|', '-c', sql]).trim();
}

// Which address can stand in the proxy header and still let a location header through.
async function probePlaceholders(auth) {
  const website = await createWebsite(auth, 'placeholder probe');
  const candidates = {
    '192.0.2.1': 'documentation range TEST-NET-1 (RFC 5737)',
    '198.51.100.1': 'documentation range TEST-NET-2 (RFC 5737)',
    '203.0.113.1': 'documentation range TEST-NET-3 (RFC 5737)',
    '2001:db8::1': 'IPv6 documentation range (RFC 3849)',
    '100.64.0.1': 'shared address space (RFC 6598)',
    '240.0.0.1': 'reserved, class E',
    '10.0.0.1': 'private (RFC 1918)',
    '127.0.0.1': 'loopback',
    '0.0.0.0': 'unspecified',
    'not-an-address': 'not an address',
    '9.9.9.9': 'a public address (not a placeholder: someone owns it)',
  };
  const rows = [];
  for (const [address, kind] of Object.entries(candidates)) {
    const url = `/probe/${rows.length}`;
    const { status } = await post(UMAMI, '/api/send', { type: 'event', payload: { website, hostname: 'check.test', url } }, {
      'x-forwarded-for': address,
      'cf-ipcountry': 'UY',
      'user-agent': FORWARDER_USER_AGENT,
    });
    const stored = psql(
      `SELECT coalesce(s.country, '(none)') FROM website_event e JOIN session s USING (session_id) WHERE e.website_id = '${website}' AND e.url_path = '${url}'`,
    );
    rows.push({ address, kind, status, country: stored || '(event not stored)' });
  }
  return rows;
}

function scanForAddresses(scratch, websites) {
  const dump = docker(['exec', '-T', 'postgres', 'pg_dump', '-U', 'check', 'check']);
  const logs = docker(['logs', '--no-color'], { stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(path.join(scratch, 'dump.sql'), dump);
  writeFileSync(path.join(scratch, 'containers.log'), logs);
  const needles = [...Object.values(VISITORS).map((visitor) => visitor.address), ...TRUNCATED, PLACEHOLDER_ADDRESS];
  const valuesStored = (website) =>
    Object.values(VISITORS).filter((visitor) => dump.includes(visitorValue(visitor, website))).length;
  return {
    addresses: needles.map((needle) => ({ needle, inDump: dump.includes(needle), inLogs: logs.includes(needle) })),
    valuesStoredAsSalt: valuesStored(websites.forwarded),
    valuesStoredAsId: valuesStored(websites.byId),
  };
}

async function main() {
  const started = Date.now();
  console.log('Starting the isolated stack (compose project us-check-01) ...');
  docker(['up', '-d', '--wait'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-01-'));
  const auth = await login(UMAMI);

  const direct = await createWebsite(auth, 'direct');
  const forwarded = await createWebsite(auth, 'forwarded, salt');
  const noSetting = await createWebsite(auth, 'forwarded, salt, default settings');
  const byId = await createWebsite(auth, 'forwarded, id, default settings');
  const botAgent = await createWebsite(auth, 'forwarded, default HTTP client user agent');

  await sendDirect(direct);
  const batches = await sendForwarded(UMAMI, forwarded);
  await sendForwarded(UMAMI_DEFAULTS, noSetting);
  await sendForwarded(UMAMI_DEFAULTS, byId, { carry: 'id' });
  const botBatches = await sendForwarded(UMAMI, botAgent, { userAgent: 'node' });

  console.log(`\n${EVENTS.length} events, ${Object.keys(VISITORS).length} visitors, replayed from ${new Date(T0 * 1000).toISOString()} on.`);
  console.log('Batches (one per country):', JSON.stringify(batches));

  const reference = await metrics(auth, direct);
  const check1 = compare('CHECK 1: direct ingestion against the batch route with ENABLE_CLIENT_SALT=1', reference, await metrics(auth, forwarded), 'direct', 'forwarded');
  const withoutSetting = await metrics(auth, noSetting);
  compare('CONTROL A: the same batches into Umami with default settings (salt ignored)', reference, withoutSetting, 'direct', 'forwarded');
  const idEqual = compare('CONTROL B: per-visitor value carried in `id`, default settings', reference, await metrics(auth, byId), 'direct', 'forwarded');
  const botStored = (await metrics(auth, botAgent))['page views'];
  console.log(`\nCONTROL C: batches sent with the HTTP client's default User-Agent ("node"): ${JSON.stringify(botBatches.map((b) => b.processed))} items "processed", ${botStored} page views stored.`);

  const placeholders = await probePlaceholders(auth);
  console.log('\nCHECK 2, placeholder address in the proxy header, with `cf-ipcountry: UY` and no ip in the payload');
  console.log('| address | kind | HTTP | country stored |\n|---|---|---|---|');
  for (const row of placeholders) console.log(`| ${row.address} | ${row.kind} | ${row.status} | ${row.country} |`);

  const { addresses: scan, valuesStoredAsSalt, valuesStoredAsId } = scanForAddresses(scratch, { forwarded, byId });
  console.log('\nCHECK 2, addresses in a full database dump and in the container logs');
  console.log('| address | in the dump | in the logs |\n|---|---|---|');
  for (const row of scan) console.log(`| ${row.needle} | ${row.inDump ? 'YES' : 'no'} | ${row.inLogs ? 'YES' : 'no'} |`);

  console.log(`\nPer-visitor values found in the dump: ${valuesStoredAsSalt} of ${Object.keys(VISITORS).length} when carried as \`salt\`, ` +
    `${valuesStoredAsId} of ${Object.keys(VISITORS).length} when carried as \`id\`.`);

  const storedFor = (address) => placeholders.find((row) => row.address === address).country;
  const facts = {
    'check 1: forwarded metrics equal direct ingestion': check1,
    'salt is ignored with default settings (visitors collapse)': withoutSetting['unique visitors'] < reference['unique visitors'],
    'the per-visitor value also works in `id` with default settings': idEqual,
    'the per-visitor value is not stored as `salt` and is stored as `id`': valuesStoredAsSalt === 0 && valuesStoredAsId === Object.keys(VISITORS).length,
    "a batch with the HTTP client's own User-Agent is dropped silently": botStored === 0 && botBatches.every((b) => b.status === 200),
    'the country header is applied to every item of a batch': batches.every((b) => b.status === 200 && b.errors === 0),
    'a documentation-range placeholder lets the country header through': storedFor(PLACEHOLDER_ADDRESS) === 'UY',
    'a private or loopback placeholder loses the country': storedFor('10.0.0.1') === '(none)' && storedFor('127.0.0.1') === '(none)',
    'no address, full, truncated or placeholder, is in the dump or the logs': scan.every((row) => !row.inDump && !row.inLogs),
  };
  console.log('\nFACTS THE VERDICTS REST ON');
  for (const [fact, holds] of Object.entries(facts)) console.log(`${holds ? 'holds  ' : 'BROKEN '} ${fact}`);

  const unchanged = Object.values(facts).every(Boolean);
  console.log('\nVERDICTS');
  console.log(unchanged
    ? 'Check 1: passes with a stated correction to the design (see README.md).\nCheck 2: passes as written, with one precision about the placeholder (see README.md).'
    : 'At least one fact above no longer holds: the verdicts in README.md do not stand as written.');
  console.log(`\nScratch (dump and logs, not deleted): ${scratch}`);
  console.log(`Took ${Math.round((Date.now() - started) / 1000)} s.`);
  return unchanged;
}

let unchanged = false;
try {
  unchanged = await main();
} finally {
  if (!process.argv.includes('--keep')) docker(['down', '-v'], { stdio: 'ignore' });
}
process.exit(unchanged ? 0 : 1);
