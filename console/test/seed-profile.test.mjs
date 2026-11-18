import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderDemoPages } from '../scripts/demo-pages.mjs';
import { TENANTS } from '../scripts/fixtures.mjs';
import {
  PRODUCTION_WEBSITE_ID,
  missingInputs,
  selectProfile,
} from '../scripts/seed-profile.mjs';

const LOCAL_ENV = {
  DATABASE_URL_UNPOOLED: 'postgresql://local',
  UMAMI_URL: 'http://127.0.0.1:3301',
  UMAMI_ADMIN_PASSWORD: 'local-password',
  GATEWAY_URL: 'http://localhost:4300',
};
const PRODUCTION_ENV = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: 'console.usage-signals.org',
  DATABASE_URL_UNPOOLED: 'postgresql://neon',
  UMAMI_URL: 'https://umami.usage-signals.org',
  UMAMI_ADMIN_PASSWORD: 'production-password',
};
const MANIFEST = { path: '/s/3.5.0-abcdef12/t.js', integrity: 'sha384-AAAA' };

describe('selectProfile', () => {
  it('uses the four local fixtures outside Vercel', () => {
    const profile = selectProfile(LOCAL_ENV);
    assert.equal(profile.name, 'local');
    assert.deepEqual(profile.tenants, TENANTS);
    assert.deepEqual(profile.demo, {
      websiteId: TENANTS[0].site.umamiWebsiteId,
      gatewayOrigin: 'http://localhost:4300',
    });
  });

  it('uses one tenant on the production host in a Vercel production build', () => {
    const profile = selectProfile(PRODUCTION_ENV);
    assert.equal(profile.name, 'production');
    assert.equal(profile.tenants.length, 1);
    const [tenant] = profile.tenants;
    assert.equal(tenant.name, 'Usage Signals demo');
    assert.equal(tenant.status, 'active');
    assert.equal(tenant.site.domain, 'console.usage-signals.org');
    assert.equal(tenant.site.umamiWebsiteId, PRODUCTION_WEBSITE_ID);
    assert.deepEqual(profile.demo, {
      websiteId: PRODUCTION_WEBSITE_ID,
      gatewayOrigin: 'https://console.usage-signals.org',
    });
  });

  it('never shares an id between the production tenant and the local fixtures', () => {
    const [tenant] = selectProfile(PRODUCTION_ENV).tenants;
    const localIds = TENANTS.flatMap((local) => [local.id, local.site.id, local.site.umamiWebsiteId]);
    for (const id of [tenant.id, tenant.site.id, tenant.site.umamiWebsiteId]) {
      assert.ok(!localIds.includes(id), id);
    }
  });

  it('refuses a loopback or reserved production host', () => {
    const hosts = ['localhost', 'localhost:4300', 'app.localhost', '127.0.0.1', 'drift.example', 'EXAMPLE'];
    for (const host of hosts) {
      const env = { ...PRODUCTION_ENV, VERCEL_PROJECT_PRODUCTION_URL: host };
      assert.throws(() => selectProfile(env), /VERCEL_PROJECT_PRODUCTION_URL/, host);
    }
  });

  it('seeds nothing in a Vercel preview build but still points the demo at production', () => {
    const profile = selectProfile({ ...PRODUCTION_ENV, VERCEL_ENV: 'preview' });
    assert.equal(profile.name, 'preview');
    assert.deepEqual(profile.tenants, []);
    assert.equal(profile.demo.websiteId, PRODUCTION_WEBSITE_ID);
  });
});

describe('missingInputs', () => {
  it('reports nothing when every input is present, without UMAMI_ADMIN_USER', () => {
    assert.deepEqual(missingInputs(LOCAL_ENV), []);
    assert.deepEqual(missingInputs(PRODUCTION_ENV), []);
  });

  for (const name of Object.keys(LOCAL_ENV)) {
    it(`names ${name} when it is absent locally`, () => {
      const { [name]: _removed, ...env } = LOCAL_ENV;
      assert.deepEqual(missingInputs(env), [name]);
    });
  }

  const production = ['VERCEL_PROJECT_PRODUCTION_URL', 'DATABASE_URL_UNPOOLED', 'UMAMI_URL', 'UMAMI_ADMIN_PASSWORD'];
  for (const name of production) {
    it(`names ${name} when it is absent or empty in production`, () => {
      assert.deepEqual(missingInputs({ ...PRODUCTION_ENV, [name]: '' }), [name]);
    });
  }

  it('asks a preview build only for the production host', () => {
    assert.deepEqual(missingInputs({ VERCEL: '1', VERCEL_ENV: 'preview' }), [
      'VERCEL_PROJECT_PRODUCTION_URL',
    ]);
  });
});

describe('renderDemoPages', () => {
  const pages = renderDemoPages({ ...selectProfile(PRODUCTION_ENV).demo, manifest: MANIFEST });

  it('renders two pages that link to each other and one outbound link', () => {
    assert.deepEqual(Object.keys(pages).sort(), ['about.html', 'index.html']);
    assert.ok(pages['index.html'].includes('href="about.html"'));
    assert.ok(pages['about.html'].includes('href="./"'));
    for (const html of Object.values(pages)) assert.ok(html.includes('href="https://stellar.org/"'));
  });

  it('carries the pinned tag for the site the production seed registers', () => {
    for (const html of Object.values(pages)) {
      assert.ok(html.includes('src="https://console.usage-signals.org/s/3.5.0-abcdef12/t.js"'));
      assert.ok(html.includes('integrity="sha384-AAAA"'));
      assert.ok(html.includes('crossorigin="anonymous"'));
      assert.ok(html.includes('data-host-url="https://console.usage-signals.org"'));
      assert.ok(html.includes(`data-website-id="${PRODUCTION_WEBSITE_ID}"`));
      assert.ok(!/localhost|\.example/.test(html));
    }
  });
});
