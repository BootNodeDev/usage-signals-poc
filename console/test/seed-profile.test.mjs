import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TENANTS } from '../scripts/fixtures.mjs';
import {
  PRODUCTION_TENANTS,
  assertSites,
  missingInputs,
  parseDemoSiteHosts,
  selectProfile,
} from '../scripts/seed-profile.mjs';

const LOCAL_ENV = {
  DATABASE_URL_UNPOOLED: 'postgresql://local',
  UMAMI_URL: 'http://127.0.0.1:3301',
  UMAMI_ADMIN_PASSWORD: 'local-password',
};
const HOSTS = 'site-a.usage-signals.org,site-b.usage-signals.org,site-c.usage-signals.org';
const CONSOLE = 'console.usage-signals.org';
const PRODUCTION_ENV = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_PROJECT_PRODUCTION_URL: CONSOLE,
  DEMO_SITE_HOSTS: HOSTS,
  DATABASE_URL_UNPOOLED: 'postgresql://neon',
  UMAMI_URL: 'https://umami.usage-signals.org',
  UMAMI_ADMIN_PASSWORD: 'production-password',
};
const RESERVED = /localhost|\.example$|^127\.|^\[::1\]/;

describe('selectProfile', () => {
  it('uses the four local fixtures outside Vercel', () => {
    const profile = selectProfile(LOCAL_ENV);
    assert.equal(profile.name, 'local');
    assert.deepEqual(profile.tenants, TENANTS);
  });

  it('seeds Demo site A, B and C on the configured hosts and Strata Vault Kit on its own in production', () => {
    const { name, tenants } = selectProfile(PRODUCTION_ENV);
    assert.equal(name, 'production');
    assert.deepEqual(tenants.map((t) => [t.name, t.site.slug, t.status, t.site.domain]), [
      ['Demo site A', 'demo-site-a', 'active', 'site-a.usage-signals.org'],
      ['Demo site B', 'demo-site-b', 'active', 'site-b.usage-signals.org'],
      ['Demo site C', 'demo-site-c', 'active', 'site-c.usage-signals.org'],
      ['Strata Vault Kit', 'strata-vault-kit', 'active', 'strata-vault-kit-app.vercel.app'],
    ]);
    const ids = tenants.flatMap((t) => [t.id, t.site.id, t.site.umamiWebsiteId]);
    assert.equal(new Set(ids).size, 12);
    assert.deepEqual(selectProfile(PRODUCTION_ENV).tenants, tenants, 'ids change between builds');
  });

  it('seeds Strata Vault Kit whatever DEMO_SITE_HOSTS holds', () => {
    const { tenants } = selectProfile({ ...PRODUCTION_ENV, DEMO_SITE_HOSTS: 'site-a.usage-signals.org' });
    assert.deepEqual(tenants.map((t) => t.name), ['Demo site A', 'Strata Vault Kit']);
  });

  it("keeps Demo site A's first ids and the Strata website id its tracker tag carries", () => {
    const { tenants } = selectProfile(PRODUCTION_ENV);
    const [siteA] = tenants;
    assert.equal(siteA.id, 'f0000000-0000-4000-8000-000000000001');
    assert.equal(siteA.site.id, 'f0000000-0000-4000-8000-0000000000f1');
    assert.equal(siteA.site.umamiWebsiteId, 'f0000000-0000-4000-8000-0000000000ff');
    assert.equal(tenants.at(-1).site.umamiWebsiteId, 'f0000000-0000-4000-8000-0000000004ff');
    assert.deepEqual(PRODUCTION_TENANTS.map((t) => t.name), ['Demo site A', 'Demo site B', 'Demo site C']);
  });

  it('never puts a site on the console host, a loopback host or a reserved host', () => {
    for (const tenant of selectProfile(PRODUCTION_ENV).tenants) {
      assert.ok(!RESERVED.test(tenant.site.domain) && tenant.site.domain !== CONSOLE, tenant.site.domain);
    }
  });

  it('never shares an id between production and the local fixtures', () => {
    const localIds = TENANTS.flatMap((local) => [local.id, local.site.id, local.site.umamiWebsiteId]);
    for (const tenant of selectProfile(PRODUCTION_ENV).tenants) {
      for (const id of [tenant.id, tenant.site.id, tenant.site.umamiWebsiteId]) {
        assert.ok(!localIds.includes(id), id);
      }
    }
  });

  it('stops a production build that has no demo host configured', () => {
    for (const value of [undefined, '']) {
      assert.throws(() => selectProfile({ ...PRODUCTION_ENV, DEMO_SITE_HOSTS: value }), /DEMO_SITE_HOSTS.*at least one host/);
    }
  });

  it('seeds nothing in a Vercel preview build', () => {
    const profile = selectProfile({ ...PRODUCTION_ENV, VERCEL_ENV: 'preview', DEMO_SITE_HOSTS: undefined });
    assert.equal(profile.name, 'preview');
    assert.deepEqual(profile.tenants, []);
  });
});

