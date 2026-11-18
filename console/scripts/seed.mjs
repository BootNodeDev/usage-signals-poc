// Applies db/schema.sql, creates the Umami websites, upserts the tenants and sites of the
// profile for this environment and renders the demo pages. Safe to run repeatedly. It is the
// Vercel build command (vercel.json), so its messages must never carry a connection string.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { umamiLogin, umamiRequest } from '../lib/umami-admin.js';
import { writeDemoPages } from './demo-pages.mjs';
import { missingInputs, selectProfile } from './seed-profile.mjs';

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

async function connectDatabase() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try {
    await client.connect();
  } catch (error) {
    // Only the error code: the message of the driver can name the host.
    throw new Error(
      `cannot reach the database (${error.code ?? error.name}). Check DATABASE_URL_UNPOOLED.`,
    );
  }
  return client;
}

async function seedTenants(tenants) {
  const session = await umamiLogin();
  const client = await connectDatabase();
  try {
    await client.query(await readFile(SCHEMA_FILE, 'utf8'));
    for (const tenant of tenants) {
      await ensureUmamiWebsite(session, tenant);
      await upsertTenant(client, tenant);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const missing = missingInputs(process.env);
  if (missing.length > 0) {
    throw new Error(
      `missing environment variable(s): ${missing.join(', ')}. Locally run with ` +
        '--env-file=local.env; on Vercel add them in the project settings.',
    );
  }
  const profile = selectProfile(process.env);
  if (profile.tenants.length > 0) await seedTenants(profile.tenants);
  await writeDemoPages(profile.demo);
  const names = profile.tenants.map((tenant) => `${tenant.name} (${tenant.status})`).join(', ');
  console.log(`Seeded ${profile.tenants.length} tenants with the ${profile.name} profile: ${names}`);
}

try {
  await main();
} catch (error) {
  console.error(`Seed failed: ${error.message}`);
  process.exit(1);
}
