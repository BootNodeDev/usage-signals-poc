// Operator API keys for machine consumers. A key is 256 random bits after a `pls_` prefix, so it
// is easy to spot in a leak; only its SHA-256 is stored, because a key that random cannot be
// guessed and a slow hash would cost every request. It is shown once, when it is made.
import { createHash, randomBytes } from 'node:crypto';
import {
  findSiteBySlug,
  insertApiKey,
  listApiKeys,
  listSites,
  revokeApiKey,
  useApiKey,
} from './db.js';

const KEY_PREFIX = 'pls_';
const KEY_FORMAT = /^pls_[A-Za-z0-9_-]{43}$/;
// Shown in listings to tell keys apart: the prefix and 8 characters, 48 of the key's 256 bits.
const SHOWN_LENGTH = 12;

function sha256(text) {
  return createHash('sha256').update(text).digest();
}

/**
 * Makes a key for every project, or for the project of the site `project` names, and records who
 * made it. Returns `{ key, prefix, label, project, ... }`; `key` is never available again.
 */
export async function createKey({ label, project = null, actor }) {
  let tenantId = null;
  if (project !== null) {
    const site = await findSiteBySlug(project);
    if (!site) throw new Error(`No project with slug "${project}".`);
    // A key reads a whole project; with several sites the slug would not say what it reads.
    const sites = (await listSites()).filter((other) => other.tenantId === site.tenantId);
    if (sites.length > 1) {
      throw new Error(`The project of "${project}" has several sites; a key reads all of them.`);
    }
    tenantId = site.tenantId;
  }
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');
  const prefix = key.slice(0, SHOWN_LENGTH);
  const stored = await insertApiKey({ label, tenantId, prefix, hash: sha256(key), actor });
  return { key, ...stored };
}

/** Every key with its prefix, label, project, and creation, last use and revocation times. */
export function listKeys() {
  return listApiKeys();
}

/** Revokes the key with this prefix. Throws when no key has it or it is already revoked. */
export async function revokeKey(prefix, actor) {
  const found = await revokeApiKey(prefix, actor);
  if (!found) throw new Error(`No key with prefix "${prefix}".`);
  if (found.was_revoked) throw new Error(`The key ${prefix} was already revoked.`);
  const { was_revoked: _, ...key } = found;
  return key;
}

/**
 * The key's `{ id, tenantId, requests, secondsLeft }` when it is valid and not revoked, else
 * null. `requests` counts this request among the key's of this minute; past `limit` it is
 * `limit + 1` and nothing is recorded.
 */
// The per-minute count is a PostgreSQL integer; no limit is this high.
const NO_LIMIT = 2_147_483_646;

export async function verifyKey(key, limit = NO_LIMIT) {
  if (typeof key !== 'string' || !KEY_FORMAT.test(key)) return null;
  return useApiKey(sha256(key), limit);
}
