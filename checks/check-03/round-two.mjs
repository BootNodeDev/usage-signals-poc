// Check 03, round two: what keeps "one visitor through two gateways is counted once" true,
// and whether a drift in any of those conditions is detected.
// Starts an isolated stack, runs every case, prints the table and the verdicts, removes the
// stack. Exit code 0 when every figure matches, 1 when one differs, 2 when the run broke.
// Usage: node round-two.mjs
//   CHECK_KEEP_STACK=1     leaves the containers up afterwards
//   CHECK_MUTATION=<name>  applies one negative control (see MUTATIONS); the run must exit 1
//        node round-two.mjs --controls   runs every negative control in turn
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { compareGateways, compareUmami, probeInstants } from './probe.mjs';

const HERE = import.meta.dirname;
const COMPOSE = ['compose', '-p', 'us-check-03-r2', '-f', path.join(HERE, 'compose.round-two.yml')];
const HALF_DAY_MS = 43_200_000;

// Negative controls and the claim each one must break.
const MUTATIONS = {
  'umami-b-secret-differs': 'A',
  'umami-drift-not-applied': 'A',
  'umami-probe-without-salt': 'A',
  'umami-probe-first-of-month-only': 'A',
  'umami-probe-without-lookahead': 'A',
  'gateway-b-salt-differs': 'B',
  'gateway-drift-not-applied': 'B',
  'probe-skips-address-reading': 'B',
  'no-address-normalisation': 'C',
  'address-truncated-to-prefix': 'C',
  'salts-agree-on-split-day': 'D',
};
const MUTATION = process.env.CHECK_MUTATION ?? '';
if (MUTATION && !MUTATIONS[MUTATION]) {
  throw new Error(`Unknown CHECK_MUTATION "${MUTATION}". Known: ${Object.keys(MUTATIONS).join(', ')}.`);
}
const mutated = (name) => MUTATION === name;
const runsClaim = (claim) => !MUTATION || MUTATIONS[MUTATION] === claim;

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ALICE = { address: '203.0.113.7', userAgent: CHROME };

// One setting of location B's Umami changed at a time. Each one makes Umami report two
// visitors for one person seen at both locations. `differing` is the number of probe
// instants at which the identities differ, with the probe's clock at PROBE_CLOCK.
const UMAMI_DRIFTS = [
  { setting: 'APP_SECRET', env: { CHECK_B_APP_SECRET: 'check-03-another-app-secret' }, differing: 4 },
  { setting: 'ENABLE_CLIENT_SALT', env: { CHECK_B_ENABLE_CLIENT_SALT: '' }, differing: 4 },
  { setting: 'SALT_ROTATION', env: { CHECK_B_SALT_ROTATION: 'daily' }, differing: 3 },
  { setting: 'time zone', env: { CHECK_B_TZ: 'Asia/Tokyo' }, differing: 4 },
];
// The probe's clock in cases A1 to A5, fixed so that the figures do not depend on the day
// of the run. Seven days later is the first of a month, where a daily and a monthly
// rotation agree. probe.mjs from the command line (A1, A2) uses the real clock.
const PROBE_CLOCK = new Date('2026-11-24T12:00:00Z');
// A zone that has the UTC offset of location A in winter and another one in summer.
const SEASONAL_ZONE = 'Europe/London';
const WINTER_RUN = new Date('2027-01-10T12:00:00Z');
const LATE_WINTER_RUN = new Date('2027-03-10T12:00:00Z');

// One setting of location B's gateway changed at a time.
const GATEWAY_DRIFTS = [
  { setting: 'daily salt', ownSalt: true, env: {}, expected: ['disagree', 202, 2] },
  { setting: 'placeholder address', env: { PLACEHOLDER_ADDRESS: '198.51.100.1' }, expected: ['disagree', 202, 2] },
  {
    setting: 'forwarder User-Agent',
    env: { FORWARDER_USER_AGENT: 'Mozilla/5.0 (usage-signals forwarder; location b)' },
    expected: ['disagree', 202, 2],
  },
  {
    setting: 'forwarder User-Agent that Umami treats as a bot',
    env: { FORWARDER_USER_AGENT: 'usage-signals-forwarder/1' },
    expected: ['no answer from B', 503, 1],
  },
];

const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-03-r2-'));
const runTag = Date.now().toString(36);
const children = [];
const rows = [];
const probeFindings = [];
const days = referenceDays();
let umamiA;
let umamiToken;
let probeSite;

