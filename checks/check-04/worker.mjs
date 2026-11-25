// The provisioning worker of round two, reduced to what the check needs. It talks to Umami over
// HTTP only and keeps nothing between runs: every run starts from the admin credential and the
// tenant's slug and hostname, finds what already exists by name, and creates only what is missing.
import { randomBytes } from 'node:crypto';

export const PROVISION_STEPS = [
  'team',
  'join-code',
  'reserve-id',
  'user',
  'membership',
  'website',
  'password',
  'sign-in',
  'key',
  'prune-keys',
  'discard-password',
];
export const REMOVE_STEPS = ['user', 'team'];

// Each one removes a safeguard. The script must fail under every one of them; see controls.mjs.
export const WORKER_MUTATIONS = [
  'keep-password',
  'no-team-lookup',
  'keep-old-keys',
  'keep-join-code',
  'no-id-reservation',
  'remove-team-first',
  'remove-keep-user',
  'exact-name-match',
  'remove-no-readback',
];

export const RESERVED_BOARD = 'reserved: holds the service user id';
const JOIN_CODE_LENGTH = 50; // the longest value Umami accepts
const OK = 200;

export class Interrupted extends Error {}

const random = bytes => randomBytes(bytes).toString('base64url');

const TEAM_NAME_LIMIT = 50; // Umami refuses a longer team name

/**
 * The one spelling of a slug that the worker sends to Umami and looks up. Umami lower-cases a
 * username, trims a website name, and stores a team name as given. Lower-casing and trimming here
 * makes the three agree, so that a lookup compares against exactly what Umami stored, and so that
 * two spellings of one slug are one tenant.
 */
export function canonicalSlug(slug) {
  const canonical = slug.trim().toLowerCase();
  if (!canonical || canonical.length > TEAM_NAME_LIMIT) {
    throw new Error(`slug "${slug}" must be 1 to ${TEAM_NAME_LIMIT} characters after trimming`);
  }
  return canonical;
}

const namesFor = slug => ({ team: slug, username: `svc-${slug}`, website: slug });

export const names = slug => namesFor(canonicalSlug(slug));

/**
 * Builds a worker.
 *
 * @param {object} options
 * @param {Function} options.call HTTP client: (method, path, credential, body) => {status, json, text}.
 * @param {{username: string, password: string}} options.admin The Umami admin credential.
 * @param {string|null} options.mutation One of WORKER_MUTATIONS, or null.
 * @param {Function} options.witness Test instrumentation only: (slug, kind, value). It lets the
 *   check prove that secrets the worker held for a moment are refused afterwards. A real worker
 *   has no such hook and keeps none of these values.
 */
