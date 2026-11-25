// Round two, items D and E: the two limits round one reported. Each is first shown on a control
// that the worker did not provision, then tried against a tenant the worker did provision.
import { randomBytes } from 'node:crypto';
import { call, must, rangeQuery, readDb, record, sendEvents, step } from './harness.mjs';

const OK = 200;
const BAD_REQUEST = 400;
const REFUSED = 401;
const NOT_FOUND = 404;
const SERVER_ERROR = 500;
const BOARD_SHARE = 4; // ENTITY_TYPE.board, umami/src/lib/constants.ts:138-143
const WEBSITE_SHARE = 1;

const random = bytes => randomBytes(bytes).toString('base64url');

/** A view-only user with a key, made by the admin directly: the control, not a tenant. */
export async function makeKeyUser(admin, username) {
  const password = random(24);
  const user = await must('POST', '/api/users', admin, { username, password, role: 'view-only' });
  const session = (await must('POST', '/api/auth/login', null, { username, password })).token;
  const key = await must('POST', '/api/me/api-keys', session, { name: 'control' });
  return { id: user.id, username, session, key: key.key, keyId: key.id };
}

async function joinAndLeave(group, what, admin, probe, team, accessCode, expected) {
  const joined = await step(group, what, 'POST', '/api/teams/join', 'probe key', probe.key, { accessCode }, expected);
  if (joined.status === OK) await must('DELETE', `/api/teams/${joined.json.teamId}/users/${probe.id}`, admin);
  return joined;
}

/**
 * Item D. `probe` is a view-only key that belongs to no team. `tenant` was provisioned by the
 * worker; `earlierCodes` are the join codes its team had before the worker's last rotation.
 */
export async function probeJoinCode({ admin, probe, tenant, spare, earlierCodes }) {
  const group = 'D join code';
  const [team] = await must('POST', '/api/teams', admin, { name: 'control-join' });
  const site = await must('POST', '/api/websites', admin, { name: 'control-join', domain: 'control-join.example', teamId: team.id });
  const stats = `/api/websites/${site.id}/stats?${rangeQuery()}`;

  await step(group, 'control: before joining, the key cannot read the team website', 'GET', stats, 'probe key', probe.key, undefined, REFUSED);
  const joined = await step(group, 'control LEAK: a view-only key joins with the code the team was created with', 'POST', '/api/teams/join', 'probe key', probe.key, { accessCode: team.accessCode });
  record(group, 'control LEAK: it joins with a writing role', 'response body role', 'probe key', joined.json?.role, 'team-member');
  await step(group, 'control LEAK: it reads the team website', 'GET', stats, 'probe key', probe.key);
  await step(group, 'control LEAK: it renames the team website', 'POST', `/api/websites/${site.id}`, 'probe key', probe.key, { name: 'renamed' });
  await step(group, 'cleanup: admin removes the key\'s user from the team', 'DELETE', `/api/teams/${team.id}/users/${probe.id}`, 'admin', admin);
  await step(group, 'after removal the key cannot read it', 'GET', stats, 'probe key', probe.key, undefined, REFUSED);

  const update = `/api/teams/${team.id}`;
  await step(group, 'the code cannot be set to null', 'POST', update, 'admin', admin, { accessCode: null }, BAD_REQUEST);
  await step(group, 'the code cannot be longer than 50 characters', 'POST', update, 'admin', admin, { accessCode: 'x'.repeat(51) }, BAD_REQUEST);
  await step(group, 'the code can be set to an empty string', 'POST', update, 'admin', admin, { accessCode: '' });
  await joinAndLeave(group, 'LEAK: an empty code is a code; a key joins with it', admin, probe, team, '', OK);
  const [second] = await must('POST', '/api/teams', admin, { name: 'control-join-2' });
  await step(group, 'a second team cannot be emptied: codes are unique', 'POST', `/api/teams/${second.id}`, 'admin', admin, { accessCode: '' }, SERVER_ERROR);
  await step(group, 'rotation: admin sets a random 50-character code', 'POST', update, 'admin', admin, { accessCode: random(40).slice(0, 50) });
  await joinAndLeave(group, 'after rotation the code as created is refused', admin, probe, team, team.accessCode, NOT_FOUND);
  await joinAndLeave(group, 'after rotation the empty code is refused', admin, probe, team, '', NOT_FOUND);

  let accepted = 0;
  for (const accessCode of earlierCodes) {
    const attempt = await call('POST', '/api/teams/join', probe.key, { accessCode });
    if (attempt.status !== NOT_FOUND) accepted += 1;
  }
  record(group, `tenant ${tenant.label}: every code its team had before the last rotation is refused`, 'POST /api/teams/join', 'probe key', `${accepted} of ${earlierCodes.length} accepted`, `0 of ${earlierCodes.length} accepted`);
  const current = (await must('GET', `/api/teams/${tenant.teamId}`, admin)).accessCode;
  const fresh = current.length === 50 && !earlierCodes.includes(current);
  record(group, `tenant ${tenant.label}: the current code is 50 characters and was never one of them`, 'GET /api/teams/:id', 'admin', fresh ? 'rotated' : 'not rotated', 'rotated');
  for (const path of [`/api/teams/${tenant.teamId}`, '/api/teams', '/api/me/teams']) {
    const seen = await call('GET', path, tenant.key);
    const withheld = seen.status === OK && !seen.text.includes(current) && !seen.text.includes('accessCode');
    record(group, `tenant ${tenant.label}: its own key is not shown the code`, `GET ${path.replace(tenant.teamId, ':id')}`, `${tenant.label} key`, withheld ? 'withheld' : 'shown', 'withheld');
  }
  await step(group, `tenant ${tenant.label}: its key cannot change the code`, 'POST', `/api/teams/${tenant.teamId}`, `${tenant.label} key`, tenant.key, { accessCode: 'known-to-the-tenant' }, REFUSED);

  // What stays open: the route still exists, so whoever can read the current code can use it.
  const spareCode = (await must('GET', `/api/teams/${spare.teamId}`, admin)).accessCode;
  await joinAndLeave(group, 'STAYS OPEN: a key whose holder has read the current code (admin or database) joins', admin, probe, spare, spareCode, OK);

  await must('DELETE', `/api/teams/${team.id}`, admin);
  await must('DELETE', `/api/teams/${second.id}`, admin);
}

