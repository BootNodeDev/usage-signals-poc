// Ingest tokens: a project's key for sending API metrics. Shown once, stored as a SHA-256,
// valid until it expires or is revoked.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { requireEnv } from '../lib/config.js';
import {
  createIngestToken,
  listIngestTokens,
  revokeIngestToken,
  verifyIngestToken,
} from '../lib/ingest-tokens.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const TOKEN_FORMAT = /^pit_[A-Za-z0-9_-]{43}$/;
const TENANT = TENANTS[0];
const CONSOLE_ROOT = path.resolve(import.meta.dirname, '..');

describe('ingest tokens', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  after(() => pool.end());

  it('creates a token for one project, shown once and stored as its SHA-256', async () => {
    const created = await createIngestToken({ project: TENANT.site.slug, days: 30 });
    assert.match(created.token, TOKEN_FORMAT);
    assert.equal(created.prefix, created.token.slice(0, 12));
    assert.equal(created.project, TENANT.site.slug);
    const days = (created.expires_at - created.created_at) / 86_400_000;
    assert.ok(Math.abs(days - 30) < 0.01, `expires after ${days} days`);
    const { rows } = await pool.query(
      `SELECT t.token_hash, t.tenant_id, t::text AS whole
         FROM usage_signals.ingest_token t WHERE token_prefix = $1`,
      [created.prefix],
    );
    assert.deepEqual(rows[0].token_hash, createHash('sha256').update(created.token).digest());
    assert.equal(rows[0].tenant_id, TENANT.id);
    assert.ok(!rows[0].whole.includes(created.token.slice(12)));
    const listed = (await listIngestTokens()).find((token) => token.prefix === created.prefix);
    assert.ok(listed && !JSON.stringify(listed).includes(created.token));
  });

  it('accepts a valid token as its tenant, and refuses unknown, revoked, expired', async () => {
    const created = await createIngestToken({ project: TENANT.site.slug, days: 1 });
    assert.deepEqual(await verifyIngestToken(created.token), { tenantId: TENANT.id });
    assert.equal(await verifyIngestToken(`pit_${'A'.repeat(43)}`), null);
    assert.equal(await verifyIngestToken('not-a-token'), null);
    await pool.query(
      `UPDATE usage_signals.ingest_token SET expires_at = now() - interval '1 second'
        WHERE token_prefix = $1`,
      [created.prefix],
    );
    assert.equal(await verifyIngestToken(created.token), null, 'expired');
    const other = await createIngestToken({ project: TENANT.site.slug, days: 1 });
    await revokeIngestToken(other.prefix);
    assert.equal(await verifyIngestToken(other.token), null, 'revoked');
    await assert.rejects(revokeIngestToken(other.prefix), /already revoked/);
    await assert.rejects(revokeIngestToken('pit_nothing1'), /No token with prefix "pit_nothing1"/);
  });

  it('refuses an unknown project and a lifetime that is not 1 to 365 days', async () => {
    await assert.rejects(createIngestToken({ project: 'no-such-project', days: 30 }), /No project/);
    for (const days of [0, 366, 1.5]) {
      await assert.rejects(createIngestToken({ project: TENANT.site.slug, days }), /1 to 365 days/);
    }
  });

  it('is managed with npm run ingest-token', async () => {
    const cli = (...args) =>
      promisify(execFile)(
        process.execPath,
        ['--env-file=local.env', 'scripts/ingest-token.mjs', ...args],
        { cwd: CONSOLE_ROOT },
      );
    const created = await cli('create', '--project', TENANT.site.slug);
    const token = created.stdout.match(/pit_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(token, created.stdout);
    const listed = await cli('list');
    assert.ok(listed.stdout.includes(token.slice(0, 12)) && !listed.stdout.includes(token));
    assert.match((await cli('revoke', token.slice(0, 12))).stdout, /Revoked/);
    const failsWith = (pattern) => (error) => error.code === 1 && pattern.test(error.stderr);
    await assert.rejects(cli('create'), failsWith(/--project is required/));
  });
});
