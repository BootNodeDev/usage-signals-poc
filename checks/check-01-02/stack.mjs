// The round-two stack and the few Umami calls every part of the experiment needs.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const COMPOSE_FILE = path.join(import.meta.dirname, 'compose.round2.yml');
const COMPOSE = ['compose', '-p', 'us-check-01-r2', '-f', COMPOSE_FILE];

export function docker(args, options = {}) {
  return execFileSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
}

export function startStack() {
  docker(['up', '-d', '--wait'], { stdio: ['ignore', 'ignore', 'inherit'] });
}

export function removeStack() {
  docker(['down', '-v'], { stdio: 'ignore' });
}

// Docker assigns the host ports, so that parallel stacks on this machine cannot collide.
export function serviceUrl(service) {
  return `http://${docker(['port', service, '3000']).trim()}`;
}

export function psql(sql) {
  const args = ['exec', '-T', 'postgres', 'psql', '-U', 'check', '-d', 'check', '-At', '-F', '|'];
  return docker([...args, '-c', sql]).trim();
}

// Sets the wall clock of the `umami-clock` service to an exact second.
export function setDirectClock(epochSeconds) {
  const text = new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  docker(['exec', '-T', 'umami-clock', 'sh', '-c', `echo "${text}" > /clock/now`]);
}

export async function post(base, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function login(base, username = 'admin', password = 'umami') {
  const { status, body } = await post(base, '/api/auth/login', { username, password });
  if (status !== 200) {
    throw new Error(`Umami login at ${base} answered ${status}. Is the Umami at that URL up?`);
  }
  return { authorization: `Bearer ${body.token}` };
}

export async function createWebsite(base, auth, name, id = randomUUID()) {
  const { status } = await post(base, '/api/websites', { id, name, domain: 'check.test' }, auth);
  if (status !== 200) throw new Error(`Umami refused to create website "${name}" (HTTP ${status}).`);
  return id;
}

export async function deleteWebsite(base, auth, id) {
  const response = await fetch(`${base}/api/websites/${id}`, { method: 'DELETE', headers: auth });
  if (!response.ok) throw new Error(`Umami refused to delete website ${id} (HTTP ${response.status}).`);
}

export async function deleteSession(base, auth, website, session) {
  const url = `${base}/api/websites/${website}/sessions/${session}`;
  const response = await fetch(url, { method: 'DELETE', headers: auth });
  if (!response.ok) throw new Error(`Umami refused to delete session ${session} (HTTP ${response.status}).`);
}

async function getJson(base, auth, pathAndQuery) {
  const response = await fetch(`${base}${pathAndQuery}`, { headers: auth });
  if (!response.ok) throw new Error(`Umami answered ${response.status} to ${pathAndQuery}.`);
  return response.json();
}

function sortedPairs(rows) {
  return rows.map((row) => `${row.x}=${row.y}`).sort().join(', ') || '(none)';
}

// The seven metrics of the RFP, plus the counts they are derived from, read through the API.
export async function metrics(base, auth, website, range) {
  const query = `startAt=${range.startAt}&endAt=${range.endAt}`;
  const stats = await getJson(base, auth, `/api/websites/${website}/stats?${query}`);
  const breakdown = async (type) =>
    sortedPairs(await getJson(base, auth, `/api/websites/${website}/metrics?${query}&type=${type}`));
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

// Page views Umami holds for one site between two instants (milliseconds), through the API.
export async function pageViewsHeld(base, auth, website, startAt, endAt) {
  const query = `startAt=${startAt}&endAt=${endAt}`;
  const stats = await getJson(base, auth, `/api/websites/${website}/stats?${query}`);
  return Number(stats.pageviews);
}

// Which page views share a visit: one line per visit, the paths in time order.
export function visitPartition(website) {
  return psql(
    `SELECT string_agg(url_path, ' ' ORDER BY created_at, url_path) FROM website_event ` +
      `WHERE website_id = '${website}' GROUP BY session_id, visit_id ORDER BY 1`,
  );
}

export function printComparison(title, left, right, leftName, rightName) {
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