function docker(args, env = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

/** The loopback URL Docker gave the Umami service. */
function umamiUrl(service) {
  return `http://${docker([...COMPOSE, 'port', service, '3000']).trim()}`;
}

/** Recreates location B's Umami with the given settings changed and returns its URL. */
function recreateUmamiB(env) {
  docker([...COMPOSE, 'up', '-d', '--wait', '--no-deps', '--force-recreate', 'umami-b'], env);
  return umamiUrl('umami-b');
}

async function umami(pathAndQuery, init = {}) {
  const response = await fetch(`${umamiA}${pathAndQuery}`, {
    ...init,
    // No pooled connections: location B's Umami is restarted during the run.
    headers: { 'content-type': 'application/json', authorization: `Bearer ${umamiToken}`, connection: 'close' },
  });
  if (!response.ok) throw new Error(`Umami answered HTTP ${response.status} to ${pathAndQuery}`);
  return response.json();
}

async function newSite(label) {
  const domain = `${label}-${runTag}.localhost`;
  const body = JSON.stringify({ name: `check-03 round two ${label}`, domain });
  const { id } = await umami('/api/websites', { method: 'POST', body });
  return { id, origin: `http://${domain}` };
}

/** `{ pageviews, visitors, visits }` as Umami's statistics API reports them around `instant`. */
async function stats(site, instant) {
  const range = `startAt=${instant - HALF_DAY_MS}&endAt=${instant + HALF_DAY_MS - 1}`;
  const answer = await umami(`/api/websites/${site.id}/stats?${range}`);
  return { pageviews: Number(answer.pageviews), visitors: Number(answer.visitors), visits: Number(answer.visits) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitUntilListening(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const up = await fetch(url).then(() => true, () => false);
    if (up) return;
    await sleep(100);
  }
  throw new Error(`no gateway is listening on ${url}; see the logs in ${scratch}`);
}

/** Starts one design gateway on a free loopback port; returns `{ url, child }`. */
async function startGateway(label, umamiUrlOfLocation, salts, env = {}) {
  const port = await freePort();
  const log = openSync(path.join(scratch, `gateway-${label}.log`), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'gateway-design.mjs')], {
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      UMAMI_URL: umamiUrlOfLocation,
      DAILY_SALTS: JSON.stringify(salts),
      CHECK_TEST_CLOCK: '1',
      ...env,
    },
    stdio: ['ignore', log, log],
  });
  children.push(child);
  const url = `http://127.0.0.1:${port}`;
  await waitUntilListening(url);
  return { url, child };
}

async function stopGateway({ child }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

/** Posts one page view to a gateway the way the tracker does and returns the HTTP status. */
async function pageView(gateway, site, visitor, instant, url = '/') {
  const response = await fetch(`${gateway.url}/api/e`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: site.origin,
      'user-agent': visitor.userAgent,
      'x-forwarded-for': visitor.address,
      'x-vercel-ip-country': 'AR',
      // What a proxy hop would add: its own address, the same for every visitor.
      'x-real-ip': '198.51.100.250',
      'x-check-clock': new Date(instant).toISOString(),
    },
    body: JSON.stringify({ type: 'event', payload: { website: site.id, url } }),
  });
  return response.status;
}

/** Sends `[gateway, visitor]` pairs in order, one page view each; every one must be accepted. */
async function sendAll(site, steps, instant) {
  for (const [index, [gateway, visitor]] of steps.entries()) {
    const status = await pageView(gateway, site, visitor, instant, `/page-${index + 1}`);
    if (status !== 202) throw new Error(`a gateway answered HTTP ${status}; see the logs in ${scratch}`);
  }
}

function record(row) {
  rows.push({ ...row, pass: JSON.stringify(row.reported) === JSON.stringify(row.expected) });
}

function noteFindings(id, result) {
  for (const finding of result.findings) probeFindings.push(`${id}: ${finding}`);
}

/** Runs probe.mjs the way a deploy would and returns its exit code. */
function probeExitCode(kind, urls, probeDays = []) {
  const args = [path.join(HERE, 'probe.mjs'), kind, probeSite.id, ...urls, ...probeDays];
  return spawnSync(process.execPath, args, { encoding: 'utf8' }).status;
}

// Past instants in the month before the run, at 12:00 UTC: three ordinary days and the
// first and the fifteenth of the month.
function referenceDays() {
  const now = new Date();
  const noon = (dayOfMonth) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, dayOfMonth, 12);
  return { first: noon(1), agreed: noon(10), split: noon(11), missing: noon(12), mid: noon(15) };
}

