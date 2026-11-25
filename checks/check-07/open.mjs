// Check 07, second part: the location fails while the client holds an open connection to it.
// Every repetition sends three times with one exporter (or one browser tab) to a name whose
// first address is the location that fails:
//   1st  both locations answer; the client connects to the first address
//   2nd  after the gap; by then run.mjs has failed that address with an iptables rule
//   3rd  60 seconds after the 2nd, as a periodic exporter would
// "silent" drops every packet of the port in both directions. "reset" answers every packet
// with a TCP reset, as a host that has lost its connection state does.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const NEXT_MS = 60_000;
const TAIL_MS = 90_000;
const GAPS_MS = (process.env.CHECK_OPEN_GAPS || '20000,100000').split(',').map(Number);
const FIRST_PORT = 4100;
const CLIENT_IDS = ['chromium', 'node', 'python', 'go', 'collector'];
const SDK = {
  node: ['client-node', ['node', '/sdk/export.mjs']],
  python: ['client-python', ['python', '/sdk/export.py']],
  go: ['client-go', ['export']],
};
const RULES = {
  silent: (port) => [
    ['-A', 'INPUT', '-p', 'tcp', '--dport', port, '-j', 'DROP'],
    ['-A', 'OUTPUT', '-p', 'tcp', '--sport', port, '-j', 'DROP'],
  ],
  reset: (port) => [
    ['-A', 'INPUT', '-p', 'tcp', '--dport', port, '-j', 'REJECT', '--reject-with', 'tcp-reset'],
  ],
};

const CASES = ['none', 'silent', 'reset'].flatMap((failure, row) =>
  GAPS_MS.map((gapMs, column) => ({
    id: `open-${failure}-${gapMs / 1000}`,
    failure,
    gapMs,
    index: row * 2 + column,
  })),
);

// Whether all, none or some of the 2nd and 3rd sends arrived, in the run recorded in README.md.
const ALL = ['all', 'all'];
const LOST = ['none', 'all'];
// Keyed by failure and gap in seconds. The 8 s gap is the supplementary run.
const PUBLISHED = {
  chromium: { silent: { 8: LOST, 20: LOST, 100: LOST }, reset: { 8: ALL, 20: ALL, 100: ALL } },
  node: { silent: { 8: LOST, 20: ALL, 100: ALL }, reset: { 8: ALL, 20: ALL, 100: ALL } },
  python: { silent: { 8: LOST, 20: LOST, 100: LOST }, reset: { 8: ALL, 20: ALL, 100: ALL } },
  go: { silent: { 8: ALL, 20: ALL, 100: ALL }, reset: { 8: LOST, 20: LOST, 100: ALL } },
  collector: { silent: { 8: ALL, 20: ALL, 100: ALL }, reset: { 8: ALL, 20: ALL, 100: ALL } },
};

function portOf(testCase, client) {
  return FIRST_PORT + testCase.index * 10 + CLIENT_IDS.indexOf(client.id);
}

function arrivalsOn(kit, port) {
  const at = (name) =>
    kit.readJsonl(name).filter((record) => record.k === 'req' && record.port === port);
  return { failing: at('endpoint-a.jsonl'), live: at('endpoint-b.jsonl') };
}

/** Fails the port at the first location once every repetition has sent its first request. */
async function failWhenOpen(kit, testCase, port) {
  if (testCase.failure === 'none') return;
  const limit = Date.now() + 90_000;
  while (arrivalsOn(kit, port).failing.length < kit.REPS) {
    if (Date.now() > limit) throw new Error(`${testCase.id}: first requests did not all arrive`);
    await sleep(300);
  }
  for (const rule of RULES[testCase.failure](String(port))) {
    await kit.docker([...kit.COMPOSE, 'exec', '-T', 'endpoint-a', 'iptables', ...rule]);
  }
}