async function shareControl(group, admin) {
  const [team] = await must('POST', '/api/teams', admin, { name: 'control-share' });
  const site = await must('POST', '/api/websites', admin, { name: 'control-share', domain: 'control-share.example', teamId: team.id });
  await sendEvents(site.id, 'control-share.example');
  const user = await makeKeyUser(admin, 'control-share');
  await must('POST', `/api/teams/${team.id}/users`, admin, { userId: user.id, role: 'team-view-only' });
  const stats = `/api/websites/${site.id}/stats?${rangeQuery()}`;
  const board = { name: 'd', description: 'd', parameters: { rows: [{ id: 'r', columns: [{ id: 'c', component: { type: 'WebsiteStats', websiteId: site.id } }] }] } };

  await step(group, 'control: the direct route is refused, as in round one', 'POST', `/api/websites/${site.id}/shares`, 'control key', user.key, { name: 's', parameters: {} }, REFUSED);
  await step(group, 'control LEAK: a view-only key saves a personal dashboard that shows the team website', 'POST', '/api/dashboard', 'control key', user.key, board);
  const share = await step(group, 'control LEAK: and creates a share link for that dashboard', 'POST', `/api/boards/${user.id}/shares`, 'control key', user.key, { name: 's', parameters: {} });
  const opened = await step(group, 'control LEAK: the link opens with no credential', 'GET', `/api/share/${share.json?.slug}`, 'nobody', null);
  const token = { 'x-umami-share-token': opened.json?.token, 'x-umami-share-context': '1' };
  const totals = await call('GET', stats, null, undefined, token);
  record(group, 'control LEAK: the link reads the website totals', 'GET /api/websites/:id/stats', 'share link', `${totals.status} pageviews=${totals.json?.pageviews}`, '200 pageviews=2');
  const sessions = await call('GET', `/api/websites/${site.id}/sessions?${rangeQuery()}`, null, undefined, token);
  record(group, 'control: the link does not read visitor rows', 'GET /api/websites/:id/sessions', 'share link', sessions.status, REFUSED);

  await step(group, 'control: the key is revoked', 'DELETE', `/api/me/api-keys/${user.keyId}`, 'control session', user.session);
  const after = await call('GET', stats, null, undefined, token);
  record(group, 'control LEAK: the link outlives the key that made it', 'GET /api/websites/:id/stats', 'share link', after.status, OK);
  const listed = await must('GET', `/api/boards/${user.id}/shares`, admin);
  record(group, 'control: the admin can list the links of that dashboard', 'GET /api/boards/:id/shares', 'admin', `${listed.count} listed`, '1 listed');
  await step(group, 'control: the admin deletes the link', 'DELETE', `/api/share/id/${share.json?.id}`, 'admin', admin);
  const closed = await call('GET', stats, null, undefined, token);
  record(group, 'control: the deleted link reads nothing', 'GET /api/websites/:id/stats', 'share link', closed.status, REFUSED);

  const generic = await step(group, 'control LEAK: the generic route makes a link too (login session)', 'POST', '/api/share', 'control session', user.session, { entityId: user.id, shareType: BOARD_SHARE, name: 'g', parameters: {} });
  await step(group, 'control: the admin deletes the user', 'DELETE', `/api/users/${user.id}`, 'admin', admin);
  await step(group, 'control: its links are gone with it', 'GET', `/api/share/${generic.json?.slug}`, 'nobody', null, undefined, NOT_FOUND);
  await must('DELETE', `/api/teams/${team.id}`, admin);
}

