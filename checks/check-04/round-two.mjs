#!/usr/bin/env node
// Check 04, round two: "A tenant's team, service user, membership, website and read key can be
// provisioned, and later fully removed, through Umami's HTTP API alone, without touching its
// database." Starts an isolated Umami 3.5.0, runs the worker in worker.mjs through complete,
// repeated and interrupted runs, probes the boundary, removes every tenant, prints a table and a
// verdict per item. Node built-ins only. The database is only ever read, on a read-only connection.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeKeyUser, probeJoinCode, probeShareLink } from './exposures.mjs';
import { HERE, PROJECT, call, must, printTable, rangeQuery, readDb, record, rows, sendEvents, startStack, step, stopStack } from './harness.mjs';
import { plantObjects, runMatrix } from './matrix.mjs';
import { Interrupted, PROVISION_STEPS, WORKER_MUTATIONS, createWorker, names } from './worker.mjs';

const ADMIN = { username: 'admin', password: 'umami' }; // Umami's seeded local default
const UMAMI_SRC = join(HERE, '..', '..', 'umami', 'src');
const HARNESS_MUTATIONS = ['leak-membership'];
const MUTATION = process.env.CHECK_04_MUTATION || null;
const MUTATIONS = MUTATION ? MUTATION.split(',') : [];
const OK = 200;
const BAD_REQUEST = 400;
const REFUSED = 401;
const NOT_FOUND = 404;

const COMPLETE = 'teams=1 users=1 roles=team-owner+team-view-only global=view-only websites=1 boards=1 keys=1 id-reserved=1';
const GONE = 'teams=0 users=0 roles=none global=none websites=0 boards=0 keys=0 id-reserved=0';

// Secrets the worker held for a moment, per tenant. Kept by the check, never by the worker.
const witnessed = new Map();

function witness(slug, kind, value) {
  if (!witnessed.has(slug)) witnessed.set(slug, { password: new Set(), session: new Set(), key: new Set(), 'join-code': new Set() });
  witnessed.get(slug)[kind].add(value);
}

const seen = (slug, kind) => [...(witnessed.get(slug)?.[kind] ?? [])];

/** A new worker for every run: nothing can be carried from one run to the next. */
function newWorker() {
  return createWorker({ call, admin: ADMIN, witness, mutation: MUTATION });
}

/** Copies what a run returned onto the tenant. A run that failed returns nothing: its row has
 *  already failed, and the rows that follow fail on the missing ids instead of stopping the script. */
function adopt(tenant, result) {
  if (!result) return;
  Object.assign(tenant, { teamId: result.teamId, userId: result.userId, websiteId: result.websiteId, key: result.key.value, keyId: result.key.id });
}

const tenantOf = (label, slug) => ({ label, slug, hostname: `${slug}.example`, username: names(slug).username });

/** Runs the worker and records how the run ended: 'completed', 'interrupted' or the error. */
async function run(group, what, action, tenant, expected = 'completed') {
  let result = null;
  let outcome = 'completed';
  try {
    result = await newWorker()[action](tenant);
  } catch (error) {
    outcome = error instanceof Interrupted ? 'interrupted' : `error: ${error.message}`;
  }
  record(group, what, `worker.${action}`, 'worker', outcome, expected);
  return result;
}

/** What Umami stored for a tenant, found by name as the worker finds it. */
function stateOf({ slug, username }) {
  const team = `(select team_id from team where name = '${slug}')`;
  const user = `(select user_id from "user" where username = '${username}')`;
  return readDb(`select 'teams=' || (select count(*) from team where name = '${slug}')
    || ' users=' || (select count(*) from "user" where username = '${username}')
    || ' roles=' || (select coalesce(string_agg(role, '+' order by role), 'none') from team_user where team_id in ${team})
    || ' global=' || coalesce((select role from "user" where username = '${username}'), 'none')
    || ' websites=' || (select count(*) from website where team_id in ${team})
    || ' boards=' || (select count(*) from board where team_id in ${team})
    || ' keys=' || (select count(*) from api_key where user_id in ${user})
    || ' id-reserved=' || (select count(*) from board where board_id in ${user} and user_id is null and team_id in ${team})`);
}