describe('parseDemoSiteHosts', () => {
  it('accepts one to three host names separated by a comma', () => {
    assert.deepEqual(parseDemoSiteHosts('a.usage-signals.org', CONSOLE), ['a.usage-signals.org']);
    assert.deepEqual(parseDemoSiteHosts(HOSTS, CONSOLE), HOSTS.split(','));
  });

  const malformed = {
    'a scheme': 'https://b.usage-signals.org',
    'a path': 'b.usage-signals.org/demo',
    'a port': 'b.usage-signals.org:443',
    'a space after the comma': 'b.usage-signals.org, c.usage-signals.org',
    'an empty item': 'b.usage-signals.org,',
    'upper case': 'B.usage-signals.org',
    'a single label': 'intranet',
    'a wildcard': '*.usage-signals.org',
    'four hosts': `${HOSTS},d.usage-signals.org`,
  };
  for (const [what, value] of Object.entries(malformed)) {
    it(`refuses ${what} and names the variable`, () => {
      assert.throws(() => parseDemoSiteHosts(value, CONSOLE), /DEMO_SITE_HOSTS/);
    });
  }

  it("refuses a host listed twice or equal to the console's own host", () => {
    assert.throws(() => parseDemoSiteHosts('b.usage-signals.org,b.usage-signals.org', CONSOLE), /twice/);
    assert.throws(() => parseDemoSiteHosts(CONSOLE, CONSOLE), /console's own host/);
  });

  it('refuses loopback and reserved hosts', () => {
    for (const host of ['app.localhost', 'drift.example', '127.0.0.1']) {
      assert.throws(() => parseDemoSiteHosts(host, CONSOLE), /DEMO_SITE_HOSTS/, host);
    }
  });
});

describe('assertSites', () => {
  const withSlug = (slug, name = 'Some project') => ({ name, site: { slug, domain: `${slug}.usage-signals.org` } });

  it('accepts lower-case letters, digits and single hyphens', () => {
    assertSites(['demo-site-a', 'a', 'x1', 'site-2-b'].map((slug) => withSlug(slug)));
  });

  for (const reserved of ['api', 'demo', 'operator', 's', 'tenant']) {
    it(`refuses the reserved word "${reserved}" and names the project`, () => {
      assert.throws(() => assertSites([withSlug(reserved, 'Clashing project')]), /"Clashing project" is reserved/);
    });
  }

  it('refuses a malformed slug', () => {
    const slugs = ['Demo', 'demo_site', 'demo--site', '-demo', 'demo-', 'demo site', 'demo.site', '', undefined, 'x'.repeat(64)];
    for (const slug of slugs) {
      assert.throws(() => assertSites([withSlug(slug)]), /must be lower-case letters/, String(slug));
    }
  });

  it('refuses the same slug on two sites', () => {
    assert.throws(() => assertSites([withSlug('same'), withSlug('same')]), /used by two sites/);
  });

  it('refuses a demo host that is the host of a live site', () => {
    const env = { ...PRODUCTION_ENV, DEMO_SITE_HOSTS: 'strata-vault-kit-app.vercel.app' };
    assert.throws(() => selectProfile(env), /domain "strata-vault-kit-app.vercel.app" of "Strata Vault Kit" is used by two sites/);
  });

  it('gives every fixture and every production site a valid slug and its own domain', () => {
    assertSites(TENANTS);
    assertSites(selectProfile(PRODUCTION_ENV).tenants);
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

  const production = ['DEMO_SITE_HOSTS', 'DATABASE_URL_UNPOOLED', 'UMAMI_URL', 'UMAMI_ADMIN_PASSWORD'];
  for (const name of production) {
    it(`names ${name} when it is absent or empty in production`, () => {
      assert.deepEqual(missingInputs({ ...PRODUCTION_ENV, [name]: '' }), [name]);
    });
  }

  it('asks a preview build for nothing', () => {
    assert.deepEqual(missingInputs({ VERCEL: '1', VERCEL_ENV: 'preview' }), []);
  });
});
