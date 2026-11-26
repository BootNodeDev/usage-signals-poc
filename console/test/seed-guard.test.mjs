// Runs the build script as Vercel would, against the local stack, with one input broken at a
// time. Uses the local profile, so nothing but the usual fixtures is written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';
import { umamiLogin, umamiRequest } from '../lib/umami-admin.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const CONSOLE_ROOT = path.resolve(import.meta.dirname, '..');
const INPUTS = ['DATABASE_URL_UNPOOLED', 'UMAMI_URL', 'UMAMI_ADMIN_PASSWORD'];
const SECRETS = [process.env.DATABASE_URL_UNPOOLED, process.env.UMAMI_ADMIN_PASSWORD];

function runSeed(overrides) {
  const env = { ...process.env, ...overrides };
  for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete env[name];
  const result = spawnSync(process.execPath, ['scripts/seed.mjs'], {
    cwd: CONSOLE_ROOT,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

function assertNoSecret(output, extra = []) {
  for (const secret of [...SECRETS, ...extra]) {
    assert.ok(!output.includes(secret), 'the output contains a secret or a connection string');
  }
}

describe('seed as a build step', () => {
  it('succeeds with the local inputs and without UMAMI_ADMIN_USER', () => {
    const { status, output } = runSeed({ UMAMI_ADMIN_USER: undefined });
    assert.equal(status, 0, output);
    assert.match(output, /Seeded 4 tenants with the local profile/);
    assertNoSecret(output);
  });

  for (const name of INPUTS) {
    it(`fails and names ${name} when it is missing`, () => {
      const { status, output } = runSeed({ [name]: undefined });
      assert.equal(status, 1);
      assert.match(output, new RegExp(`Seed failed: missing environment variable\\(s\\): .*${name}`));
      assertNoSecret(output);
    });
  }

  it('renames a site that still has an old name, slug and host, in our tables and in Umami, and is stable when run twice', async () => {
    const tenant = TENANTS[3];
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
    await client.connect();
    const row = async () =>
      (await client.query(
        `SELECT t.name, s.slug, s.domain FROM usage_signals.site s JOIN usage_signals.tenant t ON t.id = s.tenant_id WHERE s.id = $1`,
        [tenant.site.id],
      )).rows[0];
    const session = await umamiLogin();
    const website = async () => (await umamiRequest(session, `/api/websites/${tenant.site.umamiWebsiteId}`)).json();
    try {
      await client.query(`UPDATE usage_signals.tenant SET name = 'Old name' WHERE id = $1`, [tenant.id]);
      await client.query(`UPDATE usage_signals.site SET slug = 'old-slug', domain = 'old.host.test' WHERE id = $1`, [tenant.site.id]);
      const renamed = await umamiRequest(session, `/api/websites/${tenant.site.umamiWebsiteId}`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Old name', domain: 'old.host.test' }),
      });
      assert.equal(renamed.status, 200);

      for (const run of [1, 2]) {
        const { status, output } = runSeed({});
        assert.equal(status, 0, output);
        assert.deepEqual(await row(), { name: tenant.name, slug: tenant.site.slug, domain: tenant.site.domain }, `run ${run}`);
        const { id, name, domain } = await website();
        assert.deepEqual({ id, name, domain }, { id: tenant.site.umamiWebsiteId, name: tenant.name, domain: tenant.site.domain });
      }
      const count = await client.query(`SELECT count(*)::int AS sites FROM usage_signals.site`);
      assert.equal(count.rows[0].sites, TENANTS.length, 'the rename created a second row');
    } finally {
      await client.end();
    }
  });

  it('applies the schema and seeds no tenant in a preview build, through DATABASE_URL alone', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
    await client.connect();
    try {
      await client.query('DROP TABLE IF EXISTS usage_signals.agent_sighting');
      const { status, output } = runSeed({
        VERCEL: '1', VERCEL_ENV: 'preview', DATABASE_URL_UNPOOLED: undefined, UMAMI_URL: undefined, UMAMI_ADMIN_PASSWORD: undefined,
      });
      assert.equal(status, 0, output);
      assert.match(output, /Seeded 0 tenants with the preview profile/);
      const table = await client.query(`SELECT to_regclass('usage_signals.agent_sighting') AS name`);
      assert.equal(table.rows[0].name, 'usage_signals.agent_sighting');
    } finally {
      await client.end();
    }
  });

  it('fails with a database message when the database is unreachable', () => {
    const unreachable = 'postgresql://poc:hunter2-secret@127.0.0.1:1/poc';
    const { status, output } = runSeed({ DATABASE_URL_UNPOOLED: unreachable });
    assert.equal(status, 1);
    assert.match(output, /Seed failed: cannot reach the database \(ECONNREFUSED\)/);
    assert.match(output, /DATABASE_URL_UNPOOLED/);
    assertNoSecret(output, [unreachable, 'hunter2-secret']);
  });

  it('fails with a login message when Umami refuses the password', () => {
    const { status, output } = runSeed({ UMAMI_ADMIN_PASSWORD: 'wrong-password-secret' });
    assert.equal(status, 1);
    assert.match(output, /Seed failed: Umami refused the login for user "admin" \(HTTP 401\)/);
    assertNoSecret(output, ['wrong-password-secret']);
  });

  it('fails with a message when Umami is unreachable', () => {
    const { status, output } = runSeed({ UMAMI_URL: 'http://127.0.0.1:1' });
    assert.equal(status, 1);
    assert.match(output, /Seed failed: cannot reach Umami/);
    assertNoSecret(output);
  });
});