/** Rows that hang off a website or a user id, for tenants whose ids are known. */
function leftoversOf({ websiteId, teamId, userId }) {
  const w = `'${websiteId}'`;
  return readDb(`select 'events=' || (select count(*) from website_event where website_id = ${w})
    || ' sessions=' || (select count(*) from session where website_id = ${w})
    || ' event_data=' || (select count(*) from event_data where website_id = ${w})
    || ' reports=' || (select count(*) from report where website_id = ${w})
    || ' segments=' || (select count(*) from segment where website_id = ${w})
    || ' annotations=' || (select count(*) from annotation where website_id = ${w})
    || ' memberships=' || (select count(*) from team_user where team_id = '${teamId}' or user_id = '${userId}')
    || ' boards=' || (select count(*) from board where board_id = '${userId}' or team_id = '${teamId}')
    || ' shares=' || (select count(*) from share where entity_id in (${w}, '${userId}'))`);
}

/** How many of the secrets the worker held are still accepted. Every count must be zero. */
async function acceptedSecrets(tenant, probe) {
  const { slug, username } = tenant;
  const count = async (values, isAccepted) => {
    let accepted = 0;
    for (const value of values) if (await isAccepted(value)) accepted += 1;
    return `${accepted}/${values.length}`;
  };
  const passwords = await count(seen(slug, 'password'), async password => (await call('POST', '/api/auth/login', null, { username, password })).status === OK);
  const sessions = await count(seen(slug, 'session'), async session => (await call('GET', '/api/me', session)).status === OK);
  const lost = seen(slug, 'key').filter(key => key !== tenant.key);
  const keys = await count(lost, async key => (await call('GET', '/api/me', key)).status === OK);
  const codes = await count(seen(slug, 'join-code'), async accessCode => (await call('POST', '/api/teams/join', probe.key, { accessCode })).status !== NOT_FOUND);
  return `passwords ${passwords} sessions ${sessions} replaced keys ${keys} earlier join codes ${codes}`;
}

