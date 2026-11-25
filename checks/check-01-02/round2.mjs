// Round two of checks 1 and 2. Starts an isolated stack, runs four experiments against
// unmodified Umami 3.5.0, prints the evidence and the verdicts, and exits 1 if a fact a
// verdict rests on does not hold.
//
//   A. visit continuity across the clock hour      C. duplicates and reconciliation
//   B. the conditions of check 1 as a probe        D. no part of an address on disk
//
//   node round2.mjs                  run and remove the stack
//   node round2.mjs --keep           leave the stack up afterwards
//   node round2.mjs --mutate=<name>  break one thing on purpose (see mutation.mjs)
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createForwarder, httpTransport, readSpool, reconcile } from './forwarder.mjs';
import { createGateway, reduceUserAgent } from './gateway.mjs';
import { MUTATION } from './mutation.mjs';
import { contractProbe } from './probe.mjs';
import { needlesFor, scanDisk } from './scan.mjs';
import * as stack from './stack.mjs';

const HOUR = 3600;
const MINUTE = 60;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / 1000);
// About seven hours ago, on the hour: the forwarded side replays everything from the past.
// The six hours of the scenario are kept inside one UTC day, because the per-visitor value
// changes at 00:00 UTC. What happens across that boundary is measured on its own.
const SPAN = 6 * HOUR;
const LATEST = Math.floor(NOW / HOUR) * HOUR - 7 * HOUR;
const sameDay = Math.floor(LATEST / DAY) === Math.floor((LATEST + SPAN) / DAY);
const T0 = sameDay ? LATEST : Math.floor((LATEST + SPAN) / DAY) * DAY - SPAN;
// The last 00:00 UTC that is at least an hour old.
const MIDNIGHT = Math.floor((NOW - HOUR) / DAY) * DAY;
const RANGE = { startAt: (Math.min(T0, MIDNIGHT) - 2 * HOUR) * 1000, endAt: Date.now() + 60_000 };
const FLUSH_SIZE = 4;
const RESTART_AFTER = 8;