async function runCollector(kit, testCase, input) {
  const config = kit.collectorConfig({ id: testCase.id, port: input.port }, input.hosts);
  writeFileSync(path.join(kit.scratch, 'collector-active.yaml'), JSON.stringify(config, null, 1));
  const profile = [...kit.COMPOSE, '--profile', 'collector'];
  await kit.docker([...profile, 'up', '-d', '--force-recreate', 'collector']);
  const { rounds } = await kit.execForResult('client-node', ['node', '/check/collector-send.mjs'], {
    warmUpPort: kit.WARM_UP_RECEIVER_PORT,
    ports: input.hosts.map((_, index) => kit.RECEIVER_PORT + index),
    staggerMs: input.staggerMs,
    offsetsMs: input.offsetsMs,
  });
  const expected = input.hosts.length * input.offsetsMs.length;
  const end = Date.now() + TAIL_MS;
  while (Date.now() < end) {
    const seen = arrivalsOn(kit, input.port);
    if (seen.failing.length + seen.live.length >= expected) break;
    await sleep(1000);
  }
  const logs = await kit.docker([...profile, 'logs', '--no-color', '--no-log-prefix', 'collector']);
  writeFileSync(path.join(kit.scratch, `collector-${testCase.id}.log`), logs.stdout + logs.stderr);
  await kit.docker([...profile, 'rm', '-sf', 'collector']);
  const reps = input.hosts.map((host, index) => ({
    host,
    sends: rounds.map((sent) => ({ t0: sent[index], outcome: 'accepted by the collector' })),
  }));
  return { reps };
}

async function runCase(kit, client, testCase) {
  const port = portOf(testCase, client);
  const hosts = Array.from({ length: kit.REPS }, (_, index) => {
    return `${client.id}-${testCase.id}-${String(index).padStart(2, '0')}.df.ingest.test`;
  });
  const offsetsMs = [0, testCase.gapMs, testCase.gapMs + NEXT_MS];
  const input = { hosts, port, staggerMs: 100, offsetsMs };
  let result;
  if (client.id === 'collector') {
    result = runCollector(kit, testCase, input);
  } else if (client.id === 'chromium') {
    const browser = { ...input, staggerMs: 250, tailMs: TAIL_MS, chromium: client.address };
    result = kit.execForResult('client-node', ['node', '/check/browser-open.mjs'], browser);
  } else {
    result = kit.execForResult(...SDK[client.id], input);
  }
  const [finished] = await Promise.all([result, failWhenOpen(kit, testCase, port)]);
  console.log(`  ${client.id} ${testCase.id}: done`);
  return { client: client.id, case: testCase.id, port, ...finished };
}

/** For the collector a send is delivered when a body of that round's size arrives. */
function collectorSends(run, arrivals, sizes) {
  const all = [...arrivals.failing, ...arrivals.live];
  return run.reps.map((rep) =>
    rep.sends.map((send, round) => {
      const hit = all.find(
        (record) => record.host === `${rep.host}:${run.port}` && record.bytes === sizes[round],
      );
      if (!hit) return { ...send, outcome: 'not delivered in the window' };
      return { ...send, outcome: 'ok', elapsedMs: Math.max(0, hit.t - send.t0) };
    }),
  );
}

