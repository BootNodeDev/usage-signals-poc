// Operator API keys: a key is shown once, only its SHA-256 is stored, it can be scoped to one
// project and revoked, and every create and revoke leaves an audit row.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { createKey, listKeys, revokeKey, verifyKey } from '../lib/api-keys.js';
import { requireEnv } from '../lib/config.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const run = promisify(execFile);
const CONSOLE_ROOT = path.resolve(import.meta.dirname, '..');
const KEY_FORMAT = /^pls_[A-Za-z0-9_-]{43}$/;
const RUN = `test-${Date.now()}`;

function sha256(text) {
  return createHash('sha256').update(text).digest();
}

describe('operator API keys', () => {
  const pool = new pg.Pool({ connectionString: requireEnv('DATABASE_URL') });
  after(() => pool.end());

  async function auditOf(prefix) {
    const { rows } = await pool.query(
      `SELECT actor, action FROM usage_signals.operator_audit WHERE subject = $1 ORDER BY id`,
      [prefix],
    );
    return rows;
  }

  it('creates a key that is shown once and stored only as its SHA-256', async () => {
    const created = await createKey({ label: `${RUN} all`, actor: 'tester' });
    assert.match(created.key, KEY_FORMAT);
    assert.equal(created.prefix, created.key.slice(0, 12));
    assert.equal(created.project, null);
    const { rows } = await pool.query(
      `SELECT k.*, k::text AS whole FROM usage_signals.operator_api_key k WHERE key_prefix = $1`,
      [created.prefix],
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].key_hash, sha256(created.key));
    assert.ok(!rows[0].whole.includes(created.key.slice(12)), 'the key is stored in plain text');
    const audit = await auditOf(created.prefix);
    assert.deepEqual(audit, [{ actor: 'tester', action: 'api_key.create' }]);
  });

  it('lists keys by prefix and never returns the key itself', async () => {
    const created = await createKey({ label: `${RUN} listed`, actor: 'tester' });
    const listed = (await listKeys()).find((key) => key.prefix === created.prefix);
    assert.deepEqual(Object.keys(listed).sort(), [
      'created_at', 'label', 'last_used_at', 'prefix', 'project', 'revoked_at',
    ]);
    assert.ok(!JSON.stringify(await listKeys()).includes(created.key));
  });

  it('scopes a key to one project, and refuses an unknown project', async () => {
    const tenant = TENANTS[0];
    const project = tenant.site.slug;
    const created = await createKey({ label: `${RUN} one`, project, actor: 'tester' });
    assert.equal(created.project, tenant.site.slug);
    assert.equal((await verifyKey(created.key)).tenantId, tenant.id);
    await assert.rejects(
      createKey({ label: `${RUN} none`, project: 'no-such-project', actor: 'tester' }),
      /No project with slug "no-such-project"/,
    );
  });

  it('accepts a valid key, records its use, and refuses unknown and malformed ones', async () => {
    const created = await createKey({ label: `${RUN} used`, actor: 'tester' });
    const accepted = await verifyKey(created.key);
    assert.equal(accepted.tenantId, null);
    const listed = (await listKeys()).find((key) => key.prefix === created.prefix);
    assert.ok(listed.last_used_at instanceof Date);
    assert.equal(await verifyKey(`pls_${'A'.repeat(43)}`), null);
    assert.equal(await verifyKey('not-a-key'), null);
    assert.equal(await verifyKey(''), null);
  });

  it('revokes a key once, refuses it afterwards, and audits the revocation', async () => {
    const created = await createKey({ label: `${RUN} revoked`, actor: 'tester' });
    const revoked = await revokeKey(created.prefix, 'auditor');
    assert.equal(revoked.prefix, created.prefix);
    assert.ok(revoked.revoked_at instanceof Date, 'revoked_at is the time of the revocation');
    assert.equal(await verifyKey(created.key), null);
    await assert.rejects(revokeKey(created.prefix, 'auditor'), /already revoked/);
    await assert.rejects(revokeKey('pls_nothing1', 'auditor'), /No key with prefix "pls_nothing1"/);
    assert.deepEqual(await auditOf(created.prefix), [
      { actor: 'tester', action: 'api_key.create' },
      { actor: 'auditor', action: 'api_key.revoke' },
    ]);
  });
});

describe('npm run api-key', () => {
  const cli = (...args) =>
    run(
      process.execPath,
      ['--env-file=local.env', '--env-file-if-exists=.env.local', 'scripts/api-key.mjs', ...args],
      { cwd: CONSOLE_ROOT },
    );

  it('prints a new key once, lists it without the key, and revokes it', async () => {
    const created = await cli('create', '--label', `${RUN} cli`, '--actor', 'cli-tester');
    const key = created.stdout.match(/pls_[A-Za-z0-9_-]{43}/)?.[0];
    assert.ok(key, created.stdout);
    const listed = await cli('list');
    assert.ok(listed.stdout.includes(key.slice(0, 12)));
    assert.ok(!listed.stdout.includes(key));
    const revoked = await cli('revoke', key.slice(0, 12), '--actor', 'cli-tester');
    assert.match(revoked.stdout, /Revoked/);
    assert.equal(await verifyKey(key), null);
  });

  it('exits with a clear message for a missing label or an unknown command', async () => {
    const failsWith = (pattern) => (error) => error.code === 1 && pattern.test(error.stderr);
    await assert.rejects(cli('create'), failsWith(/--label is required/));
    await assert.rejects(cli('rotate'), failsWith(/Usage: api-key/));
    const empty = cli('create', '--label', 'x', '--actor', '');
    await assert.rejects(empty, failsWith(/^--actor must not be empty\.$/m));
  });
});
