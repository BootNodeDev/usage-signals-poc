// Check 07: "Browsers and OTLP exporters fall back to the second address when one ingest
// location is dead."
// Starts an isolated stack, runs every client against every failure mode, prints the
// evidence and the verdicts, removes the stack, and exits non-zero when a control fails or
// a verdict differs from the published one.
// Usage: node run.mjs
//   CHECK_REPS=50          repetitions per client and case
//   CHECK_WINDOW_MS=150000 how long a request is observed before it counts as not delivered
//   CHECK_PART=new|open    runs only the new-connection or only the open-connection cases
//   CHECK_NEGATIVE=1       negative control: the second location is dead too; must exit 1
//   CHECK_KEEP_STACK=1     leaves the containers up afterwards
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { runOpenConnection } from './open.mjs';

const HERE = import.meta.dirname;
const COMPOSE = ['compose', '-p', 'us-check-07', '-f', path.join(HERE, 'compose.yml')];
const REPS = Number(process.env.CHECK_REPS || 50);
const WINDOW_MS = Number(process.env.CHECK_WINDOW_MS || 150_000);
const NEGATIVE = process.env.CHECK_NEGATIVE === '1';
const PART = process.env.CHECK_PART || 'all';
const SLOW = 'Yes, with one stated condition';
// Repetitions start one at a time, so that one does not slow the next.
const STAGGER_MS = { browser: 250, sdk: 100 };

// The port selects the failure mode of the failing location (endpoint/endpoint.mjs); the
// order is the order of the two A records: df = failing address first, ds = second.
// Every case has its own port, so a connection attempt belongs to exactly one case.
const WARM_UP = { id: 'warmup-ds', order: 'ds', port: 4020 };
const CASES = [
  { id: 'control-df', order: 'df', port: 4000 },
  { id: 'control-ds', order: 'ds', port: 4010 },
  { id: 'refused-df', order: 'df', port: 4001 },
  { id: 'refused-ds', order: 'ds', port: 4011 },
  { id: 'drop-df', order: 'df', port: 4002 },
  { id: 'drop-ds', order: 'ds', port: 4012 },
  { id: 'hang-df', order: 'df', port: 4003 },
  { id: 'hang-ds', order: 'ds', port: 4013 },
  { id: 'bothdead-df', order: 'df', port: 4009 },
];

// Budgets are the document's ingestion indicator: 2 seconds for web events, 5 for OTLP.
const CLIENTS = [
  { id: 'chromium', label: 'Chromium, page stays open', address: '10.207.7.20', budgetMs: 2000 },
  { id: 'chromiumclose', label: 'Chromium, page closed', address: '10.207.7.25', budgetMs: 2000 },
  { id: 'node', label: 'OpenTelemetry SDK, Node.js', address: '10.207.7.21', budgetMs: 5000 },
  { id: 'python', label: 'OpenTelemetry SDK, Python', address: '10.207.7.22', budgetMs: 5000 },
  { id: 'go', label: 'OpenTelemetry SDK, Go', address: '10.207.7.23', budgetMs: 5000 },
  { id: 'collector', label: 'Collector, otlphttp', address: '10.207.7.24', budgetMs: 5000 },
];

// The verdicts of the run recorded in README.md.
const FAST = {
  'refused-df': 'Yes',
  'refused-ds': 'Yes',
  'drop-df': 'Yes',
  'drop-ds': 'Yes',
  'hang-df': 'No',
  'hang-ds': 'Yes',
};
const PUBLISHED = {
  chromium: FAST,
  chromiumclose: FAST,
  node: FAST,
  python: { ...FAST, 'drop-df': SLOW },
  go: { ...FAST, 'drop-df': SLOW },
  collector: { ...FAST, 'drop-df': SLOW },
};

const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-07-'));
const secondLocation = NEGATIVE ? 'dead' : 'live';
const composeEnv = { ...process.env, CHECK_SCRATCH: scratch, CHECK_B_ROLE: secondLocation };

function docker(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: composeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`docker ${args.slice(0, 8).join(' ')} failed:\n${stderr}${stdout}`));
    });
  });
}

function readJsonl(name) {
  const file = path.join(scratch, name);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

async function execForResult(service, command, input) {
  const args = [...COMPOSE, 'exec', '-T', service, ...command, JSON.stringify(input)];
  const { stdout } = await docker(args);
  const line = stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) throw new Error(`${service} printed no result:\n${stdout}`);
  return JSON.parse(line.slice('RESULT '.length));
}