function summarise(sends, median) {
  const ok = sends.filter((send) => send.outcome === 'ok').map((send) => send.elapsedMs);
  const groups = new Map();
  for (const send of sends.filter((candidate) => candidate.outcome !== 'ok')) {
    const error = (send.error || '')
      .replace(/[a-z0-9-]+-\d\d\.df/g, '<rep>.df')
      .replace(/(\d+\.){3}\d+:\d+/g, '<address>')
      .slice(0, 200);
    const key = send.outcome + (error ? `: ${error}` : '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(send.elapsedMs);
  }
  const failures = [...groups].map(([key, elapsed]) => {
    const timed = elapsed.filter((value) => value !== undefined);
    const after = timed.length ? ` after ${(median(timed) / 1000).toFixed(1)} s` : '';
    return `${elapsed.length} ${key}${after}`;
  });
  const times = ok.length ? `, ${median(ok)} / ${Math.max(...ok)}` : '';
  const text = `${ok.length}/${sends.length}${times}`;
  return { delivered: ok.length, text: failures.length ? `${text}; ${failures.join('; ')}` : text };
}

function analyse(kit, run, sizes) {
  const client = kit.CLIENTS.find((candidate) => candidate.id === run.client);
  const arrivals = arrivalsOn(kit, run.port);
  const isCollector = run.client === 'collector';
  const fromClient = () => run.reps.map((rep) => rep.sends);
  const perRep = isCollector ? collectorSends(run, arrivals, sizes) : fromClient();
  const columns = [0, 1, 2].map((round) =>
    summarise(perRep.map((sends) => sends[round]), kit.median),
  );
  const okCount = columns.reduce((sum, column) => sum + column.delivered, 0);
  const posts = (records) => records.filter((record) => record.method === 'POST').length;
  const testCase = { port: run.port };
  return {
    client: run.client,
    case: run.case,
    columns,
    arrived: { failing: posts(arrivals.failing), live: posts(arrivals.live) },
    consistent: okCount === posts(arrivals.failing) + posts(arrivals.live),
    toFailing: kit.connections(kit.readJsonl('endpoint-a.jsonl'), client, testCase).count,
    toLive: kit.connections(kit.readJsonl('endpoint-b.jsonl'), client, testCase).count,
  };
}

function printTable(kit, client, rows) {
  console.log(`\n### ${client.label.replace(', page stays open', '')}: open connection\n`);
  console.log(
    '| Case | 1st send | 2nd send: delivered, median / worst ms | 3rd send, 60 s later ' +
      '| POSTs arrived at failing / live | Connections to failing / live |',
  );
  console.log('|---|---|---|---|---|---|');
  for (const row of rows) {
    const cells = [
      row.case,
      ...row.columns.map((column) => column.text.replaceAll('|', '/')),
      `${row.arrived.failing} / ${row.arrived.live}`,
      `${row.toFailing} / ${row.toLive}`,
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}

function shareOf(delivered, total) {
  if (delivered === total) return 'all';
  return delivered === 0 ? 'none' : 'some';
}

function findProblems(kit, rows) {
  const problems = [];
  for (const row of rows) {
    const name = `${row.client} ${row.case}`;
    if (row.columns[0].delivered !== kit.REPS) problems.push(`${name}: a first send failed`);
    if (!row.consistent) problems.push(`${name}: client results and arrivals disagree`);
    const got = row.columns.slice(1).map((column) => shareOf(column.delivered, kit.REPS));
    const [, failure, gap] = row.case.split('-');
    const published = failure === 'none' ? ALL : PUBLISHED[row.client]?.[failure]?.[gap];
    if (String(got) !== String(published)) {
      problems.push(`${name}: 2nd and 3rd send "${got}", published "${published}"`);
    }
  }
  return problems;
}

/** Runs the open-connection cases for every client and returns the list of problems. */
export async function runOpenConnection(kit) {
  console.log('\nOpen connection (one line per client and case when it ends):');
  const clients = kit.CLIENTS.filter((client) => CLIENT_IDS.includes(client.id));
  const lanes = clients.map(async (client) => {
    const runs = [];
    for (const testCase of CASES) runs.push(await runCase(kit, client, testCase));
    return runs;
  });
  const runs = (await Promise.all(lanes)).flat();
  writeFileSync(path.join(kit.scratch, 'open-runs.json'), JSON.stringify(runs, null, 1));

  // Body sizes of the three rounds, read from the collector's control case.
  const control = runs.find((run) => run.client === 'collector');
  const bodies = arrivalsOn(kit, control.port).failing.map((record) => record.bytes);
  const sizes = [...new Set(bodies)].sort((left, right) => left - right);
  if (sizes.length !== 3) throw new Error(`expected three body sizes, saw ${sizes}`);

  const rows = runs.map((run) => analyse(kit, run, sizes));
  writeFileSync(path.join(kit.scratch, 'open-rows.json'), JSON.stringify(rows, null, 1));
  console.log(`\n## Open connection (${kit.REPS} repetitions)`);
  for (const client of clients) {
    printTable(kit, client, rows.filter((row) => row.client === client.id));
  }
  return findProblems(kit, rows);
}
