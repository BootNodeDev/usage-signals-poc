// Sent versus stored for the demo API: calls it, then compares what it answered with what
// /v1/metrics stored for its service, per route and status. Needs the local stack running.
//   npm run demo-api-check -- [calls, 100 by default]
import { closePool, findSiteBySlug } from '../lib/db.js';
import { DEMO_API_SERVICE, handleDemoApi } from '../lib/demo-api.js';
import { createIngestToken } from '../lib/ingest-tokens.js';
import pg from 'pg';

const PROJECT = 'aurora-wallet';
const calls = Number(process.argv[2] ?? 100);
const site = await findSiteBySlug(PROJECT);
process.env.CONSOLE_URL ??= process.env.GATEWAY_URL;
process.env.DEMO_API_INGEST_TOKEN = (await createIngestToken({ project: PROJECT, days: 1 })).token;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const STORED = `SELECT route, status_code AS status, sum(request_count)::int AS n
  FROM usage_signals.api_metric_minute WHERE tenant_id = $1 AND service = $2 GROUP BY 1, 2`;
const count = async () => {
  const { rows } = await db.query(STORED, [site.tenantId, DEMO_API_SERVICE]);
  return new Map(rows.map((row) => [`${row.route} ${row.status}`, row.n]));
};

const before = await count();
const sent = new Map();
const paths = [
  '/demo/api/accounts/7',
  '/demo/api/accounts/4000',
  '/demo/api/prices',
  '/demo/api/health',
];
for (let i = 0; i < calls; i += 1) {
  const path = paths[i % paths.length];
  const response = await handleDemoApi(new Request(`http://local${path}`));
  const route = path.replace(/\d+/, '{id}');
  const key = `${route} ${response.status}`;
  sent.set(key, (sent.get(key) ?? 0) + 1);
}
const after = await count();
console.log('route status | sent | stored');
for (const [key, n] of [...sent].sort()) {
  console.log(`${key} | ${n} | ${(after.get(key) ?? 0) - (before.get(key) ?? 0)}`);
}
await db.end();
await closePool();
process.exit(0);