const utcDay = (instant) => new Date(instant).toISOString().slice(0, 10);

/** The salt calendar of one location: shared days, one day of its own, one day B lacks. */
function saltsOf(location) {
  const salts = {
    [utcDay(days.agreed)]: 'salt-of-the-agreed-day',
    [utcDay(days.mid)]: 'salt-of-mid-month',
    [utcDay(days.split)]: `own-salt-of-${location}`,
  };
  if (location === 'a') salts[utcDay(days.missing)] = 'salt-only-a-received';
  if (location === 'b' && mutated('gateway-b-salt-differs')) salts[utcDay(days.agreed)] = 'salt-b-got-wrong';
  if (location === 'b' && mutated('salts-agree-on-split-day')) salts[utcDay(days.split)] = 'own-salt-of-a';
  return salts;
}

/** Visitors Umami reports for one person with one page view at each location, mid-month. */
async function visitorsAtBothLocations(label, gateways) {
  const site = await newSite(label);
  await sendAll(site, gateways.map((gateway) => [gateway, ALICE]), days.mid);
  return (await stats(site, days.mid)).visitors;
}

/** The Umami probe as the check runs it; negative controls weaken it here. */
function probeUmami(umamiB, now = PROBE_CLOCK) {
  const options = { instants: probeInstants(now) };
  if (mutated('umami-probe-without-salt')) options.salts = [undefined];
  if (mutated('umami-probe-first-of-month-only')) options.instants = [days.first];
  if (mutated('umami-probe-without-lookahead')) options.instants = [probeInstants(now)[0]];
  return compareUmami([umamiA, umamiB], probeSite.id, options);
}

async function umamiCase(id, setting, gatewayA, umamiB, { visitors, differing, fromCommandLine = false }) {
  const gatewayB = await startGateway(`b-umami-${id}`, umamiB, saltsOf('a'));
  const result = await probeUmami(umamiB);
  noteFindings(id, result);
  const verdict = (count) => (count === 0 ? 'pass' : `drift at ${count} of 4 instants`);
  const reported = { probe: result.ok ? 'pass' : verdict(result.differing) };
  const expected = { probe: verdict(differing) };
  if (fromCommandLine) {
    reported['probe.mjs exit code'] = probeExitCode('umami', [umamiA, umamiB]);
    expected['probe.mjs exit code'] = differing > 0 ? 1 : 0;
  }
  reported.visitors = await visitorsAtBothLocations(id.toLowerCase(), [gatewayA, gatewayB]);
  expected.visitors = visitors;
  const sent = `Umami probe, ${result.compared} synthetic events per instance; then one visitor through A and B. ${setting}`;
  record({ id, sent, reported, expected });
  await stopGateway(gatewayB);
}

// A zone that agrees with location A today and stops agreeing later in the year.
async function seasonalZoneCase(id) {
  const umamiB = recreateUmamiB(mutated('umami-drift-not-applied') ? {} : { CHECK_B_TZ: SEASONAL_ZONE });
  const [winter, lateWinter] = [await probeUmami(umamiB, WINTER_RUN), await probeUmami(umamiB, LATE_WINTER_RUN)];
  noteFindings(id, lateWinter);
  const day = (run) => `probe as of ${utcDay(run.getTime())}`;
  record({
    id,
    sent: `Umami probe with its clock set to two dates. B runs in ${SEASONAL_ZONE}, A in UTC`,
    reported: { [day(WINTER_RUN)]: winter.ok ? 'pass' : 'drift', [day(LATE_WINTER_RUN)]: lateWinter.ok ? 'pass' : 'drift' },
    expected: { [day(WINTER_RUN)]: 'pass', [day(LATE_WINTER_RUN)]: 'drift' },
  });
}

// Claim A: a difference between the two Umami instances is detected by the probe.
async function claimUmamiDrift(gatewayA, umamiB) {
  await umamiCase('A1', 'B has the settings of A', gatewayA, umamiB, { visitors: 1, differing: 0, fromCommandLine: true });
  for (const [index, drift] of UMAMI_DRIFTS.entries()) {
    const drifted = recreateUmamiB(mutated('umami-drift-not-applied') ? {} : drift.env);
    const expectation = { visitors: 2, differing: drift.differing, fromCommandLine: index === 0 };
    await umamiCase(`A${index + 2}`, `B differs in ${drift.setting}`, gatewayA, drifted, expectation);
  }
  await seasonalZoneCase('A6');
}

