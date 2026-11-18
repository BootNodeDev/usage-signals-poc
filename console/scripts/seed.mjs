// Applies db/schema.sql, creates the Umami websites and upserts the seeded tenants and sites.
// Safe to run repeatedly.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { requireEnv } from '../lib/config.js';
import { umamiLogin, umamiRequest } from '../lib/umami-admin.js';
import { TENANTS } from './fixtures.mjs';

const SCHEMA_FILE = path.resolve(import.meta.dirname, '..', 'db', 'schema.sql');

async function ensureUmamiWebsite(session, tenant) {
  const { umamiWebsiteId, domain } = tenant.site;
  // Umami answers 200 with a null body for a website that does not exist.
  const existing = await umamiRequest(session, `/api/websites/${umamiWebsiteId}`);
  if (existing.ok && (await existing.json())?.id === umamiWebsiteId) return;
  const created = await umamiRequest(session, '/api/websites', {
    method: 'POST',
    body: JSON.stringify({ id: umamiWebsiteId, name: tenant.name, domain }),
  });
  if (!created.ok) {
    throw new Error(
      `Umami refused to create website ${umamiWebsiteId} (HTTP ${created.status}): ` +
        `${await created.text()}`,
    );
  }
}

async function upsertTenant(client, tenant) {
  await client.query(
    `INSERT INTO usage_signals.tenant (id, name, status) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
    [tenant.id, tenant.name, tenant.status],
  );
  await client.query(
    `INSERT INTO usage_signals.site (id, tenant_id, domain, umami_website_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET domain = EXCLUDED.domain, umami_website_id = EXCLUDED.umami_website_id`,
    [tenant.site.id, tenant.id, tenant.site.domain, tenant.site.umamiWebsiteId],
  );
}

const session = await umamiLogin();
const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL_UNPOOLED') });
await client.connect();
try {
  await client.query(await readFile(SCHEMA_FILE, 'utf8'));
  for (const tenant of TENANTS) {
    await ensureUmamiWebsite(session, tenant);
    await upsertTenant(client, tenant);
  }
} finally {
  await client.end();
}
console.log(`Seeded ${TENANTS.length} tenants: ${TENANTS.map((t) => `${t.name} (${t.status})`).join(', ')}`);
