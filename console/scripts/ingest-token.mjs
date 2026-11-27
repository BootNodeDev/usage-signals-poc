// Ingest tokens from the command line, until projects can sign in to the console:
//   npm run ingest-token -- create --project <slug> [--days <1-365>]
//   npm run ingest-token -- list
//   npm run ingest-token -- revoke <prefix>
import { parseArgs } from 'node:util';
import { closePool } from '../lib/db.js';
import { createIngestToken, listIngestTokens, revokeIngestToken } from '../lib/ingest-tokens.js';

const USAGE = [
  'Usage: ingest-token create --project <slug> [--days <1-365>]',
  '       ingest-token list',
  '       ingest-token revoke <prefix>',
].join('\n');
const DEFAULT_DAYS = '365';

function when(date) {
  return date ? date.toISOString().slice(0, 16).replace('T', ' ') : '-';
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: 'string' }, days: { type: 'string' } },
  });
  const [command, prefix] = positionals;
  if (command === 'create') {
    if (!values.project) throw new Error('--project is required.');
    const days = Number(values.days ?? DEFAULT_DAYS);
    const created = await createIngestToken({ project: values.project, days });
    console.log(`Ingest token for ${created.project}, valid until ${when(created.expires_at)}:`);
    console.log(created.token);
    console.log('It is shown only now. Send it as "Authorization: Bearer <token>".');
  } else if (command === 'list') {
    for (const token of await listIngestTokens()) {
      const state = token.revoked_at ? `revoked ${when(token.revoked_at)}` : 'active';
      const expires = `expires ${when(token.expires_at)}`;
      const created = `created ${when(token.created_at)}`;
      console.log([token.prefix, token.project, created, expires, state].join('  |  '));
    }
  } else if (command === 'revoke' && prefix) {
    await revokeIngestToken(prefix);
    console.log(`Revoked ${prefix}.`);
  } else {
    throw new Error(USAGE);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