async function gatewayDriftCase(id, drift, gatewayA, umamiB) {
  const salts = { ...saltsOf('a'), ...(drift.ownSalt ? { [utcDay(days.mid)]: 'salt-b-made-itself' } : {}) };
  const applied = mutated('gateway-drift-not-applied') ? [saltsOf('a'), {}] : [salts, drift.env];
  const gatewayB = await startGateway(`b-gateway-${id}`, umamiB, ...applied);
  const day = utcDay(days.mid);
  const result = await compareGateways([gatewayA.url, gatewayB.url], probeSite.id, [day]);
  noteFindings(id, result);
  const site = await newSite(id.toLowerCase());
  await sendAll(site, [[gatewayA, ALICE]], days.mid);
  const statusAtB = await pageView(gatewayB, site, ALICE, days.mid, '/page-2');
  record({
    id,
    sent: `gateway probe for one day; then one visitor through A and B. B differs in ${drift.setting}`,
    reported: { probe: result.days[day], 'gateway B answered': statusAtB, visitors: (await stats(site, days.mid)).visitors },
    expected: { probe: drift.expected[0], 'gateway B answered': drift.expected[1], visitors: drift.expected[2] },
  });
  await stopGateway(gatewayB);
}

// One location reads the client address from another header than the other.
async function addressSourceCase(id, gatewayA, umamiB) {
  const env = mutated('gateway-drift-not-applied') ? {} : { CLIENT_ADDRESS_HEADER: 'x-real-ip' };
  const gatewayB = await startGateway(`b-gateway-${id}`, umamiB, saltsOf('a'), env);
  const day = utcDay(days.mid);
  const result = await compareGateways([gatewayA.url, gatewayB.url], probeSite.id, [day]);
  noteFindings(id, result);
  const bob = { address: '203.0.113.99', userAgent: CHROME };
  const oneAtBoth = await newSite(`${id.toLowerCase()}-both`);
  await sendAll(oneAtBoth, [[gatewayA, ALICE], [gatewayB, ALICE]], days.mid);
  const twoAtB = await newSite(`${id.toLowerCase()}-two`);
  await sendAll(twoAtB, [[gatewayB, ALICE], [gatewayB, bob]], days.mid);
  record({
    id,
    sent: 'gateway probe for one day; then one visitor through A and B, and two visitors through B. B reads the client address from x-real-ip',
    reported: {
      probe: result.days[day],
      'one visitor at A and B': (await stats(oneAtBoth, days.mid)).visitors,
      'two visitors at B': (await stats(twoAtB, days.mid)).visitors,
    },
    expected: { probe: 'no answer from B', 'one visitor at A and B': 2, 'two visitors at B': 1 },
  });
  await stopGateway(gatewayB);
}

// Claim B: a difference between the two gateways is detected by the probe.
async function claimGatewayDrift(gatewayA, gatewayB, umamiB) {
  const sharedDays = [days.agreed, days.mid].map(utcDay);
  const urls = [gatewayA.url, gatewayB.url];
  const result = await compareGateways(urls, probeSite.id, sharedDays);
  noteFindings('B1', result);
  record({
    id: 'B1',
    sent: 'gateway probe for two days on which both gateways hold the same salt, placeholder and User-Agent',
    reported: { probe: Object.values(result.days).join(', '), 'probe.mjs exit code': probeExitCode('gateways', urls, sharedDays) },
    expected: { probe: 'agree, agree', 'probe.mjs exit code': 0 },
  });
  for (const [index, drift] of GATEWAY_DRIFTS.entries()) {
    await gatewayDriftCase(`B${index + 2}`, drift, gatewayA, umamiB);
  }
  await addressSourceCase('B6', gatewayA, umamiB);
}

async function notationCase(id, sent, gateways, addresses, expected) {
  const site = await newSite(id.toLowerCase());
  const steps = addresses.map((address, index) => [gateways[index % 2], { address, userAgent: CHROME }]);
  await sendAll(site, steps, days.agreed);
  record({ id, sent: `${sent}: ${addresses.join(', ')}`, reported: await stats(site, days.agreed), expected });
}

