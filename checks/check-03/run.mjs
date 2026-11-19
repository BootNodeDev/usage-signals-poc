// Check 03: "One visitor sent through two gateways on one day is counted once."
// Starts an isolated stack, runs every case, prints the table and the verdict, and exits
// non-zero when any figure differs from the one the verdict rests on.
// Usage: node run.mjs   (CHECK_KEEP_STACK=1 leaves the containers up afterwards)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = import.meta.dirname;
const COMPOSE = ['compose', '-p', 'us-check-03', '-f', path.join(HERE, 'compose.yml')];
const DATABASE_URL = 'postgresql://poc:poc-local-only@127.0.0.1:55103/poc';
const UMAMI_A = 'http://127.0.0.1:33103';
const UMAMI_B = 'http://127.0.0.1:33203';
const UMAMI_DEFAULT = 'http://127.0.0.1:33303';
const GATEWAY_A = 'http://127.0.0.1:43103';
const GATEWAY_B = 'http://127.0.0.1:43203';
const DAY_MS = 86_400_000;

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const ALICE = { address: '203.0.113.7', userAgent: CHROME };
// Same address as Alice, another browser.
const BOB = { address: '203.0.113.7', userAgent: FIREFOX };
// Same /24 and same browser as Alice, another address.
const CAROL = { address: '203.0.113.99', userAgent: CHROME };

const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-03-'));
const runTag = Date.now().toString(36);
const children = [];
const rows = [];
let umamiToken;

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function sql(statement) {
  const psql = ['exec', '-T', 'postgres', 'psql', '-U', 'poc', '-d', 'poc', '-q', '-v', 'ON_ERROR_STOP=1'];
  return docker([...COMPOSE, ...psql], statement);
}

async function umami(pathAndQuery, init = {}) {
  const response = await fetch(`${UMAMI_A}${pathAndQuery}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${umamiToken}` },
  });
  if (!response.ok) throw new Error(`Umami answered HTTP ${response.status} to ${pathAndQuery}`);
  return response.json();
}

/** Creates a website in Umami and enrolls it for the gateway as it is today. */
async function newSite(label) {
  const domain = `${label}-${runTag}.localhost`;
  const body = JSON.stringify({ name: `check-03 ${label}`, domain });
  const { id } = await umami('/api/websites', { method: 'POST', body });
  sql(`WITH t AS (INSERT INTO usage_signals.tenant (name, status)
                  VALUES ('check-03 ${label}', 'active') RETURNING id)
       INSERT INTO usage_signals.site (tenant_id, domain, umami_website_id, slug)
       SELECT id, '${domain}', '${id}', '${label}-${runTag}' FROM t;`);
  return { id, origin: `http://${domain}`, hostname: domain };
}

/** `{ pageviews, visitors, visits }` as Umami's statistics API reports them for the range. */
async function stats(site, [startAt, endAt]) {
  const answer = await umami(`/api/websites/${site.id}/stats?startAt=${startAt}&endAt=${endAt}`);
  return { pageviews: Number(answer.pageviews), visitors: Number(answer.visitors), visits: Number(answer.visits) };
}

async function startGateways(script, envOfLocation) {
  for (const [port, env] of Object.entries(envOfLocation)) {
    const log = openSync(path.join(scratch, `${path.basename(script, '.mjs')}-${port}.log`), 'a');
    const child = spawn(process.execPath, [path.join(HERE, script)], {
      env: { ...process.env, GATEWAY_PORT: port, ...env },
      stdio: ['ignore', log, log],
    });
    children.push(child);
    await waitUntilListening(port);
  }
}

async function waitUntilListening(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const up = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (up) return;
    await sleep(100);
  }
  throw new Error(`no gateway is listening on ${port}; see the logs in ${scratch}`);
}

async function stopGateways() {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}

/** Posts one page view to a gateway the way the tracker does and returns the HTTP status. */
async function pageView(gateway, site, visitor, { url = '/', clock, extra = {} } = {}) {
  const headers = {
    'content-type': 'application/json',
    origin: site.origin,
    'user-agent': visitor.userAgent,
    'x-forwarded-for': visitor.address,
    'x-vercel-ip-country': 'AR',
  };
  if (clock) headers['x-check-clock'] = new Date(clock).toISOString();
  const response = await fetch(`${gateway}/api/e`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'event', payload: { website: site.id, url, ...extra } }),
  });
  return response.status;
}

/** Sends `[gateway, visitor]` pairs in order, one page view each; every one must be accepted. */
async function sendAll(site, steps, clock) {
  for (const [index, [gateway, visitor]] of steps.entries()) {
    const status = await pageView(gateway, site, visitor, { url: `/page-${index + 1}`, clock });
    if (status !== 202) throw new Error(`a gateway answered HTTP ${status}; see the logs in ${scratch}`);
  }
}

function record(row) {
  const pass = JSON.stringify(row.reported) === JSON.stringify(row.expected);
  rows.push({ ...row, pass });
}

