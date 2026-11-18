// Runs the build script as Vercel would, against the local stack, with one input broken at a
// time. Uses the local profile, so nothing but the usual fixtures is written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

const CONSOLE_ROOT = path.resolve(import.meta.dirname, '..');
const INPUTS = ['DATABASE_URL_UNPOOLED', 'UMAMI_URL', 'UMAMI_ADMIN_PASSWORD', 'GATEWAY_URL'];
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