// Claim C: one address in several notations is one visitor; two addresses are two.
async function claimAddressNotation(gateways) {
  const oneAddress = [
    '2001:db8::1',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '2001:DB8::1',
    '2001:db8:0:0:0:0:0:1',
    '2001:db8::1%eth0',
    '2001:0DB8:0:0::1',
  ];
  await notationCase('C1', 'one IPv6 address, alternating A, B', gateways, oneAddress, { pageviews: 6, visitors: 1, visits: 1 });
  const mapped = ['203.0.113.7', '::ffff:203.0.113.7', '::FFFF:CB00:7107', '0:0:0:0:0:ffff:cb00:7107'];
  await notationCase('C2', 'one IPv4 address, plain and IPv4-mapped, alternating A, B', gateways, mapped, {
    pageviews: 4,
    visitors: 1,
    visits: 1,
  });
  const twoAddresses = ['2001:db8::1', '2001:db8::2', '2001:0db8:0:0:0:0:0:2', '2001:DB8:0:0:0:0:0:1'];
  await notationCase('C3', 'two IPv6 addresses, each through A and B in two notations', gateways, twoAddresses, {
    pageviews: 4,
    visitors: 2,
    visits: 2,
  });
  const bracketed = ['2001:db8::1', '[2001:db8::1]', '[2001:DB8::1]:443', '[2001:db8:0:0:0:0:0:1%eth0]:8080'];
  await notationCase('C4', 'one IPv6 address, bare, in brackets and with a port', gateways, bracketed, {
    pageviews: 4,
    visitors: 1,
    visits: 1,
  });
  const withPort = ['203.0.113.7', '203.0.113.7:54321', '[::ffff:203.0.113.7]:80'];
  await notationCase('C5', 'one IPv4 address, bare and with a port', gateways, withPort, { pageviews: 3, visitors: 1, visits: 1 });
  for (const [id, address] of [['C6', 'not-an-address'], ['C7', '203.000.113.007']]) {
    const site = await newSite(id.toLowerCase());
    const status = await pageView(gateways[0], site, { address, userAgent: CHROME }, days.agreed);
    record({
      id,
      sent: `a page view whose client address is ${address}`,
      reported: { 'HTTP status': status, ...(await stats(site, days.agreed)) },
      expected: { 'HTTP status': 503, pageviews: 0, visitors: 0, visits: 0 },
    });
  }
}

/** Ten visitors: four only at A with two page views each, three only at B, three at both. */
function populationSteps([gatewayA, gatewayB]) {
  const visitor = (number) => ({ address: `198.51.100.${number}`, userAgent: CHROME });
  const onlyA = [1, 2, 3, 4].flatMap((number) => [[gatewayA, visitor(number)], [gatewayA, visitor(number)]]);
  const onlyB = [5, 6, 7].map((number) => [gatewayB, visitor(number)]);
  const both = [8, 9, 10].flatMap((number) => [[gatewayA, visitor(number)], [gatewayB, visitor(number)]]);
  return [...onlyA, ...onlyB, ...both];
}

// Claim D: a day on which the locations hold different salts is detected, and counts on
// such a day are the sum of what each location saw.
async function claimSaltDisagreement(gateways) {
  const probed = [days.agreed, days.split, days.missing].map(utcDay);
  const result = await compareGateways(gateways.map((gateway) => gateway.url), probeSite.id, probed);
  noteFindings('D1', result);
  const [agreed, split, missing] = probed.map((day) => result.days[day]);
  record({
    id: 'D1',
    sent: 'gateway probe for a day with a shared salt, a day with one salt per location, and a day B has no salt for',
    reported: { 'shared salt': agreed, 'own salts': split, 'salt missing at B': missing },
    expected: { 'shared salt': 'agree', 'own salts': 'disagree', 'salt missing at B': 'no answer from B' },
  });
  const population = 'ten visitors: four only at A (two page views each), three only at B, three at both';
  for (const [id, label, instant, expected] of [
    ['D2', 'on the day with a shared salt', days.agreed, { pageviews: 17, visitors: 10, visits: 10 }],
    ['D3', 'on the day with one salt per location', days.split, { pageviews: 17, visitors: 13, visits: 13 }],
  ]) {
    const site = await newSite(id.toLowerCase());
    await sendAll(site, populationSteps(gateways), instant);
    record({ id, sent: `${population}, ${label}`, reported: await stats(site, instant), expected });
  }
}

function figures(value) {
  return Object.entries(value)
    .map(([key, part]) => (typeof part === 'number' && !key.includes(' ') ? `${part} ${key}` : `${key}: ${part}`))
    .join(', ');
}

