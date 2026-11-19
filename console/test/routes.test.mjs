// The routes of the console as a browser sees them: clean paths, the per-host demo site, and
// pages that carry no sample data.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { requireEnv } from '../lib/config.js';
import { TENANTS } from '../scripts/fixtures.mjs';

const PUBLIC_ROOT = path.resolve(import.meta.dirname, '..', 'public');
const GATEWAY = requireEnv('GATEWAY_URL');
const TENANT_SCREENS = ['web', 'requests', 'setup'];
const OPERATOR_SCREENS = ['operator/projects', 'operator/access'];
const OLD_SAMPLE_STRINGS = [
  'Sample data', 'Trustless Work', 'Northwind', 'Soroswap', 'Blend Capital', 'GSAMPLE', 'fund.example',
  'usagesignals.example', 'prj_', 'invented', 'Demo control', 'Sample view', 'notices@example.org', 'reviewer@', 'Signed in with a Stellar wallet',
];

// fetch() does not let a caller choose the Host header; node:http does.
function getAsHost(host, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, GATEWAY);
    const request = http.get({ host: url.hostname, port: url.port, path: pathname, headers: { host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
}

async function get(pathname) {
  const response = await fetch(`${GATEWAY}${pathname}`, { redirect: 'manual' });
  return { status: response.status, type: response.headers.get('content-type'), location: response.headers.get('location'), text: await response.text() };
}

describe('tenant console, addressed by project', () => {
  for (const screen of TENANT_SCREENS) {
    it(`serves the one ${screen} page at /<slug>/${screen} for every project`, async () => {
      const page = await readFile(path.join(PUBLIC_ROOT, 'tenant', `${screen}.html`), 'utf8');
      for (const tenant of TENANTS) {
        const answer = await get(`/${tenant.site.slug}/${screen}`);
        assert.equal(answer.status, 200, tenant.site.slug);
        assert.match(answer.type, /text\/html/);
        assert.equal(answer.text, page);
      }
    });
  }

  it('serves the same page for a slug nobody has; the page then asks the API, which says 404', async () => {
    assert.equal((await get('/no-such-project/web')).status, 200);
    assert.equal((await get('/api/tenant/no-such-project/project')).status, 404);
  });

  it('takes the project from the path and from nowhere else', async () => {
    const seam = await readFile(path.join(PUBLIC_ROOT, 'data.js'), 'utf8');
    assert.match(seam, /function currentProjectSlug\(\) \{\s+var first = window\.location\.pathname\.split\('\/'\)\[1\]/);
    assert.equal(seam.match(/window\.location/g).length, 1, 'the address is read in more than one place');
    for (const file of await publicFiles()) {
      const text = await readFile(path.join(PUBLIC_ROOT, file), 'utf8');
      for (const banned of ['location.search', 'URLSearchParams', '?site=', '?project=', 'demo-project']) {
        assert.ok(!text.includes(banned), `${file} contains ${banned}`);
      }
      if (file !== 'data.js') assert.ok(!text.includes('location.pathname'), `${file} reads the path itself`);
    }
  });
});

describe('operator console', () => {
  for (const screen of OPERATOR_SCREENS) {
    it(`serves /${screen} and redirects /${screen}.html to it with 308`, async () => {
      const answer = await get(`/${screen}`);
      assert.equal(answer.status, 200);
      assert.match(answer.text, /<title>[^<]*Operator · Usage Signals<\/title>/);
      const old = await get(`/${screen}.html`);
      assert.equal(old.status, 308);
      assert.equal(old.location, `/${screen}`);
    });
  }
});

describe('other paths', () => {
  it('shows a plain page at / that names no project and links nowhere', async () => {
    const root = await get('/');
    assert.equal(root.status, 200);
    assert.match(root.text, /opened from a project's own address/);
    assert.ok(!/<a\s|<script|operator/i.test(root.text));
  });

  it('answers 404 for unknown paths, old screen names and paths outside public', async () => {
    const paths = ['/nope', '/web', '/projects', '/operator', '/tenant-web', '/aurora-wallet', '/aurora-wallet/nope',
      '/aurora-wallet/web/extra', '/aurora-wallet/projects', '/%2e%2e/package.json'];
    for (const pathname of paths) assert.equal((await get(pathname)).status, 404, pathname);
  });

  it('keeps /api, /demo and the shared files ahead of the project routes', async () => {
    assert.match((await get('/api/web')).type, /application\/json/);
    assert.equal((await get('/demo/web')).status, 404);
    for (const pathname of ['/styles.css', '/app.js', '/charts.js', '/data.js', '/s/manifest.json']) {
      assert.equal((await get(pathname)).status, 200, pathname);
    }
  });
});

describe('demo site per host', () => {
  const active = TENANTS.filter((tenant) => tenant.status === 'active');

  it('gives each registered host a page tagged with its own website id', async () => {
    const titles = new Set();
    for (const tenant of active) {
      const { status, body } = await getAsHost(tenant.site.domain, '/demo/');
      assert.equal(status, 200, tenant.site.domain);
      assert.ok(body.includes(`data-website-id="${tenant.site.umamiWebsiteId}"`), tenant.site.domain);
      for (const other of active.filter((candidate) => candidate !== tenant)) {
        assert.ok(!body.includes(other.site.umamiWebsiteId), `${tenant.site.domain} carries another site's id`);
      }
      assert.ok(body.includes(tenant.name));
      titles.add(body.match(/<title>([^<]*)<\/title>/)[1]);
    }
    assert.equal(titles.size, active.length);
  });

  it('gives each site two pages of its own, linked from its home page', async () => {
    const seen = new Set();
    for (const tenant of active) {
      const home = await getAsHost(tenant.site.domain, '/demo/');
      const links = [...home.body.matchAll(/href="(\/demo\/[a-z-]+)"/g)].map((match) => match[1]);
      assert.equal(links.length, 2, tenant.site.domain);
      for (const link of links) {
        const page = await getAsHost(tenant.site.domain, link);
        assert.equal(page.status, 200, link);
        assert.ok(page.body.includes(`data-website-id="${tenant.site.umamiWebsiteId}"`));
        assert.ok(page.body.includes('href="/demo/"'));
      }
      seen.add(links.join(' '));
      assert.ok(home.body.includes('href="https://stellar.org/"'));
    }
    assert.ok(seen.size >= Math.min(3, active.length), 'the demo sites share the same pages');
  });

  it('answers 404 on a host that is not a registered active site, and for an unknown page', async () => {
    const suspended = TENANTS.find((tenant) => tenant.status === 'suspended');
    for (const host of ['localhost:4300', 'evil.example', 'console.usage-signals.org', suspended.site.domain]) {
      assert.equal((await getAsHost(host, '/demo/')).status, 404, host);
    }
    assert.equal((await getAsHost(active[0].site.domain, '/demo/not-a-page')).status, 404);
  });
});

async function publicFiles() {
  const names = await readdir(PUBLIC_ROOT, { recursive: true });
  return names.filter((name) => /\.(html|js)$/.test(name) && !name.startsWith('s/'));
}

describe('no sample data', () => {
  it('ships no page or script with the old sample content or an old file name', async () => {
    const files = await publicFiles();
    assert.deepEqual(
      files.filter((name) => name.endsWith('.html')).sort(),
      ['index', 'operator/access', 'operator/projects', 'tenant/requests', 'tenant/setup', 'tenant/web'].map((s) => `${s}.html`),
    );
    for (const file of files) {
      const text = await readFile(path.join(PUBLIC_ROOT, file), 'utf8');
      for (const sample of OLD_SAMPLE_STRINGS) {
        assert.ok(!text.includes(sample), `${file} still contains "${sample}"`);
      }
      assert.ok(!/\.html\b/.test(text), `${file} names a .html file`);
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(text), `${file} hardcodes an id`);
      assert.ok(!/umami/i.test(text), `${file} mentions Umami`);
    }
  });
});

describe('two separate consoles', () => {
  it('keeps every operator path out of the tenant pages and every tenant path out of the operator pages', async () => {
    for (const screen of TENANT_SCREENS) {
      const text = await readFile(path.join(PUBLIC_ROOT, 'tenant', `${screen}.html`), 'utf8');
      assert.ok(!text.includes('/operator'), `${screen} links to the operator console`);
    }
    for (const screen of OPERATOR_SCREENS) {
      const text = await readFile(path.join(PUBLIC_ROOT, `${screen}.html`), 'utf8');
      assert.ok(!/\/(web|requests|setup)\b/.test(text), `/${screen} links to the tenant console`);
      assert.ok(!text.includes('/api/tenant'), `/${screen} reads a tenant endpoint`);
    }
  });

  it('builds each navigation from its own list only', async () => {
    const app = await readFile(path.join(PUBLIC_ROOT, 'app.js'), 'utf8');
    const tenantNav = app.match(/TENANT_NAV = \[([^\]]*)\]/)[1];
    const operatorNav = app.match(/OPERATOR_NAV = \[([^\]]*)\]/)[1];
    assert.ok(!/operator/.test(tenantNav));
    assert.ok(!/'\/(web|requests|setup)'/.test(operatorNav));
  });
});