function runBrowser(client, testCase, hosts) {
  const input = {
    hosts,
    port: testCase.port,
    windowMs: WINDOW_MS,
    staggerMs: STAGGER_MS.browser,
    close: client.id === 'chromiumclose',
    chromium: client.address,
  };
  return execForResult('client-node', ['node', '/check/browser.mjs'], input);
}

const RECEIVER_PORT = 5000;
const WARM_UP_RECEIVER_PORT = 4999;

/** One pipeline per repetition: its own receiver, its own otlphttp exporter. */
function collectorConfig(testCase, hosts) {
  const receivers = {};
  const exporters = {};
  const pipelines = {};
  const add = (name, receiverPort, endpoint) => {
    receivers[`otlp/${name}`] = { protocols: { http: { endpoint: `0.0.0.0:${receiverPort}` } } };
    // Timeout, retry and queue settings are the exporter's defaults.
    exporters[`otlphttp/${name}`] = { endpoint };
    pipelines[`metrics/${name}`] = { receivers: [`otlp/${name}`], exporters: [`otlphttp/${name}`] };
  };
  add('warmup', WARM_UP_RECEIVER_PORT, `http://collector-${testCase.id}-warm.ds.ingest.test:4020`);
  hosts.forEach((host, index) => {
    add(index, RECEIVER_PORT + index, `http://${host}:${testCase.port}`);
  });
  const telemetry = { metrics: { level: 'none' } };
  return { receivers, exporters, service: { telemetry, pipelines } };
}

async function waitForArrivals(hosts, port, deadline) {
  const wanted = new Set(hosts.map((host) => `${host}:${port}`));
  while (Date.now() < deadline) {
    for (const name of ['endpoint-a.jsonl', 'endpoint-b.jsonl']) {
      for (const record of readJsonl(name)) if (record.k === 'req') wanted.delete(record.host);
    }
    if (wanted.size === 0) return;
    await sleep(1000);
  }
}

async function runCollector(_client, testCase, hosts) {
  // JSON is YAML, so the collector reads this file as its configuration.
  const config = JSON.stringify(collectorConfig(testCase, hosts), null, 1);
  writeFileSync(path.join(scratch, 'collector-active.yaml'), config);
  const profile = [...COMPOSE, '--profile', 'collector'];
  await docker([...profile, 'up', '-d', '--force-recreate', 'collector']);
  const { rounds } = await execForResult('client-node', ['node', '/check/collector-send.mjs'], {
    warmUpPort: WARM_UP_RECEIVER_PORT,
    ports: hosts.map((_, index) => RECEIVER_PORT + index),
    staggerMs: STAGGER_MS.sdk,
  });
  await waitForArrivals(hosts, testCase.port, Date.now() + WINDOW_MS);
  const logs = await docker([...profile, 'logs', '--no-color', '--no-log-prefix', 'collector']);
  const text = logs.stdout + logs.stderr;
  writeFileSync(path.join(scratch, `collector-${testCase.id}.log`), text);
  await docker([...profile, 'rm', '-sf', 'collector']);
  const failures = text.split('\n').filter((line) => line.includes('Exporting failed'));
  const retried = failures.filter((line) => line.includes('Will retry')).length;
  const sample = /"error": ?"((?:[^"\\]|\\.){0,170})/.exec(failures[0] || '')?.[1] || '';
  const note = failures.length
    ? `${failures.length} "Exporting failed" log lines, ${retried} announcing a retry: ` +
      sample.replace(/collector-[a-z]+-d[fs]-\d\d\./g, '<rep>.').replaceAll('\\"', '"')
    : 'no export failure logged';
  const outcome = 'accepted by the collector';
  const reps = hosts.map((host, index) => ({ host, t0: rounds[0][index], outcome }));
  return { reps, note };
}

const RUNNERS = {
  chromium: runBrowser,
  chromiumclose: runBrowser,
  node: (_c, testCase, hosts) =>
    runSdk('client-node', ['node', '/sdk/export.mjs'], testCase, hosts),
  python: (_c, testCase, hosts) =>
    runSdk('client-python', ['python', '/sdk/export.py'], testCase, hosts),
  go: (_c, testCase, hosts) => runSdk('client-go', ['export'], testCase, hosts),
  collector: runCollector,
};