function printReport() {
  rows.sort((first, second) => first.id.localeCompare(second.id));
  console.log('\n| Case | Sent | Reported | Verdict rests on | Match |');
  console.log('|---|---|---|---|---|');
  for (const row of rows) {
    console.log(`| ${[row.id, row.sent, figures(row.reported), figures(row.expected), row.pass ? 'yes' : 'NO'].join(' | ')} |`);
  }
  console.log('\nProbe findings (what the probe printed when it did not pass):');
  for (const finding of probeFindings) console.log(`  ${finding}`);
  const failed = rows.filter((row) => !row.pass);
  if (MUTATION) console.log(`\nNEGATIVE CONTROL ${MUTATION}: ${failed.length > 0 ? 'caught' : 'NOT CAUGHT'}`);
  if (failed.length > 0) {
    console.log(`\nVERDICT CHANGED: ${failed.map((row) => row.id).join(', ')} differ from the figures the verdict rests on.`);
    return 1;
  }
  if (MUTATION) return 0;
  console.log(
    '\nVERDICT, on one machine:\n' +
      '  A. Yes. The Umami probe passes when the instances match and reports each of the four drifts.\n' +
      '  B. Yes. The gateway probe passes when the gateways match and reports each of the four drifts.\n' +
      '  C. Yes. One address in any tested notation is one visitor; two addresses are two.\n' +
      '  D. Yes. A day with different salts is reported; that day counts a visitor once per location used.\n' +
      '  E. Not established here: anything that needs two real locations. See README.md.',
  );
  return 0;
}

async function signIn() {
  const login = await fetch(`${umamiA}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'umami' }),
  });
  if (!login.ok) throw new Error(`Umami refused the login (HTTP ${login.status})`);
  umamiToken = (await login.json()).token;
}

async function main() {
  console.log(`scratch: ${scratch}`);
  if (MUTATION) console.log(`negative control: ${MUTATION} (claim ${MUTATIONS[MUTATION]} only)`);
  // The negative control starts location B with another APP_SECRET from the beginning.
  const startEnv = mutated('umami-b-secret-differs') ? { CHECK_B_APP_SECRET: 'check-03-another-app-secret' } : {};
  docker([...COMPOSE, 'up', '-d', '--wait'], startEnv);
  umamiA = umamiUrl('umami-a');
  const umamiB = umamiUrl('umami-b');
  await signIn();
  probeSite = await newSite('probe');
  const gatewayA = await startGateway('a', umamiA, saltsOf('a'));
  const gatewayB = await startGateway('b', umamiB, saltsOf('b'));
  if (runsClaim('B')) await claimGatewayDrift(gatewayA, gatewayB, umamiB);
  if (runsClaim('C')) await claimAddressNotation([gatewayA, gatewayB]);
  if (runsClaim('D')) await claimSaltDisagreement([gatewayA, gatewayB]);
  await stopGateway(gatewayB);
  // Last, because it recreates location B's Umami with other settings.
  if (runsClaim('A')) await claimUmamiDrift(gatewayA, umamiB);
  return printReport();
}

async function runCheck() {
  try {
    return await main();
  } catch (error) {
    const cause = error.cause ? `\ncaused by: ${error.cause.message}` : '';
    console.error(`check 03 round two did not complete: ${error.stack}${cause}`);
    return 2;
  } finally {
    for (const child of children) await stopGateway({ child });
    if (process.env.CHECK_KEEP_STACK !== '1') docker([...COMPOSE, 'down', '-v']);
  }
}

/** Runs the check once per negative control. A control is caught when its run exits 1. */
function runControls() {
  console.log(`scratch: ${scratch}`);
  console.log('\n| Negative control | Claim | Exit code | Cases that changed | Caught |');
  console.log('|---|---|---|---|---|');
  let missed = 0;
  for (const [name, claim] of Object.entries(MUTATIONS)) {
    const run = spawnSync(process.execPath, [import.meta.filename], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_MUTATION: name, CHECK_KEEP_STACK: '' },
    });
    writeFileSync(path.join(scratch, `control-${name}.log`), `${run.stdout}${run.stderr}`);
    const changed = /VERDICT CHANGED: (.*) differ/.exec(run.stdout)?.[1] ?? '-';
    const caught = run.status === 1 && changed !== '-';
    if (!caught) missed += 1;
    console.log(`| ${[name, claim, run.status, changed, caught ? 'yes' : 'NO'].join(' | ')} |`);
  }
  console.log(`\n${Object.keys(MUTATIONS).length - missed} of ${Object.keys(MUTATIONS).length} negative controls caught.`);
  return missed === 0 ? 0 : 1;
}

process.exit(process.argv.includes('--controls') ? runControls() : await runCheck());
