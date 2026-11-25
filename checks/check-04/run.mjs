#!/usr/bin/env node
// Check 04: "Umami teams, service users and keys can be provisioned through an admin session,
// without touching its database." Starts an isolated Umami 3.5.0, provisions two tenants through
// the HTTP API only, probes the boundary, revokes, removes, prints a table and a verdict.
// Node built-ins only. The database is only ever read, on a connection forced read-only.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_ROUTES } from './read-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = ['compose', '-p', 'us-check-04', '-f', join(HERE, 'docker-compose.yml')];
const UMAMI = 'http://127.0.0.1:33104';
const ADMIN = { username: 'admin', password: 'umami' }; // Umami's seeded local default
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const OK = 200;
const REFUSED = 401; // Umami answers 401, not 403, when a known caller lacks permission
const NOT_FOUND = 404;

const rows = [];

function record(group, what, route, who, got, expected) {
  const pass = got === expected;
  rows.push({ group, what, route, who, got, expected, pass });
  return pass;
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/** One read-only SQL statement; PostgreSQL itself rejects any write on this connection. */
function readDb(sql) {
  const args = [...COMPOSE, 'exec', '-T', '-e', 'PGOPTIONS=-c default_transaction_read_only=on'];
  return docker([...args, 'postgres', 'psql', '-U', 'poc', '-d', 'poc', '-At', '-c', sql]).trim();
}

async function call(method, path, credential, body) {
  const response = await fetch(`${UMAMI}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(credential && { authorization: `Bearer ${credential}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies (an empty 405, an HTML 404) carry nothing this check reads.
  }
  return { status: response.status, json, text };
}

async function step(group, what, method, path, who, credential, body, expected = OK) {
  const result = await call(method, path, credential, body);
  const pass = record(group, what, `${method} ${path.split('?')[0]}`, who, result.status, expected);
  if (!pass && group === '1 provision') {
    throw new Error(`provisioning step failed: ${what} answered ${result.status} ${result.text.slice(0, 200)}`);
  }
  return result;
}

async function sendEvents(websiteId, hostname) {
  const events = [{ url: '/' }, { url: '/pricing' }, { url: '/signup', name: 'signup', data: { plan: 'pro' } }];
  for (const event of events) {
    const payload = { website: websiteId, hostname, language: 'en', screen: '1280x720', title: 'page', ...event };
    const response = await fetch(`${UMAMI}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': BROWSER_UA },
      body: JSON.stringify({ type: 'event', payload }),
    });
    if (!response.ok) throw new Error(`Umami refused a test event (HTTP ${response.status})`);
  }
}

/** Team, view-only service user, membership, team website, then the user's own login and key. */
async function provisionTenant(admin, label) {
  const group = '1 provision';
  const slug = `tenant-${label.toLowerCase()}`;
  const password = randomBytes(24).toString('base64url');
  const tenant = { label, slug, hostname: `${slug}.example`, username: `svc-${slug}`, password };

  const team = await step(group, `${label}: create team`, 'POST', '/api/teams', 'admin', admin, { name: slug });
  tenant.teamId = team.json[0].id;
  tenant.accessCode = team.json[0].accessCode;

  const user = await step(group, `${label}: create service user, global role view-only`, 'POST', '/api/users', 'admin', admin, {
    username: tenant.username,
    password,
    role: 'view-only',
  });
  tenant.userId = user.json.id;

  await step(group, `${label}: add user to team as team-view-only`, 'POST', `/api/teams/${tenant.teamId}/users`, 'admin', admin, {
    userId: tenant.userId,
    role: 'team-view-only',
  });

  const website = await step(group, `${label}: create website owned by the team`, 'POST', '/api/websites', 'admin', admin, {
    name: slug,
    domain: tenant.hostname,
    teamId: tenant.teamId,
  });
  tenant.websiteId = website.json.id;

  const login = await step(group, `${label}: log in as the service user`, 'POST', '/api/auth/login', 'service user password', null, {
    username: tenant.username,
    password,
  });
  tenant.session = login.json.token;

  const key = await step(group, `${label}: service user creates its own API key`, 'POST', '/api/me/api-keys', `${label} session`, tenant.session, {
    name: 'console-read',
  });
  tenant.key = key.json.key;
  tenant.keyId = key.json.id;
  return tenant;
}

function rangeQuery(extra) {
  const now = Date.now();
  const range = `startAt=${now - 86_400_000}&endAt=${now + 3_600_000}&unit=hour&timezone=UTC`;
  return extra ? `${range}&${extra}` : range;
}

async function probeReads(a, b) {
  for (const [route, extra] of READ_ROUTES) {
    const query = rangeQuery(extra);
    const pathFor = id => `/api/websites/${id}${route}?${query}`;
    const shown = `GET /api/websites/:id${route}`;
    const own = await call('GET', pathFor(a.websiteId), a.key);
    record('2a own data', 'A key reads A', shown, 'A key', own.status, OK);
    const otherOwn = await call('GET', pathFor(b.websiteId), b.key);
    record('2a own data', 'B key reads B', shown, 'B key', otherOwn.status, OK);
    const cross = await call('GET', pathFor(b.websiteId), a.key);
    record('2b cross-tenant read', 'A key reads B', shown, 'A key', cross.status, REFUSED);
    const back = await call('GET', pathFor(a.websiteId), b.key);
    record('2b cross-tenant read', 'B key reads A', shown, 'B key', back.status, REFUSED);
  }
  await step('2a own data', 'A key reads A realtime', 'GET', `/api/realtime/${a.websiteId}`, 'A key', a.key);
  await step('2b cross-tenant read', 'A key reads B realtime', 'GET', `/api/realtime/${b.websiteId}`, 'A key', a.key, undefined, REFUSED);
  // Public by design: the tracker fetches it. It returns the session-replay settings, no statistics.
  const recorder = await step('2f public by design', 'recorder settings of B, no credential', 'GET', `/api/websites/${b.websiteId}/recorder`, 'nobody', null);
  record('2f public by design', 'recorder body carries settings only', 'response body', 'nobody', JSON.stringify(recorder.json), '{"enabled":false}');
}

/** A row id of tenant B must not open through tenant B's website, nor through tenant A's. */
async function probeRowIds(a, b) {
  const group = '2b cross-tenant read';
  const sessions = await call('GET', `/api/websites/${b.websiteId}/sessions?${rangeQuery('')}`, b.key);
  const sessionId = sessions.json?.data?.[0]?.id;
  record(group, 'B key finds a session id of B', 'GET /api/websites/:id/sessions', 'B key', sessionId ? OK : 0, OK);
  for (const tail of ['', '/activity', '/properties', '/replays']) {
    const suffix = `/sessions/${sessionId}${tail}?${rangeQuery('')}`;
    const shown = `GET /api/websites/:id/sessions/:sessionId${tail}`;
    await step('2a own data', 'B key opens its session', 'GET', `/api/websites/${b.websiteId}${suffix}`, 'B key', b.key);
    const viaB = await call('GET', `/api/websites/${b.websiteId}${suffix}`, a.key);
    record(group, 'A key, B website, B session id', shown, 'A key', viaB.status, REFUSED);
    const viaA = await call('GET', `/api/websites/${a.websiteId}${suffix}`, a.key);
    const leaked = viaA.text.includes(b.hostname) || viaA.text.includes(b.websiteId);
    const list = viaA.json?.data ?? viaA.json;
    const empty = !viaA.json || (Array.isArray(list) && list.length === 0);
    const verdict = leaked ? 'leak' : viaA.status === NOT_FOUND || empty ? 'no B data' : 'unexpected';
    record(group, 'A key, A website, B session id', shown, 'A key', `${viaA.status} ${verdict}`, `${viaA.status} no B data`);
  }
}

async function probeLists(a, b) {
  const group = '2c lists';
  const expectOnly = async (what, path, wanted, unwanted) => {
    const result = await call('GET', path, a.key);
    const clean = result.status === OK && result.text.includes(wanted) && !result.text.includes(unwanted);
    record(group, what, `GET ${path.split('?')[0]}`, 'A key', clean ? 'only A' : `${result.status} wrong`, 'only A');
  };
  await expectOnly('websites, team access included', '/api/websites?includeTeams=1', a.websiteId, b.websiteId);
  await expectOnly('my websites, team access included', '/api/me/websites?includeTeams=1', a.websiteId, b.websiteId);
  await expectOnly('my teams', '/api/me/teams', a.teamId, b.teamId);
  await expectOnly('teams', '/api/teams', a.teamId, b.teamId);
  await expectOnly('own team websites', `/api/teams/${a.teamId}/websites`, a.websiteId, b.websiteId);

  const ownTeam = await call('GET', `/api/teams/${a.teamId}`, a.key);
  const hidden = ownTeam.status === OK && !ownTeam.text.includes(a.accessCode);
  record(group, 'own team: join code withheld', 'GET /api/teams/:id', 'A key', hidden ? 'withheld' : 'shown', 'withheld');

  const refused = [
    ['team B', `/api/teams/${b.teamId}`],
    ['team B members', `/api/teams/${b.teamId}/users`],
    ['team B websites', `/api/teams/${b.teamId}/websites`],
    ['all websites (admin route)', '/api/admin/websites'],
    ['all teams (admin route)', '/api/admin/teams'],
    ['all users (admin route)', '/api/admin/users'],
    ['user B', `/api/users/${b.userId}`],
    ['user B websites', `/api/users/${b.userId}/websites`],
    ['own key list, with the key itself', '/api/me/api-keys'],
  ];
  for (const [what, path] of refused) {
    await step(group, what, 'GET', path, 'A key', a.key, undefined, REFUSED);
  }
}

async function probeWrites(admin, a, b) {
  const group = '2d writes';
  const site = name => ({ name, domain: 'intruder.example' });
  const annotation = { date: new Date().toISOString(), note: 'check-04' };
  const segment = { type: 'segment', name: 'check-04', parameters: { filters: [] } };
  const share = { name: 'check-04', parameters: {} };
  // Bodies are first accepted from the admin, so a later 401 is a refusal and not a malformed body.
  const control = await step(group, 'control: admin creates a second website in team A', 'POST', '/api/websites', 'admin', admin, {
    ...site('control'),
    teamId: a.teamId,
  });
  const controlId = control.json.id;
  for (const [what, tail, body] of [
    ['annotation', '/annotations', annotation],
    ['segment', '/segments', segment],
    ['share link', '/shares', share],
  ]) {
    await step(group, `control: admin creates ${what}`, 'POST', `/api/websites/${controlId}${tail}`, 'admin', admin, body);
    await step(group, `create ${what} on own website`, 'POST', `/api/websites/${a.websiteId}${tail}`, 'A key', a.key, body, REFUSED);
    await step(group, `create ${what} on B website`, 'POST', `/api/websites/${b.websiteId}${tail}`, 'A key', a.key, body, REFUSED);
  }
  const attempts = [
    ['create personal website', 'POST', '/api/websites', site('own')],
    ['create website in own team', 'POST', '/api/websites', { ...site('team'), teamId: a.teamId }],
    ['create website in team B', 'POST', '/api/websites', { ...site('other'), teamId: b.teamId }],
    ['rename own website', 'POST', `/api/websites/${a.websiteId}`, { name: 'renamed' }],
    ['rename B website', 'POST', `/api/websites/${b.websiteId}`, { name: 'renamed' }],
    ['reset own website data', 'POST', `/api/websites/${a.websiteId}/reset`, undefined],
    ['reset B website data', 'POST', `/api/websites/${b.websiteId}/reset`, undefined],
    ['move B website into own team', 'POST', `/api/websites/${b.websiteId}/transfer`, { teamId: a.teamId }],
    ['take own website out of the team', 'POST', `/api/websites/${a.websiteId}/transfer`, { userId: a.userId }],
    ['delete own website', 'DELETE', `/api/websites/${a.websiteId}`, undefined],
    ['delete B website', 'DELETE', `/api/websites/${b.websiteId}`, undefined],
    ['share B website (generic route)', 'POST', '/api/share', { entityId: b.websiteId, shareType: 1, ...share }],
    ['create team', 'POST', '/api/teams', { name: 'intruder' }],
    ['rename own team', 'POST', `/api/teams/${a.teamId}`, { name: 'renamed' }],
    ['rename team B', 'POST', `/api/teams/${b.teamId}`, { name: 'renamed' }],
    ['raise own team role', 'POST', `/api/teams/${a.teamId}/users/${a.userId}`, { role: 'team-manager' }],
    ['add self to team B', 'POST', `/api/teams/${b.teamId}/users`, { userId: a.userId, role: 'team-view-only' }],
    ['delete own team', 'DELETE', `/api/teams/${a.teamId}`, undefined],
    ['delete team B', 'DELETE', `/api/teams/${b.teamId}`, undefined],
    ['create another key with the key', 'POST', '/api/me/api-keys', { name: 'second' }],
    ['delete own key with the key', 'DELETE', `/api/me/api-keys/${a.keyId}`, undefined],
    ['change own password with the key', 'POST', '/api/me/password', { currentPassword: a.password, newPassword: `${a.password}x` }],
    ['create a user', 'POST', '/api/users', { username: 'intruder', password: a.password, role: 'admin' }],
    ['make self admin', 'POST', `/api/users/${a.userId}`, { role: 'admin' }],
    ['delete user B', 'DELETE', `/api/users/${b.userId}`, undefined],
  ];
  for (const [what, method, path, body] of attempts) {
    await step(group, what, method, path, 'A key', a.key, body, REFUSED);
  }
  await step(group, 'join a team with a wrong join code', 'POST', '/api/teams/join', 'A key', a.key, { accessCode: 'team_wrongwrongwrong' }, NOT_FOUND);
  await step(group, 'no credential at all', 'GET', `/api/websites/${a.websiteId}/stats?${rangeQuery('')}`, 'nobody', null, undefined, REFUSED);
}

/** Two deliberate leaks, to show the probes can fail and to pin the two settings that matter. */
async function plantLeaks(admin, a, b) {
  const group = '2e planted leaks';
  const password = randomBytes(24).toString('base64url');
  const username = 'svc-wrong-global-role';
  const user = await step(group, 'control: service user created with global role user', 'POST', '/api/users', 'admin', admin, { username, password, role: 'user' });
  await step(group, 'control: same team-view-only membership in A', 'POST', `/api/teams/${a.teamId}/users`, 'admin', admin, { userId: user.json.id, role: 'team-view-only' });
  const login = await call('POST', '/api/auth/login', null, { username, password });
  const key = (await call('POST', '/api/me/api-keys', login.json.token, { name: 'leak' })).json.key;
  await step(group, 'LEAK global role user: creates its own website', 'POST', '/api/websites', 'wrong-role key', key, { name: 'own', domain: 'own.example' });
  await step(group, 'LEAK global role user: creates its own team', 'POST', '/api/teams', 'wrong-role key', key, { name: 'own' });
  await step(group, 'before the join code: cannot read B', 'GET', `/api/websites/${b.websiteId}/stats?${rangeQuery('')}`, 'wrong-role key', key, undefined, REFUSED);
  await step(group, 'LEAK join code of B: any key joins team B', 'POST', '/api/teams/join', 'wrong-role key', key, { accessCode: b.accessCode });
  await step(group, 'LEAK after joining: reads B', 'GET', `/api/websites/${b.websiteId}/stats?${rangeQuery('')}`, 'wrong-role key', key);
  await step(group, 'cleanup: admin deletes the control user', 'DELETE', `/api/users/${user.json.id}`, 'admin', admin);
}

async function probeAdminCannotMintKeys(admin, a) {
  const group = '1b key ownership';
  const before = readDb(`select count(*) from api_key where user_id = '${a.userId}'`);
  await step(group, 'no admin route creates a key for another user', 'POST', `/api/users/${a.userId}/api-keys`, 'admin', admin, { name: 'for-a' }, NOT_FOUND);
  const own = await step(group, 'admin on the key route gets a key for itself', 'POST', '/api/me/api-keys', 'admin', admin, { name: 'admin-own' });
  const owner = readDb(`select u.username from api_key k join "user" u on u.user_id = k.user_id where k.api_key_id = '${own.json.id}'`);
  record(group, 'owner of that key (database, read-only)', 'api_key.user_id', 'read-only SQL', owner, 'admin');
  const after = readDb(`select count(*) from api_key where user_id = '${a.userId}'`);
  record(group, 'keys of service user A unchanged (database, read-only)', 'api_key', 'read-only SQL', after, before);
  await step(group, 'cleanup: admin deletes its own key', 'DELETE', `/api/me/api-keys/${own.json.id}`, 'admin', admin);
  await step(group, 'admin cannot delete the key of user A', 'DELETE', `/api/me/api-keys/${a.keyId}`, 'admin', admin, undefined, NOT_FOUND);
}

function verifyStored(a) {
  const group = '6 stored by Umami';
  const sql = `select u.role || ',' || tu.role || ',' || (w.user_id is null) || ',' || length(k.key_hash) || ',' || k.key_prefix
    from "user" u join team_user tu on tu.user_id = u.user_id join website w on w.team_id = tu.team_id
    join api_key k on k.user_id = u.user_id where u.user_id = '${a.userId}' and w.website_id = '${a.websiteId}'`;
  const expected = `view-only,team-view-only,true,128,${a.key.slice(0, 14)}`;
  const got = readDb(sql);
  const mask = value => value.replace(/umami_.*/, 'umami_********');
  record(group, 'roles, team ownership, key stored as a hash', 'user, team_user, website, api_key', 'read-only SQL', mask(got), mask(expected));
  if (got !== expected) rows.at(-1).pass = false;
  let refusedWrite = false;
  try {
    readDb('create table check_04_must_not_exist (id int)');
  } catch {
    refusedWrite = true;
  }
  record(group, 'the connection this script uses refuses writes', 'CREATE TABLE', 'read-only SQL', refusedWrite ? 'refused' : 'accepted', 'refused');
}

async function revoke(admin, a) {
  const group = '3 revocation';
  const stats = `/api/websites/${a.websiteId}/stats?${rangeQuery('')}`;
  // Rotation with the admin credential alone: no service user password has to be kept.
  const password = randomBytes(24).toString('base64url');
  await step(group, 'admin sets a new password on the service user', 'POST', `/api/users/${a.userId}`, 'admin', admin, { password });
  await step(group, 'old session token after the password change', 'GET', '/api/me', 'A old session', a.session, undefined, REFUSED);
  await step(group, 'API key after the password change (not revoked by it)', 'GET', stats, 'A key', a.key);
  const login = await step(group, 'log in with the new password', 'POST', '/api/auth/login', 'service user password', null, { username: a.username, password });
  const session = login.json.token;
  const second = await step(group, 'create the replacement key', 'POST', '/api/me/api-keys', 'A session', session, { name: 'console-read-2' });
  await step(group, 'delete the first key', 'DELETE', `/api/me/api-keys/${a.keyId}`, 'A session', session);
  const started = performance.now();
  await step(group, 'first key, next request', 'GET', stats, 'A revoked key', a.key, undefined, REFUSED);
  const elapsed = Math.round(performance.now() - started);
  await step(group, 'replacement key', 'GET', stats, 'A key 2', second.json.key);

  await step(group, 'admin removes the user from the team', 'DELETE', `/api/teams/${a.teamId}/users/${a.userId}`, 'admin', admin);
  await step(group, 'key still identifies the user', 'GET', '/api/me', 'A key 2', second.json.key);
  await step(group, 'but reads nothing', 'GET', stats, 'A key 2', second.json.key, undefined, REFUSED);
  await step(group, 'admin deletes the user', 'DELETE', `/api/users/${a.userId}`, 'admin', admin);
  await step(group, 'key after the user is deleted', 'GET', '/api/me', 'A key 2', second.json.key, undefined, REFUSED);
  await step(group, 'session token after the user is deleted', 'GET', '/api/me', 'A session', session, undefined, REFUSED);
  const left = readDb(`select count(*) from api_key where user_id = '${a.userId}'`);
  record(group, 'keys left for the deleted user (database, read-only)', 'api_key', 'read-only SQL', left, '0');
  return elapsed;
}

function countTenantRows(tenant) {
  const w = `'${tenant.websiteId}'`;
  const sql = `select 'website=' || (select count(*) from website where website_id = ${w})
    || ' events=' || (select count(*) from website_event where website_id = ${w})
    || ' sessions=' || (select count(*) from session where website_id = ${w})
    || ' event_data=' || (select count(*) from event_data where website_id = ${w})
    || ' shares=' || (select count(*) from share where entity_id = ${w})
    || ' team=' || (select count(*) from team where team_id = '${tenant.teamId}')
    || ' team_users=' || (select count(*) from team_user where team_id = '${tenant.teamId}')
    || ' user=' || (select count(*) from "user" where user_id = '${tenant.userId}')
    || ' keys=' || (select count(*) from api_key where user_id = '${tenant.userId}')`;
  return readDb(sql);
}

async function removeTenant(admin, b) {
  const group = '4 removal';
  const stats = `/api/websites/${b.websiteId}/stats?${rangeQuery('')}`;
  const share = await step(group, 'admin creates a share link for B (to see it go)', 'POST', `/api/websites/${b.websiteId}/shares`, 'admin', admin, { name: 'b', parameters: {} });
  await step(group, 'share link is public before removal', 'GET', `/api/share/${share.json.slug}`, 'nobody', null);
  const before = countTenantRows(b);
  await step(group, 'admin deletes the website', 'DELETE', `/api/websites/${b.websiteId}`, 'admin', admin);
  await step(group, 'B key reads the deleted website', 'GET', stats, 'B key', b.key, undefined, REFUSED);
  await step(group, 'share link after removal', 'GET', `/api/share/${share.json.slug}`, 'nobody', null, undefined, NOT_FOUND);
  await step(group, 'admin deletes the team', 'DELETE', `/api/teams/${b.teamId}`, 'admin', admin);
  const afterTeam = countTenantRows(b);
  await step(group, 'B key still authenticates: the user outlives the team', 'GET', '/api/me', 'B key', b.key);
  await step(group, 'admin deletes the service user', 'DELETE', `/api/users/${b.userId}`, 'admin', admin);
  await step(group, 'B key after the user is deleted', 'GET', '/api/me', 'B key', b.key, undefined, REFUSED);
  const after = countTenantRows(b);
  const gone = 'website=0 events=0 sessions=0 event_data=0 shares=0 team=0 team_users=0 user=0 keys=0';
  record(group, 'rows left for tenant B (database, read-only)', 'all tenant tables', 'read-only SQL', after, gone);
  return { before, afterTeam, after };
}

function printTable() {
  console.log('\n| # | group | what | route | caller | got | expected | ok |');
  console.log('|---|---|---|---|---|---|---|---|');
  rows.forEach((row, index) => {
    const cells = [index + 1, row.group, row.what, `\`${row.route}\``, row.who, row.got, row.expected, row.pass ? 'pass' : 'FAIL'];
    console.log(`| ${cells.join(' | ')} |`);
  });
}