export function createWorker({ call, admin, mutation = null, witness = () => {} }) {
  // Several mutations may be combined with commas.
  const is = name => (mutation ?? '').split(',').includes(name);

  async function api(method, path, credential, body) {
    const result = await call(method, path, credential, body);
    if (result.status !== OK) {
      const detail = result.text.slice(0, 200);
      throw new Error(`${method} ${path.split('?')[0]} answered ${result.status}, expected ${OK}: ${detail}`);
    }
    return result.json;
  }

  async function signInAdmin() {
    return (await api('POST', '/api/auth/login', null, admin)).token;
  }

  /** Umami's search is a substring match, so the result is filtered to the exact value. */
  async function exactMatches(token, path, field, value) {
    const page = await api('GET', `${path}?search=${encodeURIComponent(value)}&pageSize=100`, token);
    return page.data.filter(item => item[field] === value);
  }

  // The mutation restores round two's first version: names as given, compared as given.
  const namesOf = slug => (is('exact-name-match') ? namesFor(slug) : names(slug));

  async function ensureTeam(token, slug) {
    const found = is('no-team-lookup') ? [] : await exactMatches(token, '/api/admin/teams', 'name', slug);
    if (found.length > 1) throw new Error(`${found.length} teams are named ${slug}; remove the tenant first`);
    if (found.length === 1) return found[0];
    const [team] = await api('POST', '/api/teams', token, { name: slug });
    witness(slug, 'join-code', team.accessCode);
    return team;
  }

  /** Umami has no way to switch the join code off, so it is replaced by a value nobody keeps. */
  async function rotateJoinCode(token, slug, teamId) {
    if (is('keep-join-code')) return;
    const before = (await api('GET', `/api/teams/${teamId}`, token)).accessCode;
    witness(slug, 'join-code', before);
    const accessCode = random(40).slice(0, JOIN_CODE_LENGTH);
    await api('POST', `/api/teams/${teamId}`, token, { accessCode });
  }

  /**
   * A board owned by the team, whose id the service user is then given. Umami keeps a user's
   * personal dashboard in a board with the user's own id; with that id taken by a board the user
   * cannot edit, a view-only user has no board to publish through a share link.
   */
  async function ensureReservedBoard(token, teamId) {
    if (is('no-id-reservation')) return null;
    const found = await exactMatches(token, `/api/teams/${teamId}/boards`, 'name', RESERVED_BOARD);
    if (found.length > 0) return found[0];
    return api('POST', '/api/boards', token, { type: 'mixed', name: RESERVED_BOARD, teamId });
  }

  async function ensureUser(token, slug, board) {
    const username = `svc-${slug}`;
    const [found] = await exactMatches(token, '/api/admin/users', 'username', username);
    const user =
      found ??
      (await api('POST', '/api/users', token, {
        ...(board && { id: board.id }),
        username,
        password: random(32),
        role: 'view-only',
      }));
    if (user.role !== 'view-only') throw new Error(`${username} has global role ${user.role}; remove the tenant first`);
    if (board && user.id !== board.id) throw new Error(`${username} does not hold the reserved id; remove the tenant first`);
    return user;
  }

  async function ensureMembership(token, teamId, userId) {
    const members = await api('GET', `/api/teams/${teamId}/users?pageSize=100`, token);
    const member = members.data.find(item => item.userId === userId);
    if (!member) {
      await api('POST', `/api/teams/${teamId}/users`, token, { userId, role: 'team-view-only' });
    } else if (member.role !== 'team-view-only') {
      await api('POST', `/api/teams/${teamId}/users/${userId}`, token, { role: 'team-view-only' });
    }
  }

  async function ensureWebsite(token, slug, hostname, teamId) {
    const domain = hostname.trim().toLowerCase();
    const [found] = await exactMatches(token, `/api/teams/${teamId}/websites`, 'domain', domain);
    return found ?? api('POST', '/api/websites', token, { name: slug, domain, teamId });
  }

  async function setRandomPassword(token, slug, userId) {
    const password = random(32);
    witness(slug, 'password', password);
    await api('POST', `/api/users/${userId}`, token, { password });
    return password;
  }

  /** The id of a key the caller already holds, if it still belongs to this service user. */
  async function identifyKey(key, userId) {
    if (!key) return null;
    const me = await call('GET', '/api/me', key);
    return me.status === OK && me.json?.user?.id === userId ? me.json.apiKey.id : null;
  }

  /**
   * Leaves the service user with exactly one key. Umami lets a user create only its own key, so
   * the worker sets a password it has just generated, signs in once, and works from that session.
   */
  async function ensureSingleKey(token, tenant, user, done) {
    const { currentKey } = tenant;
    const slug = namesOf(tenant.slug).team;
    const password = await setRandomPassword(token, slug, user.id);
    done('password');
    const login = await api('POST', '/api/auth/login', null, { username: user.username, password });
    witness(slug, 'session', login.token);
    done('sign-in');

    const existing = await api('GET', '/api/me/api-keys', login.token);
    const heldId = await identifyKey(currentKey, user.id);
    let key = { id: heldId, value: currentKey, created: false };
    if (!heldId || !existing.some(item => item.id === heldId)) {
      const created = await api('POST', '/api/me/api-keys', login.token, { name: 'console-read' });
      witness(slug, 'key', created.key);
      key = { id: created.id, value: created.key, created: true };
    }
    done('key');

    if (!is('keep-old-keys')) {
      for (const other of existing.filter(item => item.id !== key.id)) {
        await api('DELETE', `/api/me/api-keys/${other.id}`, login.token);
      }
    }
    done('prune-keys');
    return key;
  }

  /**
   * Provisions one tenant, or completes a tenant that an earlier run left half done.
   *
   * @param {object} tenant
   * @param {string} tenant.slug Team name; the service user is `svc-<slug>`.
   * @param {string} tenant.hostname Domain of the tenant's website.
   * @param {string} [tenant.currentKey] The key the caller already holds, kept if still valid.
   * @param {string} [tenant.crashAfter] Test only: stop after this step, as a crash would.
   * @returns {Promise<{teamId: string, userId: string, websiteId: string, key: object}>}
   */
  async function provision(tenant) {
    const { hostname, crashAfter } = tenant;
    const slug = namesOf(tenant.slug).team;
    const done = step => {
      if (step === crashAfter) throw new Interrupted(step);
    };
    const token = await signInAdmin();
    const team = await ensureTeam(token, slug);
    done('team');
    await rotateJoinCode(token, slug, team.id);
    done('join-code');
    const board = await ensureReservedBoard(token, team.id);
    done('reserve-id');
    const user = await ensureUser(token, slug, board);
    done('user');
    await ensureMembership(token, team.id, user.id);
    done('membership');
    const website = await ensureWebsite(token, slug, hostname, team.id);
    done('website');
    const key = await ensureSingleKey(token, tenant, user, done);
    // The second password is never used. Setting it ends the session above, which could
    // otherwise create keys for as long as the first password stood.
    if (!is('keep-password')) await api('POST', `/api/users/${user.id}`, token, { password: random(32) });
    done('discard-password');
    return { teamId: team.id, userId: user.id, websiteId: website.id, key };
  }

  /**
   * Reads back after the user step, without trusting the name lookup alone: the team must have
   * no member left besides its owner (the admin), and the key the caller holds must be refused.
   */
  async function confirmUserGone(token, { findUsers, findTeams, currentKey }) {
    if ((await findUsers()).length > 0) throw new Error('removal incomplete: the service user is still there');
    for (const team of await findTeams()) {
      const members = await api('GET', `/api/teams/${team.id}/users?pageSize=100`, token);
      if (members.data.some(member => member.role !== 'team-owner')) {
        throw new Error('removal incomplete: the team still has a member that is not its owner');
      }
    }
    if (currentKey && (await call('GET', '/api/me', currentKey)).status !== 401) {
      throw new Error('removal incomplete: the key is still accepted');
    }
  }

  /**
   * Removes one tenant. The user goes first: that call alone ends the key. Deleting the team
   * deletes its websites, their data and the reserved board. Umami answers 500 when asked to
   * delete something that is already gone, so each step looks before it deletes.
   *
   * @param {object} tenant
   * @param {string} tenant.slug
   * @param {string} [tenant.currentKey] The key the caller holds; removal fails unless it is refused.
   * @param {string} [tenant.crashAfter] Test only: stop after this step, or after whichever
   *   step runs first when the value is 'first-step'.
   */
  async function remove({ slug: given, currentKey, crashAfter }) {
    const token = await signInAdmin();
    const { team: slug, username } = namesOf(given);
    const findUsers = () => exactMatches(token, '/api/admin/users', 'username', username);
    const findTeams = () => exactMatches(token, '/api/admin/teams', 'name', slug);
    const readBack = !is('remove-no-readback');
    const steps = {
      user: async () => {
        if (is('remove-keep-user')) return;
        for (const user of await findUsers()) await api('DELETE', `/api/users/${user.id}`, token);
        if (readBack) await confirmUserGone(token, { findUsers, findTeams, currentKey });
      },
      team: async () => {
        for (const team of await findTeams()) await api('DELETE', `/api/teams/${team.id}`, token);
        if (readBack && (await findTeams()).length > 0) throw new Error('removal incomplete: the team is still there');
      },
    };
    const order = is('remove-team-first') ? ['team', 'user'] : REMOVE_STEPS;
    const stopAfter = crashAfter === 'first-step' ? order[0] : crashAfter;
    for (const step of order) {
      await steps[step]();
      if (step === stopAfter) throw new Interrupted(step);
    }
  }

  return { provision, remove };
}