async function recordSecrets(group, tenant, probe) {
  const got = await acceptedSecrets(tenant, probe);
  record(group, `${tenant.slug}: secrets the worker held that are still accepted`, 'login, /api/me, /api/teams/join', 'nobody, probe key', got, got.replace(/\d+\//g, '0/'));
}

const statsPath = tenant => `/api/websites/${tenant.websiteId}/stats?${rangeQuery()}`;

function sourceFiles(root, keep) {
  const found = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (keep(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

/** Item A, first half: is there truly no way for an admin to create another user's key. */
async function probeAdminKeyRoute(admin, a) {
  const group = 'A0 no admin key route';
  const isSource = name => name.endsWith('.ts') && !name.includes('.test.') && !name.includes('.generated.');
  const containing = text => sourceFiles(UMAMI_SRC, isSource)
    .filter(path => readFileSync(path, 'utf8').includes(text))
    .map(path => relative(UMAMI_SRC, path))
    .join(' ');
  record(group, 'the only code that inserts a key', 'umami/src, apiKey.create(', 'source', containing('apiKey.create('), 'queries/prisma/apiKey.ts');
  record(group, 'the only route that calls it', 'umami/src, createApiKey(', 'source', containing('await createApiKey('), 'app/api/me/api-keys/route.ts');
  const route = readFileSync(join(UMAMI_SRC, 'app/api/me/api-keys/route.ts'), 'utf8');
  record(group, 'that route takes the owner from the caller\'s session', 'app/api/me/api-keys/route.ts', 'source', route.includes('userId: auth.user.id') ? 'auth.user.id' : 'other', 'auth.user.id');

  const before = readDb(`select count(*) from api_key where user_id = '${a.userId}'`);
  for (const path of [`/api/users/${a.userId}/api-keys`, `/api/admin/users/${a.userId}/api-keys`, '/api/admin/api-keys']) {
    await step(group, 'guessed admin route does not exist', 'POST', path, 'admin', admin, { name: 'for-a', userId: a.userId }, NOT_FOUND);
  }
  const own = await step(group, 'admin on the key route, naming user A in the body', 'POST', '/api/me/api-keys', 'admin', admin, { name: 'for-a', userId: a.userId });
  const owner = readDb(`select u.username from api_key k join "user" u on u.user_id = k.user_id where k.api_key_id = '${own.json?.id}'`);
  record(group, 'owner of that key (database, read-only)', 'api_key.user_id', 'read-only SQL', owner, 'admin');
  record(group, 'keys of service user A unchanged (database, read-only)', 'api_key', 'read-only SQL', readDb(`select count(*) from api_key where user_id = '${a.userId}'`), before);
  await step(group, 'cleanup: admin deletes its own key', 'DELETE', `/api/me/api-keys/${own.json?.id}`, 'admin', admin);
  await step(group, 'admin cannot delete the key of user A', 'DELETE', `/api/me/api-keys/${a.keyId}`, 'admin', admin, undefined, NOT_FOUND);
}

async function provisionFirst(group, tenant, probe) {
  const result = await run(group, `${tenant.label}: first run`, 'provision', tenant);
  adopt(tenant, result);
  record(group, `${tenant.label}: what Umami stored (database, read-only)`, 'team, user, team_user, website, board, api_key', 'read-only SQL', stateOf(tenant), COMPLETE);
  await step(group, `${tenant.label}: the key reads its website`, 'GET', statsPath(tenant), `${tenant.label} key`, tenant.key);
  const me = await call('GET', '/api/me', tenant.key);
  record(group, `${tenant.label}: the key resolves to the service user`, 'GET /api/me', `${tenant.label} key`, `${me.json?.user?.username},${me.json?.user?.role},${me.json?.authType}`, `${tenant.username},view-only,api-key`);
  await recordSecrets(group, tenant, probe);
}

/** Item A: the key, and what becomes of the password the worker used once. */
async function probePassword(admin, a, probe) {
  const group = 'A provision';
  const [password] = seen(a.slug, 'password');
  const [session] = seen(a.slug, 'session');
  await step(group, 'A: the password the worker signed in with, after the run', 'POST', '/api/auth/login', 'that password', null, { username: a.username, password }, REFUSED);
  await step(group, 'A: the session the worker created the key with, after the run', 'GET', '/api/me', 'that session', session, undefined, REFUSED);
  await step(group, 'A: that session can no longer create a key', 'POST', '/api/me/api-keys', 'that session', session, { name: 'late' }, REFUSED);
  await step(group, 'A: the key cannot create a key or a session', 'POST', '/api/me/api-keys', 'A key', a.key, { name: 'second' }, REFUSED);
  await step(group, 'A: the key cannot set a password', 'POST', '/api/me/password', 'A key', a.key, { currentPassword: password, newPassword: `${password}x` }, REFUSED);
  for (const [what, value] of [['empty', ''], ['null', null]]) {
    await step(group, `no route removes a password: admin sets it to ${what}`, 'POST', `/api/users/${a.userId}`, 'admin', admin, { password: value }, BAD_REQUEST);
  }

  // A new worker that was given the slug and nothing else replaces the key.
  const first = a.key;
  const result = await run(group, 'A: a later run by a new worker, given no key and no password', 'provision', { slug: a.slug, hostname: a.hostname });
  adopt(a, result);
  record(group, 'A: that run issued a new key', 'worker.provision', 'worker', result?.key.created ? 'new key' : 'kept', 'new key');
  await step(group, 'A: the new key reads the website', 'GET', statsPath(a), 'A key', a.key);
  await step(group, 'A: the first key is refused', 'GET', '/api/me', 'A first key', first, undefined, REFUSED);
  record(group, 'A: still one of everything (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(a), COMPLETE);
  await recordSecrets(group, a, probe);
}

/** Item B: running again, and running again after a run that stopped part-way. */
async function probeReruns(a, probe) {
  const group = 'B re-run';
  const keyRow = () => readDb(`select api_key_id from api_key where user_id = '${a.userId}'`);
  const before = keyRow();
  const again = await run(group, 'A: second run, given the key the console holds', 'provision', { slug: a.slug, hostname: a.hostname, currentKey: a.key });
  const same = again?.teamId === a.teamId && again?.userId === a.userId && again?.websiteId === a.websiteId;
  record(group, 'A: same team, user and website ids', 'worker.provision', 'worker', same ? 'same ids' : 'different ids', 'same ids');
  record(group, 'A: the key was kept, not replaced', 'api_key', 'worker, read-only SQL', `${again?.key.created === false ? 'kept' : 'not kept'}, ${keyRow() === before ? 'same row' : 'other row'}`, 'kept, same row');
  record(group, 'A: one of everything (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(a), COMPLETE);
  await step(group, 'A: the key still reads its website', 'GET', statsPath(a), 'A key', a.key);

  const interrupted = [];
  for (const stoppedAfter of PROVISION_STEPS) {
    const tenant = tenantOf(stoppedAfter, `int-${stoppedAfter}`);
    await run(group, `stopped after "${stoppedAfter}"`, 'provision', { ...tenant, crashAfter: stoppedAfter }, 'interrupted');
    if (stoppedAfter === 'sign-in') {
      // A limit, recorded as it is: the session of a run that died here lives until the next run.
      await step(group, 'stopped after "sign-in": until the next run, the session it left is still accepted', 'GET', '/api/me', 'that session', seen(tenant.slug, 'session')[0]);
    }
    const result = await run(group, `stopped after "${stoppedAfter}": run again`, 'provision', tenant);
    adopt(tenant, result);
    record(group, `stopped after "${stoppedAfter}": one of everything (database, read-only)`, 'all tenant tables', 'read-only SQL', stateOf(tenant), COMPLETE);
    await step(group, `stopped after "${stoppedAfter}": the key reads its website`, 'GET', statsPath(tenant), 'its key', tenant.key);
    await recordSecrets(group, tenant, probe);
    interrupted.push(tenant);
  }
  return interrupted;
}

// Slugs that are not already in the spelling Umami stores, each with a valid hostname.
const SLUGS = [
  ['Tenant-Mixed', 'mixed.example'],
  ['  Padded-Slug  ', 'padded.example'],
  ['ténant-É', 'accent.example'],
  ['İstanbul', 'dotted.example'],
];

/** Items B and C again, for slugs with upper case, surrounding spaces and non-ASCII letters. */
async function probeSlugs() {
  for (const [given, hostname] of SLUGS) {
    // The check's own statement of the stored spelling, not the worker's function.
    const slug = given.trim().toLowerCase();
    const tenant = { label: slug, slug, hostname, username: `svc-${slug}` };
    const shown = `slug ${JSON.stringify(given)}`;
    adopt(tenant, await run('B slugs', `${shown}: first run`, 'provision', { slug: given, hostname }));
    const stored = readDb(`select t.name || '|' || u.username || '|' || w.name from team t, "user" u, website w
      where t.team_id::text = '${tenant.teamId}' and u.user_id::text = '${tenant.userId}' and w.website_id::text = '${tenant.websiteId}'`);
    record('B slugs', `${shown}: team name, username and website name as stored (database, read-only)`, 'team, user, website', 'read-only SQL', stored, `${slug}|svc-${slug}|${slug}`);
    const sameAs = result => (result?.teamId === tenant.teamId && result?.userId === tenant.userId && result?.websiteId === tenant.websiteId && result?.key.created === false ? 'same ids, key kept' : 'differs');
    const second = await run('B slugs', `${shown}: second run, key given`, 'provision', { slug: given, hostname, currentKey: tenant.key });
    record('B slugs', `${shown}: second run found the same tenant`, 'worker.provision', 'worker', sameAs(second), 'same ids, key kept');
    const upper = await run('B slugs', `${shown}: third run, slug written in upper case`, 'provision', { slug: given.toUpperCase(), hostname, currentKey: tenant.key });
    record('B slugs', `${shown}: upper case is the same tenant`, 'worker.provision', 'worker', sameAs(upper), 'same ids, key kept');
    record('B slugs', `${shown}: one of everything (database, read-only)`, 'all tenant tables', 'read-only SQL', stateOf(tenant), COMPLETE);
    await step('B slugs', `${shown}: the key reads its website`, 'GET', statsPath(tenant), 'its key', tenant.key);

    await run('C slugs', `${shown}: removal, key given`, 'remove', { slug: given, currentKey: tenant.key });
    record('C slugs', `${shown}: nothing left (database, read-only)`, 'all tenant tables', 'read-only SQL', stateOf(tenant), GONE);
    await step('C slugs', `${shown}: the key is refused`, 'GET', '/api/me', 'its key', tenant.key, undefined, REFUSED);
    await run('C slugs', `${shown}: removal again, nothing to do`, 'remove', { slug: given });
  }
}

/** Item C: a tenant the name lookup cannot find. Removal must fail, not report success. */
async function probeUnfindableUser(admin) {
  const group = 'C read-back';
  const tenant = tenantOf('drifted', 'drifted');
  adopt(tenant, await run(group, 'a tenant is provisioned', 'provision', tenant));
  await must('POST', `/api/users/${tenant.userId}`, admin, { username: 'renamed-by-hand' });
  await run(group, 'its user is renamed by hand; removal must not report success', 'remove', { slug: tenant.slug, currentKey: tenant.key }, 'error: removal incomplete: the team still has a member that is not its owner');
  await step(group, 'and it is right not to: the key is still accepted', 'GET', '/api/me', 'its key', tenant.key);
  await must('DELETE', `/api/users/${tenant.userId}`, admin);
  await run(group, 'once that user is deleted by id, removal completes', 'remove', { slug: tenant.slug, currentKey: tenant.key });
  record(group, 'nothing left (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(tenant), GONE);
  await step(group, 'the key is refused', 'GET', '/api/me', 'its key', tenant.key, undefined, REFUSED);
}

/** Item C: removal, its order, a removal that stops part-way, and removal of half-made tenants. */
async function probeRemoval(admin, a, b, interrupted) {
  const group = 'C removal';
  // Why the user goes first, measured on a tenant removed by hand in the other order.
  const [byHand, ...rest] = interrupted;
  await step(group, 'other order: admin deletes the team first', 'DELETE', `/api/teams/${byHand.teamId}`, 'admin', admin);
  await step(group, 'other order: the key still authenticates', 'GET', '/api/me', 'its key', byHand.key);
  await run(group, 'other order: the worker finishes the removal', 'remove', byHand);
  await step(group, 'other order: the key is refused once the user is gone', 'GET', '/api/me', 'its key', byHand.key, undefined, REFUSED);

  record(group, 'B before removal (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(b), COMPLETE);
  record(group, 'B data before removal (database, read-only)', 'website and user rows', 'read-only SQL', leftoversOf(b), 'events=3 sessions=1 event_data=1 reports=2 segments=1 annotations=1 memberships=2 boards=1 shares=0');
  await run(group, 'B: removal stopped after its first step', 'remove', { ...b, crashAfter: 'first-step' }, 'interrupted');
  await step(group, 'B: after that one step the key is refused', 'GET', '/api/me', 'B key', b.key, undefined, REFUSED);
  await step(group, 'B: and reads nothing', 'GET', statsPath(b), 'B key', b.key, undefined, REFUSED);
  record(group, 'B: what is left after that one step (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(b), 'teams=1 users=0 roles=team-owner global=none websites=1 boards=1 keys=0 id-reserved=0');
  await run(group, 'B: removal run again, given the key the console holds', 'remove', { ...b, currentKey: b.key });
  record(group, 'B: nothing left (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(b), GONE);
  record(group, 'B: no data left (database, read-only)', 'website and user rows', 'read-only SQL', leftoversOf(b), 'events=0 sessions=0 event_data=0 reports=0 segments=0 annotations=0 memberships=0 boards=0 shares=0');
  await run(group, 'B: removal run a third time, nothing to do', 'remove', b);

  await run(group, 'A: removal stopped after its last step', 'remove', { ...a, crashAfter: 'team' }, 'interrupted');
  await run(group, 'A: removal run again', 'remove', a);
  record(group, 'A: nothing left (database, read-only)', 'all tenant tables', 'read-only SQL', stateOf(a), GONE);
  await step(group, 'A: the key is refused', 'GET', '/api/me', 'A key', a.key, undefined, REFUSED);

  let accepted = 0;
  for (const tenant of rest) {
    await newWorker().remove(tenant);
    if (stateOf(tenant) !== GONE || (await call('GET', '/api/me', tenant.key)).status !== REFUSED) accepted += 1;
  }
  record(group, `the ${rest.length} other completed tenants: removed, key refused`, 'worker.remove', 'worker', `${accepted} of ${rest.length} left`, `0 of ${rest.length} left`);

  for (const stoppedAfter of PROVISION_STEPS) {
    const tenant = tenantOf(stoppedAfter, `half-${stoppedAfter}`);
    await run(group, `half-made tenant, provisioning stopped after "${stoppedAfter}"`, 'provision', { ...tenant, crashAfter: stoppedAfter }, 'interrupted');
    await run(group, `half-made after "${stoppedAfter}": removal`, 'remove', tenant);
    const keys = seen(tenant.slug, 'key');
    let alive = 0;
    for (const key of keys) if ((await call('GET', '/api/me', key)).status !== REFUSED) alive += 1;
    record(group, `half-made after "${stoppedAfter}": nothing left, no key accepted`, 'all tenant tables, /api/me', 'read-only SQL, its keys', `${stateOf(tenant)} keys accepted ${alive}/${keys.length}`, `${GONE} keys accepted 0/${keys.length}`);
  }
}

function recordEmptyDatabase() {
  const got = readDb(`select 'users=' || (select string_agg(username, '+') from "user") || ' teams=' || (select count(*) from team)
    || ' memberships=' || (select count(*) from team_user) || ' websites=' || (select count(*) from website)
    || ' events=' || (select count(*) from website_event) || ' boards=' || (select count(*) from board)
    || ' shares=' || (select count(*) from share) || ' keys=' || (select count(*) from api_key)`);
  record('C removal', 'whole database after every tenant and control is removed (read-only)', 'all tables', 'read-only SQL', got, 'users=admin teams=0 memberships=0 websites=0 events=0 boards=0 shares=0 keys=0');
  let refusedWrite = false;
  try {
    readDb('create table check_04_must_not_exist (id int)');
  } catch {
    refusedWrite = true;
  }
  record('C removal', 'the connection this script uses refuses writes', 'CREATE TABLE', 'read-only SQL', refusedWrite ? 'refused' : 'accepted', 'refused');
}

const VERDICTS = [
  ['A', 'Yes. Team, user, membership, website and key through the API; the password is never stored.'],
  ['B', 'Yes. A second run changes nothing; a run stopped after any of 11 steps is completed by the next.'],
  ['C', 'Yes. User first, then team; the key is refused after the first call; nothing is left.'],
  ['D', 'Yes, with one stated condition. The join code cannot be switched off, only replaced by a value nobody keeps.'],
  ['E', 'Yes, with one stated condition. The service user\'s id must be held by a team board before the user exists.'],
  ['F', 'Yes. No cross-tenant read on any probed route; every GET route is accounted for.'],
];

function printVerdict(summary) {
  const failed = rows.filter(row => !row.pass);
  console.log(`\nGET routes in Umami's source: ${summary.inventory}. Probed: ${summary.probed} `
    + `(${summary.websiteRoutes} website routes, ${summary.idRoutesStored} id routes with a stored object, `
    + `${summary.idRoutesGuardOnly} id routes guard only, ${summary.scoped} other routes with a tenant id, `
    + `${summary.lists} lists, ${summary.closed} closed to every key). Not probed, with reason: ${Object.keys(summary.notProbed).length}.`);
  for (const [route, reason] of Object.entries(summary.notProbed)) console.log(`  not probed: ${route} (${reason})`);
  console.log(`\n${rows.length} rows, ${failed.length} not as expected${MUTATION ? `, mutation ${MUTATION}` : ''}`);
  for (const [item, text] of VERDICTS) {
    const broken = failed.filter(row => row.group.startsWith(item)).length;
    console.log(`${item}: ${broken ? `CHANGED, ${broken} rows differ` : text}`);
  }
  if (failed.length > 0) {
    console.log('VERDICT: CHANGED. The rows marked FAIL differ from the recorded result; re-read README.md.');
    return 1;
  }
  console.log('VERDICT: YES for the reworded claim, with the two conditions stated under D and E.');
  return 0;
}

async function main() {
  const unknown = MUTATIONS.filter(name => ![...WORKER_MUTATIONS, ...HARNESS_MUTATIONS].includes(name));
  if (unknown.length > 0) throw new Error(`unknown mutation ${unknown.join(',')}`);
  console.log(`starting the isolated stack (compose project ${PROJECT}) ...`);
  console.log(`Umami at ${startStack()}${MUTATION ? `, mutation ${MUTATION}` : ''}`);
  const admin = (await must('POST', '/api/auth/login', null, ADMIN)).token;
  const probe = await makeKeyUser(admin, 'probe-no-team');

  const a = tenantOf('A', 'tenant-a');
  const b = tenantOf('B', 'tenant-b');
  await provisionFirst('A provision', a, probe);
  await provisionFirst('A provision', b, probe);
  await probeAdminKeyRoute(admin, a);
  await probePassword(admin, a, probe);
  const interrupted = await probeReruns(a, probe);

  for (const tenant of [a, b]) {
    await sendEvents(tenant.websiteId, tenant.hostname);
    tenant.objects = await plantObjects(call, admin, tenant);
  }
  await probeJoinCode({ admin, probe, tenant: b, spare: interrupted[1], earlierCodes: seen(b.slug, 'join-code') });
  await probeShareLink({ admin, tenant: a });
  if (MUTATIONS.includes('leak-membership')) await must('POST', `/api/teams/${b.teamId}/users`, admin, { userId: a.userId, role: 'team-view-only' });
  const summary = await runMatrix({ call, record, apiRoot: join(UMAMI_SRC, 'app', 'api') }, a, b);
  if (MUTATIONS.includes('leak-membership')) await must('DELETE', `/api/teams/${b.teamId}/users/${a.userId}`, admin);

  await probeSlugs();
  await probeUnfindableUser(admin);
  await probeRemoval(admin, a, b, interrupted);
  await must('DELETE', `/api/users/${probe.id}`, admin);
  recordEmptyDatabase();

  printTable();
  return printVerdict(summary);
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  printTable();
  console.error(`\nVERDICT: NOT ESTABLISHED. ${error.stack}`);
} finally {
  stopStack();
}
process.exit(exitCode);