async function main() {
  docker([...COMPOSE, 'down', '-v']);
  console.log('starting the isolated stack (compose project us-check-04) ...');
  docker([...COMPOSE, 'up', '-d', '--wait']);

  const login = await call('POST', '/api/auth/login', null, ADMIN);
  record('1 provision', 'admin session', 'POST /api/auth/login', 'admin password', login.status, OK);
  const admin = login.json.token;

  const a = await provisionTenant(admin, 'A');
  const b = await provisionTenant(admin, 'B');
  const moved = await step('1 provision', 'A: create a website outside any team', 'POST', '/api/websites', 'admin', admin, { name: 'moved', domain: 'moved.example' });
  const transfer = await step('1 provision', 'A: move that website into the team', 'POST', `/api/websites/${moved.json.id}/transfer`, 'admin', admin, { teamId: a.teamId });
  record('1 provision', 'A: moved website now belongs to the team', 'response body teamId', 'admin', transfer.json?.teamId === a.teamId ? 'team A' : 'other', 'team A');
  await step('1 provision', 'A: service user key reads the moved website', 'GET', `/api/websites/${moved.json.id}`, 'A key', a.key);
  const me = await step('1 provision', 'A: use the key', 'GET', '/api/me', 'A key', a.key);
  record('1 provision', 'A: key resolves to the service user', 'response body', 'A key', `${me.json?.user?.username},${me.json?.authType}`, `${a.username},api-key`);

  await sendEvents(a.websiteId, a.hostname);
  await sendEvents(b.websiteId, b.hostname);

  await probeAdminCannotMintKeys(admin, a);
  verifyStored(a);
  await probeReads(a, b);
  await probeRowIds(a, b);
  await probeLists(a, b);
  await probeWrites(admin, a, b);
  await plantLeaks(admin, a, b);
  const revokedInMs = await revoke(admin, a);
  const removal = await removeTenant(admin, b);

  printTable();
  const failed = rows.filter(row => !row.pass);
  console.log(`\nrevoked key refused on the next request, ${revokedInMs} ms after the delete returned`);
  console.log(`tenant B rows before removal:           ${removal.before}`);
  console.log(`tenant B rows after website and team:   ${removal.afterTeam}`);
  console.log(`tenant B rows after the user as well:   ${removal.after}`);
  console.log(`\n${rows.length} rows, ${failed.length} not as expected`);
  if (failed.length > 0) {
    console.log('VERDICT: CHANGED. The rows marked FAIL differ from the recorded result; re-read README.md.');
    return 1;
  }
  console.log('VERDICT: PASSES WITH A STATED CORRECTION TO THE DESIGN.');
  console.log('Teams, service users, memberships and websites are provisioned with the admin session.');
  console.log('A key is not: Umami only lets a user create and delete its own keys, from its own login.');
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  printTable();
  console.error(`\nVERDICT: NOT ESTABLISHED. ${error.message}`);
} finally {
  docker([...COMPOSE, 'down', '-v']);
}
process.exit(exitCode);
