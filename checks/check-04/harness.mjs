// Shared plumbing of round two: the isolated stack, the HTTP client, the read-only database
// connection and the result table. Node built-ins only.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT = 'us-check-04-r2';
const COMPOSE = ['compose', '-p', PROJECT, '-f', join(HERE, 'docker-compose.r2.yml')];

export const rows = [];
let baseUrl = null;

export function record(group, what, route, who, got, expected) {
  const pass = got === expected;
  rows.push({ group, what, route, who, got, expected, pass });
  return pass;
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Starts the stack on a host port chosen by Docker and returns Umami's address. */
export function startStack() {
  stopStack();
  docker([...COMPOSE, 'up', '-d', '--wait']);
  baseUrl = `http://${docker([...COMPOSE, 'port', 'umami', '3000']).trim()}`;
  return baseUrl;
}

/** Removes this project's containers, network and volume, and nothing else. */
export function stopStack() {
  docker([...COMPOSE, 'down', '-v']);
}

/** One read-only SQL statement; PostgreSQL itself rejects any write on this connection. */
export function readDb(sql) {
  const args = [...COMPOSE, 'exec', '-T', '-e', 'PGOPTIONS=-c default_transaction_read_only=on'];
  return docker([...args, 'postgres', 'psql', '-U', 'poc', '-d', 'poc', '-At', '-c', sql]).trim();
}

export async function call(method, path, credential, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(credential && { authorization: `Bearer ${credential}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies (an empty 500, an HTML 404) carry nothing this check reads.
  }
  return { status: response.status, json, text };
}

/** Calls Umami and records the status as one row. */
export async function step(group, what, method, path, who, credential, body, expected = 200) {
  const result = await call(method, path, credential, body);
  record(group, what, `${method} ${path.split('?')[0]}`, who, result.status, expected);
  return result;
}

/** A call the check itself depends on. It is not evidence, so it is not a row; it must succeed. */
export async function must(method, path, credential, body) {
  const result = await call(method, path, credential, body);
  if (result.status !== 200) {
    throw new Error(`setup call ${method} ${path.split('?')[0]} answered ${result.status}: ${result.text.slice(0, 200)}`);
  }
  return result.json;
}

export function rangeQuery(extra = '') {
  const now = Date.now();
  const range = `startAt=${now - 86_400_000}&endAt=${now + 3_600_000}&unit=hour&timezone=UTC`;
  return extra ? `${range}&${extra}` : range;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Three events from one visitor: two page views and one named event with a property. */
export async function sendEvents(websiteId, hostname) {
  const events = [{ url: '/' }, { url: '/pricing' }, { url: '/signup', name: 'signup', data: { plan: 'pro' } }];
  for (const event of events) {
    const payload = { website: websiteId, hostname, language: 'en', screen: '1280x720', title: 'page', ...event };
    const response = await fetch(`${baseUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
      body: JSON.stringify({ type: 'event', payload }),
    });
    if (!response.ok) throw new Error(`Umami refused a test event (HTTP ${response.status})`);
  }
}

export function printTable() {
  console.log('\n| # | group | what | route | caller | got | expected | ok |');
  console.log('|---|---|---|---|---|---|---|---|');
  rows.forEach((row, index) => {
    const cells = [index + 1, row.group, row.what, `\`${row.route}\``, row.who, row.got, row.expected, row.pass ? 'pass' : 'FAIL'];
    console.log(`| ${cells.join(' | ')} |`);
  });
}
