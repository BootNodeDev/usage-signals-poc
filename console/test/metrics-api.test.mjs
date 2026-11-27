// GET /api/v1/projects: the operator figures for machine consumers, behind an operator API key.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKey, revokeKey } from '../lib/api-keys.js';
import { requireEnv } from '../lib/config.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const GATEWAY = requireEnv('GATEWAY_URL');
const RUN = `metrics-${Date.now()}`;
const CHALLENGE = 'Bearer realm="pulse"';
const INVALID = 'Bearer realm="pulse", error="invalid_token"';

function read(authorization, query = 'days=7', init = {}) {
  const headers = authorization ? { authorization } : {};
  return fetch(`${GATEWAY}/api/v1/projects?${query}`, { headers, ...init });
}

describe('GET /api/v1/projects', () => {
  it('answers 401 with a Bearer challenge when no key is sent', async () => {
    for (const authorization of [null, 'Basic dXNlcjpwYXNz', 'Bearer']) {
      const response = await read(authorization);
      assert.equal(response.status, 401, String(authorization));
      assert.equal(response.headers.get('www-authenticate'), CHALLENGE);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });

  it('answers 401 invalid_token for an unknown or a revoked key', async () => {
    const created = await createKey({ label: `${RUN} revoked`, actor: 'tester' });
    await revokeKey(created.prefix, 'tester');
    for (const key of [`pls_${'B'.repeat(43)}`, 'not-a-key', created.key]) {
      const response = await read(`Bearer ${key}`);
      assert.equal(response.status, 401, key);
      assert.equal(response.headers.get('www-authenticate'), INVALID);
    }
  });

  it('gives a key for every project the figures of every project, not cached', async () => {
    const { key } = await createKey({ label: `${RUN} all`, actor: 'tester' });
    const response = await read(`Bearer ${key}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    const operator = await (await fetch(`${GATEWAY}/api/operator/projects?days=7`)).json();
    assert.equal(body.days, 7);
    assert.deepEqual(body.small_counts, operator.small_counts);
    assert.deepEqual(
      body.projects.map((row) => row.project.slug).sort(),
      operator.projects.map((row) => row.project.slug).sort(),
    );
    const row = body.projects[0];
    assert.deepEqual(Object.keys(row).sort(), Object.keys(operator.projects[0]).sort());
  });

  it('gives a key for one project only that project', async () => {
    const tenant = TENANTS[0];
    const project = tenant.site.slug;
    const { key } = await createKey({ label: `${RUN} one`, project, actor: 'tester' });
    const body = await (await read(`Bearer ${key}`)).json();
    assert.deepEqual(body.projects.map((row) => row.project.slug), [tenant.site.slug]);
  });

  it('answers 400 for an unsupported range and 405 to anything but GET', async () => {
    const { key } = await createKey({ label: `${RUN} errors`, actor: 'tester' });
    assert.equal((await read(`Bearer ${key}`, 'days=14')).status, 400);
    const post = await read(`Bearer ${key}`, 'days=7', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  });
});