/** Item E. `tenant` was provisioned by the worker, so its user id is held by a team board. */
export async function probeShareLink({ admin, tenant }) {
  const group = 'E share link';
  await shareControl(group, admin);

  const who = `${tenant.label} key`;
  const board = { name: 'd', description: 'd', parameters: { rows: [{ id: 'r', columns: [{ id: 'c', component: { type: 'WebsiteStats', websiteId: tenant.websiteId } }] }] } };
  const link = { name: 's', parameters: {} };
  const attempts = [
    ['read its personal dashboard', 'GET', '/api/dashboard', undefined],
    ['save a personal dashboard', 'POST', '/api/dashboard', board],
    ['create a share link for the board that holds its id', 'POST', `/api/boards/${tenant.userId}/shares`, link],
    ['generic route, its own id as a board', 'POST', '/api/share', { ...link, entityId: tenant.userId, shareType: BOARD_SHARE }],
    ['generic route, its own website', 'POST', '/api/share', { ...link, entityId: tenant.websiteId, shareType: WEBSITE_SHARE }],
    ['website route, its own website', 'POST', `/api/websites/${tenant.websiteId}/shares`, link],
    ['create a personal board', 'POST', '/api/boards', { type: 'mixed', name: 'b' }],
    ['create a team board', 'POST', '/api/boards', { type: 'mixed', name: 'b', teamId: tenant.teamId }],
    ['rename the board that holds its id', 'POST', `/api/boards/${tenant.userId}`, { name: 'renamed' }],
    ['delete the board that holds its id', 'DELETE', `/api/boards/${tenant.userId}`, undefined],
    ['create a link', 'POST', '/api/links', { name: 'l', url: 'https://example.com', slug: 'check04link' }],
    ['create a pixel', 'POST', '/api/pixels', { name: 'p', slug: 'check04pixel' }],
  ];
  for (const [what, method, path, body] of attempts) {
    await step(group, `tenant ${tenant.label}: ${what}`, method, path, who, tenant.key, body, REFUSED);
  }
  const shares = readDb('select count(*) from share');
  record(group, 'share links in the database after all attempts (read-only)', 'share', 'read-only SQL', shares, '0');
  await step(group, `tenant ${tenant.label}: its key still reads its website`, 'GET', `/api/websites/${tenant.websiteId}/stats?${rangeQuery()}`, who, tenant.key);
}