const CHROME = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0';
const SAFARI = 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const USER_AGENTS = {
  chromeWindows: `${WINDOWS} ${CHROME} Safari/537.36`,
  edgeWindows: `${WINDOWS} ${CHROME} Safari/537.36 Edg/141.0.0.0`,
  chromeMac: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME} Safari/537.36`,
  chromeAndroid: `Mozilla/5.0 (Linux; Android 15; Pixel 9) ${CHROME} Mobile Safari/537.36`,
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  safariIphone:
    `Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) ${SAFARI}/18.5 ` +
    'Mobile/15E148 Safari/604.1',
  safariIpad:
    `Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) ${SAFARI}/17.7 Mobile/15E148 Safari/604.1`,
};

// Addresses chosen to be distinctive, so that a match in a scan is not a coincidence.
const VISITORS = {
  threePages: { address: '151.101.65.140', userAgent: USER_AGENTS.chromeWindows },
  bounce: { address: '200.45.191.35', userAgent: USER_AGENTS.safariIphone },
  pagesAcrossTheHour: { address: '194.25.134.80', userAgent: USER_AGENTS.firefoxLinux },
  twoPages: { address: '2a00:1450:4001:81b::200e', userAgent: USER_AGENTS.chromeMac },
  // Same browser build as threePages, another network: only the address tells them apart.
  sameBrowser: { address: '139.130.4.5', userAgent: USER_AGENTS.chromeWindows },
  appAcrossTheHour: { address: '200.160.2.3', userAgent: USER_AGENTS.chromeAndroid },
  appForHours: { address: '133.242.187.207', userAgent: USER_AGENTS.edgeWindows },
  twoTabs: { address: '163.172.141.219', userAgent: USER_AGENTS.safariIpad },
};

// [visitor, page load, minutes after T0, path, referrer]. A multi-page site loads a new page
// for every view. A single-page app keeps one page load, and with it Umami's token.
const EVENTS = [
  ['threePages', 'a', 5, '/', 'https://stellar.org/learn'],
  ['threePages', 'b', 7, '/pricing', '/'],
  ['threePages', 'c', 12, '/docs', '/pricing'],
  ['bounce', 'a', 10, '/bounce', 'https://news.ycombinator.com/item?id=1'],
  ['pagesAcrossTheHour', 'a', 50, '/pages/before', ''],
  ['pagesAcrossTheHour', 'b', 70, '/pages/after', '/pages/before'],
  ['twoPages', 'a', 121, '/two/first', 'https://stellar.org/'],
  ['twoPages', 'b', 124, '/two/second', '/two/first'],
  ['sameBrowser', 'a', 200, '/same-browser', ''],
  // One visit over the hour, then a view 35 minutes after the visit began: a second visit.
  ['appAcrossTheHour', 'a', 110, '/app/0150', ''],
  ['appAcrossTheHour', 'a', 125, '/app/0205', ''],
  ['appAcrossTheHour', 'a', 135, '/app/0215', ''],
  ['appAcrossTheHour', 'a', 145, '/app/0225', ''],
  // An app left open for an hour and a half, over two hour boundaries.
  ['appForHours', 'a', 220, '/long/0340', ''],
  ['appForHours', 'a', 235, '/long/0355', ''],
  ['appForHours', 'a', 245, '/long/0405', ''],
  ['appForHours', 'a', 252, '/long/0412', ''],
  ['appForHours', 'a', 290, '/long/0450', ''],
  ['appForHours', 'a', 310, '/long/0510', ''],
  // Two tabs of one visitor, opened either side of the hour and used in turn.
  ['twoTabs', 'a', 175, '/tab-a/0255', ''],
  ['twoTabs', 'b', 182, '/tab-b/0302', ''],
  ['twoTabs', 'a', 185, '/tab-a/0305', ''],
  ['twoTabs', 'b', 190, '/tab-b/0310', ''],
]
  .map(toEvent(T0))
  .sort((a, b) => a.timestamp - b.timestamp);

// A multi-page visitor and a single-page app, each with a view either side of 00:00 UTC.
const MIDNIGHT_EVENTS = [
  ['pagesAcrossTheHour', 'a', -20, '/midnight/pages/2340', ''],
  ['appAcrossTheHour', 'a', -10, '/midnight/app/2350', ''],
  ['appAcrossTheHour', 'a', 5, '/midnight/app/0005', ''],
  ['pagesAcrossTheHour', 'b', 20, '/midnight/pages/0020', ''],
].map(toEvent(MIDNIGHT));

function toEvent(origin) {
  return ([visitor, pageLoad, minutes, url, referrer]) => ({
    visitor,
    pageLoad: `${visitor}/${pageLoad}`,
    timestamp: origin + minutes * MINUTE,
    url,
    referrer,
  });
}

const facts = {};
const sum = (numbers) => numbers.reduce((total, number) => total + number, 0);

function printTable(title, header, rows) {
  console.log(`\n${title}\n| ${header.join(' | ')} |\n|${header.map(() => '---').join('|')}|`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
}

// Direct ingestion as Umami's tracker does it: no timestamp, the visitor's own address and
// User-Agent, and the token of the previous answer for as long as the page stays loaded.
async function sendDirect(context, website, events = EVENTS) {
  const tokens = new Map();
  for (const event of events) {
    const visitor = VISITORS[event.visitor];
    stack.setDirectClock(event.timestamp);
    const payload = { website, hostname: 'check.test', url: event.url, referrer: event.referrer };
    const headers = { 'x-forwarded-for': visitor.address, 'user-agent': visitor.userAgent };
    if (tokens.has(event.pageLoad)) headers['x-umami-cache'] = tokens.get(event.pageLoad);
    const body = { type: 'event', payload };
    const answer = await stack.post(context.clock, '/api/send', body, headers);
    if (answer.status !== 200) {
      throw new Error(`Direct ingestion answered ${answer.status} for ${event.url}.`);
    }
    tokens.set(event.pageLoad, answer.body.cache);
  }
}

// The same events through the gateway model: each one becomes a spool record on disk.
function spoolScenario(context, website, name, events = EVENTS) {
  const spoolDir = path.join(context.scratch, `spool-${name}`);
  const gateway = createGateway({ spoolDir, logFile: context.gatewayLog });
  const pageLoadStart = new Map();
  for (const event of events) {
    if (!pageLoadStart.has(event.pageLoad)) pageLoadStart.set(event.pageLoad, event.timestamp);
    gateway.accept({
      ...VISITORS[event.visitor],
      site: website,
      url: event.url,
      referrer: event.referrer,
      receivedAt: event.timestamp,
      pageElapsed: event.timestamp - pageLoadStart.get(event.pageLoad),
    });
  }
  gateway.close();
  context.spoolDirs.push(spoolDir);
  return readSpool(spoolDir);
}

// Page views Umami holds for a site on one UTC day, read through its API.
function heldFor(context, site, day) {
  const startAt = Date.parse(`${day}T00:00:00Z`);
  const endAt = startAt + 24 * HOUR * 1000 - 1;
  return stack.pageViewsHeld(context.umami, context.auth, site, startAt, endAt);
}

function newForwarder(context, options = {}) {
  const held = (site, day) => heldFor(context, site, day);
  return createForwarder({ umamiUrl: context.umami, wireLog: context.wireLog, held, ...options });
}

// Round one's forwarder: one batch per country and nothing else.
function planWithoutToken(records) {
  const byCountry = Object.groupBy(records, (record) => record.country);
  return Object.entries(byCountry).map(([country, group]) => ({ country, records: group }));
}

async function visitContinuity(context) {
  const site = (name) => stack.createWebsite(context.umami, context.auth, name);
  const direct = await site('direct');
  const forwarded = await site('forwarded');
  const plain = await site('forwarded, no token');
  await sendDirect(context, direct);

  const records = spoolScenario(context, forwarded, 'forwarded');
  // Several small flushes and one restart: a new forwarder takes over after 8 records and
  // has only the state file to know which visits are running.
  const stateFile = path.join(context.scratch, 'forwarder-state.json');
  let forwarder = newForwarder(context, { stateFile });
  const reports = [forwarder.report];
  for (let from = 0; from < records.length; from += FLUSH_SIZE) {
    if (from === RESTART_AFTER) {
      forwarder = newForwarder(context, { stateFile });
      reports.push(forwarder.report);
    }
    await forwarder.flush(records.slice(from, from + FLUSH_SIZE));
  }
  const plainRecords = spoolScenario(context, plain, 'no-token');
  await newForwarder(context, { plan: planWithoutToken }).flush(plainRecords);

  const read = (website) => stack.metrics(context.umami, context.auth, website, RANGE);
  const [reference, carried, split] = [await read(direct), await read(forwarded), await read(plain)];
  const equal = stack.printComparison(
    'A. Direct ingestion (no timestamp, token resent) against the forwarder that carries the token',
    reference,
    carried,
    'direct',
    'forwarded',
  );
  const title = 'A. The same against a forwarder without the token (round one)';
  stack.printComparison(title, reference, split, 'direct', 'no token');

  const visits = (website) => stack.visitPartition(website);
  console.log(`\nA. Page views per visit, direct:\n${visits(direct)}`);
  console.log(`\nA. Page views per visit, forwarded with the token:\n${visits(forwarded)}`);
  console.log(`\nA. Page views per visit, forwarded without the token:\n${visits(plain)}`);
  const requests = sum(reports.map((report) => report.requests));
  const tokenBatches = sum(reports.map((report) => report.tokenBatches));
  const peakPageLoads = Math.max(...reports.map((report) => report.peakPageLoads));
  console.log(
    `\nA. Cost for ${records.length} page views in ${Math.ceil(records.length / FLUSH_SIZE)} ` +
      `flushes with one restart: ${requests} requests, of which ${tokenBatches} ask for a token and ` +
      `${tokenBatches} are batches that carry one; at most ${peakPageLoads} page loads ` +
      'remembered from one flush to the next.',
  );

  facts['A: forwarded visits are the same visits as direct ingestion'] =
    equal && visits(forwarded) === visits(direct);
  facts['A: without the token the forwarder groups page views into other visits'] =
    visits(plain) !== visits(direct);
  return { forwarded, records, forwarder, carried };
}

// The per-visitor value changes at 00:00 UTC, so the forwarded path starts a new visitor and
// a new visit there. Direct ingestion does not: Umami's own salt changes once a month.
async function acrossMidnight(context) {
  const direct = await stack.createWebsite(context.umami, context.auth, 'midnight, direct');
  const forwarded = await stack.createWebsite(context.umami, context.auth, 'midnight, forwarded');
  await sendDirect(context, direct, MIDNIGHT_EVENTS);
  await newForwarder(context).flush(spoolScenario(context, forwarded, 'midnight', MIDNIGHT_EVENTS));
  const read = async (website) => {
    const stored = await stack.metrics(context.umami, context.auth, website, RANGE);
    return [stored['page views'], stored['unique visitors'], stored.visits];
  };
  const [directCounts, forwardedCounts] = [await read(direct), await read(forwarded)];
  printTable(
    `A. Two visitors with views either side of ${new Date(MIDNIGHT * 1000).toISOString()}`,
    ['', 'page views', 'unique visitors', 'visits'],
    [
      ['direct', ...directCounts],
      ['forwarded', ...forwardedCounts],
    ],
  );
  facts['A: across 00:00 UTC the forwarded path counts a new visitor and a new visit'] =
    directCounts.join() === '4,2,3' && forwardedCounts.join() === '4,4,4';
}

const decodeToken = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));

// What the token is, measured on a website of its own with hand-made batches.
async function tokenProperties(context) {
  const website = await stack.createWebsite(context.umami, context.auth, 'token');
  const headers = {
    'x-forwarded-for': '192.0.2.1',
    'cf-ipcountry': 'UY',
    'user-agent': 'Mozilla/5.0 UsageSignalsForwarder/1.0',
  };
  const labels = { browser: 'chrome', os: 'Linux', device: 'desktop' };
  const item = (minutes, salt, type = 'event') => {
    const timestamp = T0 + minutes * MINUTE;
    const payload = { website, hostname: 'check.test', timestamp, salt, ...labels };
    if (type === 'event') payload.url = `/${salt}/${minutes}`;
    return { type, payload };
  };
  const batch = async (items, token) => {
    const withToken = token ? { ...headers, 'x-umami-cache': token } : headers;
    return (await stack.post(context.umami, '/api/batch', items, withToken)).body.cache;
  };
  const where = `WHERE website_id = '${website}'`;
  const count = (table) => Number(stack.psql(`SELECT count(*) FROM ${table} ${where}`));
  const visitOf = (url) => {
    const sql = `SELECT session_id, visit_id FROM website_event ${where} AND url_path = '${url}'`;
    const [session, visit] = stack.psql(sql).split('|');
    return { session, visit };
  };

  const minted = await batch([item(50, 'today', 'identify')]);
  const storedByTokenRequest = [count('website_event'), count('session_data'), count('session')];
  console.log(`\nA. Rows after a token request (events, session data, sessions): ${storedByTokenRequest}`);
  const token = decodeToken(minted);
  console.log(`\nA. The token, decoded: ${JSON.stringify(token)}`);

  const answered = decodeToken(await batch([item(51, 'other'), item(52, 'today')]));
  await batch([item(65, 'today'), item(66, 'other')], minted);
  await batch([item(350, 'today')], minted);
  await batch([item(67, 'tomorrow')], minted);
  const [own, later, tomorrow] = ['/today/65', '/today/350', '/tomorrow/67'].map(visitOf);
  const [otherBefore, otherAfter] = [visitOf('/other/51'), visitOf('/other/66')];

  facts['A: a token request stores no event and no session data, and one session row'] =
    storedByTokenRequest.join() === '0,0,1';
  facts['A: the token holds a session id, a visit id and a start time, and no expiry'] =
    Object.keys(token).sort().join() === 'iat,sessionId,type,visitId,websiteId';
  facts['A: a batch answers with one token, that of its first accepted item'] =
    answered.sessionId === otherBefore.session;
  facts['A: the token moves its own visitor into the visit and leaves another visitor alone'] =
    own.visit === token.visitId &&
    otherAfter.session === otherBefore.session &&
    ![otherBefore.visit, token.visitId].includes(otherAfter.visit);
  facts['A: Umami never ends the visit itself: five hours later the token still applies'] =
    later.visit === token.visitId;
  facts["A: with the next day's per-visitor value the token links nothing"] =
    tomorrow.session !== token.sessionId && tomorrow.visit !== token.visitId;
}

const titleCase = (text) => text.replace(/^./, (letter) => letter.toUpperCase());
const titleCaseLabels = (userAgent) =>
  Object.fromEntries(
    Object.entries(reduceUserAgent(userAgent)).map(([key, label]) => [key, titleCase(label)]),
  );
const COMPATIBLE_USER_AGENT = 'Mozilla/5.0 (compatible; UsageSignalsForwarder/1.0)';

// Each deployment breaks one condition. `fact` completes "the probe catches ...".
const VIOLATIONS = [
  {
    name: 'Umami without ENABLE_CLIENT_SALT',
    fact: 'an Umami that ignores the salt',
    onDefaults: true,
    expect: ['ENABLE_CLIENT_SALT'],
  },
  {
    name: 'forwarder User-Agent "node"',
    fact: 'a forwarder User-Agent that Umami drops',
    forwarder: { userAgent: 'node' },
    expect: ['forwarder User-Agent'],
  },
  {
    name: `forwarder User-Agent "${COMPATIBLE_USER_AGENT}"`,
    fact: 'the usual "(compatible; ...)" User-Agent',
    forwarder: { userAgent: COMPATIBLE_USER_AGENT },
    expect: ['forwarder User-Agent'],
  },
  {
    name: 'gateway labels in another spelling (Chrome, IOS, Desktop)',
    fact: "browser, OS and device labels that are not Umami's",
    reduce: titleCaseLabels,
    expect: ['browser labels', 'os labels', 'device labels'],
  },
  {
    name: 'placeholder 10.0.0.1',
    fact: 'a private placeholder address',
    forwarder: { placeholder: '10.0.0.1' },
    expect: ['placeholder address'],
  },
  {
    name: 'placeholder "not-an-address"',
    fact: 'an invalid placeholder address',
    forwarder: { placeholder: 'not-an-address' },
    expect: ['placeholder address'],
  },
  {
    name: 'all countries in one batch',
    fact: 'a batch that mixes countries',
    forwarder: { plan: (records) => [{ country: records[0].country, records }] },
    expect: ['one batch per country'],
  },
];

async function contractConditions(context) {
  const probe = ({ onDefaults, forwarder, reduce }) =>
    contractProbe({
      umamiUrl: onDefaults ? context.defaults : context.umami,
      auth: context.auth,
      forwarder,
      reduce,
    });
  const describe = (violations) =>
    violations.map((violation) => `${violation.condition}: ${violation.detail}`).join(' / ');
  const good = await probe({});
  const rows = [['as designed', describe(good) || 'none']];
  facts['B: the probe passes on the deployment as designed'] = good.length === 0;
  for (const violation of VIOLATIONS) {
    const reported = await probe(violation);
    rows.push([violation.name, describe(reported) || 'none']);
    const conditions = reported.map((entry) => entry.condition);
    facts[`B: the probe catches ${violation.fact}`] = violation.expect.join() === conditions.join();
  }
  printTable('B. Contract probe', ['deployment', 'violations reported'], rows);
}

function plainRecords(site, count) {
  return Array.from({ length: count }, (_, index) => ({
    site,
    timestamp: T0 + index * MINUTE,
    url: `/item/${index}`,
    referrer: '',
    country: 'UY',
    browser: 'chrome',
    os: 'Linux',
    device: 'desktop',
    quality: 'ok',
    visitor: randomBytes(16).toString('hex'),
    pageStart: T0 + index * MINUTE,
  }));
}

// Half the items of one batch name a website Umami does not have yet. It exists by the retry.
async function resendFailedItems(context) {
  const known = await stack.createWebsite(context.umami, context.auth, 'partial, known');
  const late = randomUUID();
  const [a, b] = [plainRecords(known, 3), plainRecords(late, 3)];
  const forwarder = newForwarder(context, {
    beforeRetry: () => stack.createWebsite(context.umami, context.auth, 'partial, late', late),
  });
  await forwarder.flush([a[0], b[0], a[1], b[1], a[2], b[2]]);
  const held = async (site) =>
    (await stack.metrics(context.umami, context.auth, site, RANGE))['page views'];
  const [inKnown, inLate] = [await held(known), await held(late)];
  const { requests, itemsSent, deadLetters } = forwarder.report;
  console.log(
    `\nC. A batch of 6 in which 3 items fail: ${requests} requests, ${itemsSent} items sent, ` +
      `${deadLetters.length} given up. Umami holds ${inKnown} and ${inLate} page views for the ` +
      'two sites; 3 and 3 were spooled.',
  );
  facts['C: resending only the failed items stores every event once'] =
    inKnown === 3 && inLate === 3 && deadLetters.length === 0;
}

// A transport that delivers every batch to Umami and loses the answer to two of them: the
// one with a three-page visit and the one with a bounce.
function losingTwoResponses(context) {
  const transport = httpTransport(context.wireLog);
  const pending = new Set(['/pricing', '/bounce']);
  const lost = { items: 0 };
  return {
    lost,
    transport: async (url, headers, body) => {
      const response = await transport(url, headers, body);
      const marker = body.map((item) => item.payload.url).find((path) => pending.has(path));
      if (!marker) return response;
      pending.delete(marker);
      lost.items += body.length;
      throw new Error('the response was lost');
    },
  };
}

function printReconciliation(title, rows) {
  const header = ['site', 'UTC day', 'spooled', 'acknowledged', 'Umami holds', 'difference'];
  const cells = rows.map((row) => [
    row.site.slice(0, 8),
    row.day,
    row.spooled,
    row.acknowledged,
    row.held,
    row.held - row.spooled,
  ]);
  printTable(title, header, cells);
  return sum(rows.map((row) => row.held - row.spooled));
}

async function lostResponse(context, clean) {
  const held = (site, day) => heldFor(context, site, day);
  const run = async (name, onLostResponse) => {
    const website = await stack.createWebsite(context.umami, context.auth, name);
    const records = spoolScenario(context, website, name);
    const { lost, transport } = losingTwoResponses(context);
    const forwarder = newForwarder(context, { transport, onLostResponse });
    await forwarder.flush(records);
    const stored = await stack.metrics(context.umami, context.auth, website, RANGE);
    const rows = await reconcile(records, forwarder.ledger, held);
    return { lost, stored, rows, website, records, forwarder };
  };
  const compare = (title, stored, name) =>
    stack.printComparison(title, clean.carried, stored, 'no loss', name);

  const resent = await run('lost-response-resend', 'resend');
  const resentTitle = `C. Two responses lost (${resent.lost.items} page views), both batches resent`;
  const duplicated = !compare(resentTitle, resent.stored, 'resent');
  const surplus = printReconciliation('C. Reconciliation after the resend', resent.rows);
  const cleanRows = await reconcile(clean.records, clean.forwarder.ledger, held);
  const cleanSurplus = printReconciliation('C. Reconciliation of the run without a loss', cleanRows);

  // The repair: the count shows a surplus, the forwarder knows which batches it resent.
  const drop = (site, session) => stack.deleteSession(context.umami, context.auth, site, session);
  const { sessions, replayed } = await resent.forwarder.repair(resent.records, drop);
  const afterRepair = await stack.metrics(context.umami, context.auth, resent.website, RANGE);
  const repairTitle = `C. After deleting ${sessions} sessions and replaying their ${replayed} page views`;
  const repaired = compare(repairTitle, afterRepair, 'repaired');
  const repairedRows = await reconcile(resent.records, resent.forwarder.ledger, held);
  const repairedSurplus = printReconciliation('C. Reconciliation after the repair', repairedRows);
  const sameVisits = stack.visitPartition(resent.website) === stack.visitPartition(clean.forwarded);

  const readBack = await run('lost-response-read-back', 'readBack');
  const readBackTitle =
    `C. Two responses lost (${readBack.lost.items} page views), ` +
    "Umami's count read before resending";
  const same = compare(readBackTitle, readBack.stored, 'read back');
  const readBackSurplus = printReconciliation('C. Reconciliation after reading back', readBack.rows);

  facts['C: a resent batch is stored twice: page views rise by the size of the batches'] =
    duplicated && resent.stored['page views'] === clean.carried['page views'] + resent.lost.items;
  facts['C: the reconciliation count finds the duplicated batch'] =
    surplus === resent.lost.items && cleanSurplus === 0;
  facts['C: deleting the affected sessions and replaying them removes the duplicate'] =
    repaired && sameVisits && repairedSurplus === 0 && sessions > 0;
  facts['C: reading back before resending avoids the duplicate'] =
    same && readBackSurplus === 0 && readBack.lost.items > 0;
}

// Every request the forwarder made: the placeholder in the proxy header, no address field.
function forwarderSentNoAddress(wireLog) {
  const lines = readFileSync(wireLog, 'utf8').split('\n').filter(Boolean);
  return lines.every((line) => {
    const [, headers, body] = line.match(/^\S+ (\{.*?\}) (\[.*\])$/);
    const items = JSON.parse(body);
    return (
      JSON.parse(headers)['x-forwarded-for'] === '192.0.2.1' &&
      items.every((item) => !('ip' in item.payload) && !('userAgent' in item.payload))
    );
  });
}

function nothingOnDisk(context, planted) {
  const needles = Object.values(VISITORS).flatMap((visitor) => needlesFor(visitor.address));
  const { rows, filesWrittenByUmami } = scanDisk({ ...context, needles, planted });
  printTable(
    `D. ${Object.keys(VISITORS).length} visitor addresses in ${needles.length} written forms ` +
      '(full, /24 or /48, dotted prefix, dashed, decimal, hex), searched for in:',
    ['place', 'forms found', 'planted string found'],
    rows.map((row) => [row.place, row.found.join(', ') || 'none', row.plantedFound ? 'yes' : 'NO']),
  );
  const written = filesWrittenByUmami.join('\n');
  console.log(`Files written by the Umami containers since they started:\n${written}`);
  const firstSegment = path.join(context.spoolDirs[0], 'segment-000001.jsonl');
  console.log(`A spool record: ${readFileSync(firstSegment, 'utf8').split('\n')[0]}`);

  const clean = (place) => rows.find((row) => row.place === place).found.length === 0;
  facts['D: no address or prefix is in the spool'] = clean('spool files');
  facts['D: no address or prefix is in the gateway log'] = clean('gateway log');
  facts['D: no address or prefix leaves the forwarder'] =
    clean('forwarder requests') && forwarderSentNoAddress(context.wireLog);
  facts["D: no address or prefix is in Umami's database, dump or raw files"] =
    clean('database dump') && clean('database files (raw)');
  facts['D: no address or prefix is in the container logs, with every SQL statement logged'] =
    clean('container logs');
  facts['D: no address or prefix is in the files the Umami containers wrote'] = clean(
    'files written by the Umami containers',
  );
  facts['D: the scanner finds a planted string in every place it searches'] = rows.every(
    (row) => row.plantedFound,
  );
}

async function main() {
  const started = Date.now();
  const mutation = MUTATION ? ` MUTATION: ${MUTATION}` : '';
  console.log(`Starting the isolated stack (compose project us-check-01-r2) ...${mutation}`);
  stack.startStack();
  const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-01-r2-'));
  const context = {
    scratch,
    umami: stack.serviceUrl('umami'),
    defaults: stack.serviceUrl('umami-defaults'),
    clock: stack.serviceUrl('umami-clock'),
    gatewayLog: path.join(scratch, 'gateway.log'),
    wireLog: path.join(scratch, 'forwarder-requests.log'),
    spoolDirs: [],
  };
  context.auth = await stack.login(context.umami);
  const from = new Date(T0 * 1000).toISOString();
  console.log(`${EVENTS.length} page views, ${Object.keys(VISITORS).length} visitors, from ${from}.`);

  const clean = await visitContinuity(context);
  await acrossMidnight(context);
  await tokenProperties(context);
  await contractConditions(context);
  await resendFailedItems(context);
  await lostResponse(context, clean);
  // The website id is text in every place but the raw database files; the path is text there.
  nothingOnDisk(context, [clean.forwarded, '/same-browser']);

  console.log('\nFACTS THE VERDICTS REST ON');
  for (const [fact, holds] of Object.entries(facts)) {
    console.log(`${holds ? 'holds  ' : 'BROKEN '} ${fact}`);
  }
  const allHold = Object.values(facts).every(Boolean);
  console.log(
    allHold
      ? '\nEvery fact holds: the round-two verdicts in README.md stand.'
      : '\nAt least one fact does not hold: the round-two verdicts in README.md do not stand.',
  );
  console.log(`Scratch (spools, logs, forwarder requests, dump; not deleted): ${scratch}`);
  console.log(`Took ${Math.round((Date.now() - started) / 1000)} s.`);
  return allHold;
}

let allHold = false;
try {
  allHold = await main();
} finally {
  if (!process.argv.includes('--keep')) stack.removeStack();
}
process.exit(allHold ? 0 : 1);
