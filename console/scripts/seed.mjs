// Applies db/schema.sql, creates the Umami websites and upserts the tenants and sites of the
// profile for this environment (none in a preview build). Safe to run repeatedly. It is the
// Vercel build command (vercel.json), so its messages must never carry a connection string.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { umamiLogin, umamiRequest } from '../lib/umami-admin.js';
import { missingInputs, selectProfile } from './seed-profile.mjs';

const SCHEMA_FILE = path.resolve(import.meta.dirname, '..', 'db', 'schema.sql');

async function umamiWrite(session, path, body, action) {
  const response = await umamiRequest(session, path, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(`Umami refused to ${action} (HTTP ${response.status}): ${await response.text()}`);
  }
}

// Creates the website, or renames it when a site was renamed or moved to another host.
async function ensureUmamiWebsite(session, tenant) {
  const { umamiWebsiteId: id, domain } = tenant.site;
  const wanted = { name: tenant.name, domain };
  // Umami answers 200 with a null body for a website that does not exist.
  const response = await umamiRequest(session, `/api/websites/${id}`);
  const existing = response.ok ? await response.json() : null;
  if (existing?.id !== id) {
    await umamiWrite(session, '/api/websites', { id, ...wanted }, `create website ${id}`);
  } else if (existing.name !== wanted.name || existing.domain !== wanted.domain) {
    await umamiWrite(session, `/api/websites/${id}`, wanted, `update website ${id}`);
  }
}

async function upsertTenant(client, tenant) {
  await client.query(
    `INSERT INTO usage_signals.tenant (id, name, status) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
    [tenant.id, tenant.name, tenant.status],
  );
  await client.query(
    `INSERT INTO usage_signals.site (id, tenant_id, domain, umami_website_id, slug)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET domain = EXCLUDED.domain, umami_website_id = EXCLUDED.umami_website_id,
           slug = EXCLUDED.slug`,
    [tenant.site.id, tenant.id, tenant.site.domain, tenant.site.umamiWebsiteId, tenant.site.slug],
  );
}

async function connectDatabase(variable) {
  const client = new pg.Client({ connectionString: process.env[variable] });
  try {
    await client.connect();
  } catch (error) {
    // Only the error code: the message of the driver can name the host.
    throw new Error(`cannot reach the database (${error.code ?? error.name}). Check ${variable}.`);
  }
  return client;
}

async function seed({ tenants, databaseVariable }) {
  const session = tenants.length > 0 ? await umamiLogin() : null;
  const client = await connectDatabase(databaseVariable);
  try {
    await client.query(await readFile(SCHEMA_FILE, 'utf8'));
    for (const tenant of tenants) {
      await ensureUmamiWebsite(session, tenant);
      await upsertTenant(client, tenant);
    }
    await client.query('ALTER TABLE usage_signals.site ALTER COLUMN slug SET NOT NULL');
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
  await seed(profile);
  const names = profile.tenants.map((tenant) => `${tenant.name} (${tenant.status})`).join(', ');
  console.log(`Seeded ${profile.tenants.length} tenants with the ${profile.name} profile: ${names}`);
}

try {
  await main();
} catch (error) {
  console.error(`Seed failed: ${error.message}`);
  process.exit(1);
}