function figures(value) {
  if (typeof value !== 'object') return String(value);
  return Object.entries(value)
    .map(([key, part]) => (typeof part === 'object' ? `${key}: ${figures(part)}` : `${part} ${key}`))
    .join(typeof Object.values(value)[0] === 'object' ? '; ' : ', ');
}

// Three consecutive past UTC days inside one calendar month, at 12:00, so that neither
// Umami's hourly visit boundary nor its monthly salt boundary can fall inside a case.
function pastDays() {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const firstDay = today.getUTCDate() >= 4 ? Date.UTC(year, month, today.getUTCDate() - 3) : Date.UTC(year, month - 1, 10);
  return [0, 1, 2].map((offset) => firstDay + offset * DAY_MS + DAY_MS / 2);
}

const dayRange = (noon) => [noon - DAY_MS / 2, noon + DAY_MS / 2 - 1];
const utcDay = (noon) => new Date(noon).toISOString().slice(0, 10);

async function casesWithTodaysGateway(days) {
  await startGateways('gateway-today.mjs', {
    43103: { DATABASE_URL, UMAMI_URL: UMAMI_A },
    43203: { DATABASE_URL, UMAMI_URL: UMAMI_B },
  });
  // Today's gateway stamps events with the current time; stay clear of the hourly visit boundary.
  const untilNextHour = 3_600_000 - (Date.now() % 3_600_000);
  if (untilNextHour < 20_000) await sleep(untilNextHour + 1_000);
  const sinceStart = () => [Date.now() - 3_600_000, Date.now() + 60_000];

  let site = await newSite('today-1');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, ALICE], [GATEWAY_A, ALICE], [GATEWAY_B, ALICE]]);
  record({
    id: '1',
    gateway: 'today',
    sent: 'one visitor, 4 page views alternating A, B, A, B',
    reported: await stats(site, sinceStart()),
    expected: { pageviews: 4, visitors: 1, visits: 1 },
  });

  site = await newSite('today-3');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, BOB], [GATEWAY_B, ALICE], [GATEWAY_A, BOB]]);
  record({
    id: '3',
    gateway: 'today',
    sent: 'two visitors, same address, Chrome and Firefox, each through A and B',
    reported: await stats(site, sinceStart()),
    expected: { pageviews: 4, visitors: 2, visits: 2 },
  });

  site = await newSite('today-prefix');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, CAROL]]);
  record({
    id: 'i1',
    gateway: 'today',
    sent: 'two visitors, same /24, different addresses, same browser (informative)',
    reported: await stats(site, sinceStart()),
    expected: { pageviews: 2, visitors: 1, visits: 1 },
  });
  await stopGateways();

  // Today's gateway refuses timestamps, so the two days are written straight to Umami in
  // the exact shape console/lib/umami.js sends, plus `timestamp`.
  site = await newSite('today-days');
  for (const [umamiUrl, noon] of [[UMAMI_A, days[0]], [UMAMI_B, days[1]]]) {
    const payload = { website: site.id, hostname: site.hostname, url: '/', userAgent: CHROME, timestamp: noon / 1000 };
    const response = await fetch(`${umamiUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.0', 'cf-ipcountry': 'AR' },
      body: JSON.stringify({ type: 'event', payload }),
    });
    if (!response.ok) throw new Error(`Umami answered HTTP ${response.status} to a direct write`);
  }
  record({
    id: 'i2',
    gateway: 'today',
    sent: 'one visitor on two UTC days, written to Umami in the shape today\'s gateway sends (informative)',
    reported: { 'visitors over both days': (await stats(site, [dayRange(days[0])[0], dayRange(days[1])[1]])).visitors },
    expected: { 'visitors over both days': 1 },
  });
}

async function casesWithDesignGateway(days) {
  const [dayOne, dayTwo, splitDay] = days;
  const shared = { [utcDay(dayOne)]: 'salt-of-day-one', [utcDay(dayTwo)]: 'salt-of-day-two' };
  const saltsOf = (location) => JSON.stringify({ ...shared, [utcDay(splitDay)]: `own-salt-of-${location}` });
  await startGateways('gateway-design.mjs', {
    43103: { UMAMI_URL: UMAMI_A, DAILY_SALTS: saltsOf('a'), CHECK_TEST_CLOCK: '1' },
    43203: { UMAMI_URL: UMAMI_B, DAILY_SALTS: saltsOf('b'), CHECK_TEST_CLOCK: '1' },
  });
  const alternating = [[GATEWAY_A, ALICE], [GATEWAY_B, ALICE], [GATEWAY_A, ALICE], [GATEWAY_B, ALICE]];

  let site = await newSite('design-2a');
  await sendAll(site, alternating, dayOne);
  record({
    id: '2a',
    gateway: 'design',
    sent: 'one visitor, 4 page views alternating A, B, A, B; both gateways hold the same daily salt',
    reported: await stats(site, dayRange(dayOne)),
    expected: { pageviews: 4, visitors: 1, visits: 1 },
  });

  site = await newSite('design-2b');
  await sendAll(site, alternating, splitDay);
  record({
    id: '2b',
    gateway: 'design',
    sent: 'the same, on a day when each gateway holds its own salt (degraded)',
    reported: await stats(site, dayRange(splitDay)),
    expected: { pageviews: 4, visitors: 2, visits: 2 },
  });

  site = await newSite('design-2c');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, ALICE]], dayOne);
  await sendAll(site, [[GATEWAY_B, ALICE], [GATEWAY_A, ALICE]], dayTwo);
  record({
    id: '2c',
    gateway: 'design',
    sent: 'one visitor on two consecutive UTC days, through A and B on each; the salt changes with the day',
    reported: {
      'visitors day 1': (await stats(site, dayRange(dayOne))).visitors,
      'visitors day 2': (await stats(site, dayRange(dayTwo))).visitors,
      'visitors over both days': (await stats(site, [dayRange(dayOne)[0], dayRange(dayTwo)[1]])).visitors,
    },
    expected: { 'visitors day 1': 1, 'visitors day 2': 1, 'visitors over both days': 2 },
  });

  site = await newSite('design-3');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, BOB], [GATEWAY_B, ALICE], [GATEWAY_A, BOB]], dayOne);
  record({
    id: '3',
    gateway: 'design',
    sent: 'two visitors, same address, Chrome and Firefox, each through A and B',
    reported: await stats(site, dayRange(dayOne)),
    expected: { pageviews: 4, visitors: 2, visits: 2 },
  });

  site = await newSite('design-prefix');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, CAROL]], dayOne);
  record({
    id: 'i1',
    gateway: 'design',
    sent: 'two visitors, same /24, different addresses, same browser (informative)',
    reported: await stats(site, dayRange(dayOne)),
    expected: { pageviews: 2, visitors: 2, visits: 2 },
  });

  site = await newSite('design-forged');
  const status = await pageView(GATEWAY_A, site, ALICE, { clock: dayOne, extra: { salt: 'chosen-by-the-caller' } });
  record({
    id: 'i3',
    gateway: 'design',
    sent: 'a page view whose body carries its own salt',
    reported: { 'HTTP status': status, ...(await stats(site, dayRange(dayOne))) },
    expected: { 'HTTP status': 400, pageviews: 0, visitors: 0, visits: 0 },
  });
  await stopGateways();
}

// The design against Umami as it ships: the value is sent, and Umami ignores it.
async function controlWithoutClientSalt(days) {
  const salts = JSON.stringify({ [utcDay(days[0])]: 'salt-of-day-one' });
  const env = { UMAMI_URL: UMAMI_DEFAULT, DAILY_SALTS: salts, CHECK_TEST_CLOCK: '1' };
  await startGateways('gateway-design.mjs', { 43103: env, 43203: env });
  const site = await newSite('control');
  await sendAll(site, [[GATEWAY_A, ALICE], [GATEWAY_B, BOB], [GATEWAY_B, ALICE], [GATEWAY_A, BOB]], days[0]);
  record({
    id: 'c1',
    gateway: 'design, Umami without ENABLE_CLIENT_SALT',
    sent: 'two visitors, same address, Chrome and Firefox, each through A and B',
    reported: await stats(site, dayRange(days[0])),
    expected: { pageviews: 4, visitors: 1, visits: 1 },
  });
  await stopGateways();
}

function printReport() {
  console.log('\n| Case | Gateway | Sent | Umami reported | Verdict rests on | Match |');
  console.log('|---|---|---|---|---|---|');
  for (const row of rows) {
    const cells = [row.id, row.gateway, row.sent, figures(row.reported), figures(row.expected), row.pass ? 'yes' : 'NO'];
    console.log(`| ${cells.join(' | ')} |`);
  }
  const failed = rows.filter((row) => !row.pass);
  if (failed.length > 0) {
    console.log(`\nVERDICT CHANGED: ${failed.length} case(s) differ from the figures the verdict rests on.`);
    return 1;
  }
  console.log(
    '\nVERDICT: passes with a stated correction. One visitor through two gateways on one day is ' +
      'counted once, with the gateway as it is today and with the per-visitor value sent as ' +
      '`salt`; the latter only when Umami runs with ENABLE_CLIENT_SALT set (case c1). No change ' +
      'to Umami\'s source.',
  );
  return 0;
}

async function main() {
  console.log(`scratch: ${scratch}`);
  docker([...COMPOSE, 'up', '-d', '--wait']);
  sql(readFileSync(path.join(HERE, '../../console/db/schema.sql'), 'utf8'));
  const login = await fetch(`${UMAMI_A}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'umami' }),
  });
  if (!login.ok) throw new Error(`Umami refused the login (HTTP ${login.status})`);
  umamiToken = (await login.json()).token;

  const days = pastDays();
  await casesWithTodaysGateway(days);
  await casesWithDesignGateway(days);
  await controlWithoutClientSalt(days);
  return printReport();
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`check 03 did not complete: ${error.stack}`);
} finally {
  await stopGateways();
  if (process.env.CHECK_KEEP_STACK !== '1') docker([...COMPOSE, 'down', '-v']);
}
process.exit(exitCode);
