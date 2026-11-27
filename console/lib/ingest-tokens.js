// Ingest tokens: the key a project's OpenTelemetry exporter sends to POST /v1/metrics. A token
// is 256 random bits after a `pit_` prefix, stored only as its SHA-256 and shown once; it names
// one project and expires. The product's tokens are signed and checked without the database.
import { createHash, randomBytes } from 'node:crypto';
import {
  findSiteBySlug,
  insertIngestToken,
  listIngestTokens as listStored,
  revokeIngestToken as revokeStored,
  tenantOfIngestToken,
} from './db.js';

const TOKEN_PREFIX = 'pit_';
const TOKEN_FORMAT = /^pit_[A-Za-z0-9_-]{43}$/;
const SHOWN_LENGTH = 12;
const MAX_DAYS = 365;

function sha256(text) {
  return createHash('sha256').update(text).digest();
}

/** Makes a token for the project of the site `project` names, valid for `days`. */
export async function createIngestToken({ project, days }) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`A token lasts 1 to ${MAX_DAYS} days.`);
  }
  const site = await findSiteBySlug(project);
  if (!site) throw new Error(`No project with slug "${project}".`);
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const prefix = token.slice(0, SHOWN_LENGTH);
  const hash = sha256(token);
  const stored = await insertIngestToken({ tenantId: site.tenantId, prefix, hash, days });
  return { token, ...stored };
}

/** Every token with its prefix, project, and creation, expiry and revocation times. */
export function listIngestTokens() {
  return listStored();
}

/** Revokes the token with this prefix. Throws when no token has it or it is already revoked. */
export async function revokeIngestToken(prefix) {
  const outcome = await revokeStored(prefix);
  if (outcome === 'not found') throw new Error(`No token with prefix "${prefix}".`);
  if (outcome === 'already revoked') throw new Error(`The token ${prefix} was already revoked.`);
}

/** `{ tenantId }` for a valid token, else null. */
export async function verifyIngestToken(token) {
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return null;
  return tenantOfIngestToken(sha256(token));
}