function runSdk(service, command, testCase, hosts) {
  const input = { hosts, port: testCase.port, staggerMs: STAGGER_MS.sdk };
  return execForResult(service, command, input);
}

/** One client runs its cases one after another; clients run side by side. */
async function runLane(client) {
  const runs = [];
  // The first case of a process pays for start-up; it is run and not reported. The
  // collector is a new process in every case and warms up inside each one.
  const cases = client.id === 'collector' ? CASES : [WARM_UP, ...CASES];
  for (const testCase of cases) {
    const hosts = Array.from({ length: REPS }, (_, index) => {
      const number = String(index).padStart(2, '0');
      return `${client.id}-${testCase.id}-${number}.${testCase.order}.ingest.test`;
    });
    const start = Date.now();
    const result = await RUNNERS[client.id](client, testCase, hosts);
    if (testCase === WARM_UP) continue;
    runs.push({ client: client.id, case: testCase.id, ...result });
    console.log(`  ${client.id} ${testCase.id}: ${((Date.now() - start) / 1000).toFixed(1)} s`);
  }
  return runs;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Connection attempts and SYN packets (retransmissions included) from one client in one case. */
function connections(records, client, testCase) {
  const mine = records.filter(
    (record) =>
      record.k === 'syn' && record.src === client.address && record.dport === testCase.port,
  );
  return { count: new Set(mine.map((record) => record.connection)).size, syns: mine.length };
}

function firstArrivals(records, port) {
  const arrivals = new Map();
  for (const record of records) {
    if (record.k !== 'req' || record.method !== 'POST' || record.port !== port) continue;
    if (!arrivals.has(record.host)) arrivals.set(record.host, record.t);
  }
  return arrivals;
}

/** What the client itself reported, grouped, with the median time errors took. */
function clientOutcome(run) {
  const groups = new Map();
  for (const rep of run.reps) {
    // Host names differ per repetition; the rest of an error message does not.
    const error = (rep.error || '').replace(/[a-z]+-[a-z]+-d[fs]-\d\d\./g, '<rep>.');
    const key = rep.outcome + (error ? `: ${error.slice(0, 170)}` : '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rep.elapsedMs);
  }
  const parts = [...groups].sort((left, right) => right[1].length - left[1].length).slice(0, 2);
  const text = parts
    .map(([key, elapsed]) => {
      const seconds = (median(elapsed) / 1000).toFixed(1);
      const after = key.startsWith('error') ? ` after ${seconds} s` : '';
      return `${elapsed.length} ${key.replace(/^error/, `error${after}`)}`;
    })
    .join(' / ');
  return run.note ? `${text} (${run.note})` : text;
}

function verdictOf(row, budgetMs) {
  if (row.delivered < REPS) return 'No';
  return row.worst <= budgetMs ? 'Yes' : SLOW;
}

function analyse(run, logs) {
  const client = CLIENTS.find((candidate) => candidate.id === run.client);
  const testCase = CASES.find((candidate) => candidate.id === run.case);
  const atLive = firstArrivals(logs.live, testCase.port);
  const atFailing = firstArrivals(logs.failing, testCase.port);
  const times = [];
  let viaFailing = 0;
  for (const rep of run.reps) {
    const key = `${rep.host}:${testCase.port}`;
    const arrival = atLive.get(key) ?? atFailing.get(key);
    if (arrival === undefined || rep.t0 === undefined) continue;
    if (!atLive.has(key)) viaFailing++;
    times.push(Math.max(0, arrival - rep.t0));
  }
  const names = new Set(run.reps.map((rep) => rep.host));
  const queries = logs.dns.filter((record) => record.type === 1 && names.has(record.name));
  const row = {
    client: client.id,
    case: testCase.id,
    delivered: times.length,
    viaFailing,
    median: times.length ? median(times) : null,
    worst: times.length ? Math.max(...times) : null,
    toFailing: connections(logs.failing, client, testCase),
    toLive: connections(logs.live, client, testCase),
    dnsQueries: queries.length,
    outcome: clientOutcome(run),
  };
  return { ...row, verdict: verdictOf(row, client.budgetMs) };
}

function printTable(client, rows) {
  console.log(`\n### ${client.label} (${client.address})\n`);
  console.log(
    '| Case | Delivered | Median ms | Worst ms | Connections to failing (SYN packets) ' +
      '| Connections to live | DNS A queries | What the client reported | Verdict |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const delivered =
      row.viaFailing > 0
        ? `${row.delivered}/${REPS} (${row.viaFailing} at the failing address)`
        : `${row.delivered}/${REPS}`;
    const cells = [
      row.case,
      delivered,
      row.median ?? '-',
      row.worst ?? '-',
      `${row.toFailing.count} (${row.toFailing.syns})`,
      row.toLive.count,
      row.dnsQueries,
      row.outcome.replaceAll('|', '/'),
      row.case.startsWith('control') || row.case.startsWith('bothdead') ? '-' : row.verdict,
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}

/** Problems that make the run fail: a broken control or a verdict that moved. */
function findProblems(rows) {
  const problems = [];
  for (const row of rows) {
    const name = `${row.client} ${row.case}`;
    if (row.case.startsWith('control')) {
      const text = `${name}: control delivered ${row.delivered}/${REPS}`;
      if (row.delivered !== REPS) problems.push(text);
    } else if (row.case.startsWith('bothdead')) {
      if (row.delivered !== 0) problems.push(`${name}: ${row.delivered} delivered with both dead`);
    } else {
      const published = PUBLISHED[row.client]?.[row.case];
      if (row.verdict !== published) {
        problems.push(`${name}: verdict "${row.verdict}", published "${published}"`);
      }
    }
  }
  return problems;
}

/** The cases in which every request starts without a connection. */
async function runNewConnection() {
  console.log('\nRunning (time per client and case):');
  const runs = (await Promise.all(CLIENTS.map(runLane))).flat();
  writeFileSync(path.join(scratch, 'runs.json'), JSON.stringify(runs, null, 1));

  const logs = {
    failing: readJsonl('endpoint-a.jsonl'),
    live: readJsonl('endpoint-b.jsonl'),
    dns: readJsonl('dns.jsonl'),
  };
  const rows = runs.map((run) => analyse(run, logs));
  writeFileSync(path.join(scratch, 'rows.json'), JSON.stringify(rows, null, 1));
  const product = runs.find((run) => run.product)?.product;
  console.log(`\n## Results (${product}; ${REPS} repetitions; window ${WINDOW_MS / 1000} s)`);
  for (const client of CLIENTS) {
    printTable(client, rows.filter((row) => row.client === client.id));
  }

  return findProblems(rows);
}

async function main() {
  console.log(`scratch: ${scratch}`);
  console.log(`repetitions: ${REPS}, observation window: ${WINDOW_MS / 1000} s`);
  if (NEGATIVE) console.log('CHECK_NEGATIVE=1: the second location is dead; this run must fail.');
  await docker([...COMPOSE, 'up', '-d', '--build', '--wait']);

  console.log('\nFixtures:');
  const probeArgs = ['exec', '-T', 'dns', 'node', '/app/probe.mjs'];
  const probe = await docker([...COMPOSE, ...probeArgs, NEGATIVE ? 'dead' : 'live'], {
    allowFailure: true,
  });
  process.stdout.write(probe.stdout);
  if (probe.code !== 0) {
    throw new Error(`the fixtures are not as the cases assume\n${probe.stderr}`);
  }

  const problems = [];
  if (PART !== 'open') problems.push(...(await runNewConnection()));
  if (PART !== 'new') {
    const kit = {
      CLIENTS, COMPOSE, REPS, RECEIVER_PORT, WARM_UP_RECEIVER_PORT, scratch,
      collectorConfig, connections, docker, execForResult, median, readJsonl,
    };
    problems.push(...(await runOpenConnection(kit)));
  }
  console.log('\n## Verdict\n');
  if (problems.length === 0) {
    console.log('Controls pass and every verdict equals the published one.');
    return 0;
  }
  console.log(`FAILED: ${problems.length} difference(s) from the published result.`);
  for (const problem of problems) console.log(`  - ${problem}`);
  return 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
} finally {
  if (process.env.CHECK_KEEP_STACK === '1') {
    console.log('\nCHECK_KEEP_STACK=1: stack left up (docker compose -p us-check-07 down -v).');
  } else {
    await docker([...COMPOSE, '--profile', 'collector', 'down', '-v'], { allowFailure: true });
  }
}
process.exit(exitCode);
