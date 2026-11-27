// Operator API keys from the command line, until operators can sign in to the console:
//   npm run api-key -- create --label <label> [--project <slug>] [--actor <name>]
//   npm run api-key -- list
//   npm run api-key -- revoke <prefix> [--actor <name>]
// Anyone who can run it holds DATABASE_URL, which today only operators have.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { createKey, listKeys, revokeKey } from '../lib/api-keys.js';
import { closePool } from '../lib/db.js';

const USAGE = [
  'Usage: api-key create --label <label> [--project <slug>] [--actor <name>]',
  '       api-key list',
  '       api-key revoke <prefix> [--actor <name>]',
].join('\n');

function when(date) {
  return date ? date.toISOString().slice(0, 16).replace('T', ' ') : '-';
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { label: { type: 'string' }, project: { type: 'string' }, actor: { type: 'string' } },
  });
  const [command, prefix] = positionals;
  const actor = values.actor ?? userInfo().username;
  if (actor === '') throw new Error('--actor must not be empty.');
  if (command === 'create') {
    if (!values.label) throw new Error('--label is required.');
    const project = values.project ?? null;
    const created = await createKey({ label: values.label, project, actor });
    console.log(`Key for ${created.project ?? 'every project'}, labelled "${created.label}":`);
    console.log(created.key);
    console.log('It is shown only now. Store it in a secret manager.');
  } else if (command === 'list') {
    for (const key of await listKeys()) {
      const state = key.revoked_at ? `revoked ${when(key.revoked_at)}` : 'active';
      const scope = key.project ?? 'every project';
      const used = `last used ${when(key.last_used_at)}`;
      const created = `created ${when(key.created_at)}`;
      console.log([key.prefix, key.label, scope, created, used, state].join('  |  '));
    }
  } else if (command === 'revoke' && prefix) {
    const revoked = await revokeKey(prefix, actor);
    console.log(`Revoked ${revoked.prefix} ("${revoked.label}").`);
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
