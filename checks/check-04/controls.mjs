#!/usr/bin/env node
// Negative controls for round two. Each mutation removes one safeguard from the worker, or plants
// one leak; round-two.mjs must then exit non-zero and mark rows of the item that safeguard serves.
// Runs them one after another on the same compose project and prints which were caught.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HERE } from './harness.mjs';

const CONTROLS = [
  ['keep-password', 'A', 'the worker does not replace the password it signed in with'],
  ['no-team-lookup', 'B', 'the worker creates the team without looking for an existing one'],
  ['keep-old-keys', 'B', 'the worker does not delete the keys it replaces'],
  ['exact-name-match', 'B', 'the worker sends and matches names as given, not as Umami stores them'],
  ['remove-team-first', 'C', 'removal deletes the team before the user'],
  ['remove-keep-user', 'C', 'removal never deletes the service user'],
  ['remove-no-readback', 'C', 'removal reports success without reading back'],
  ['keep-join-code', 'D', 'the worker leaves the join code the team was created with'],
  ['no-id-reservation', 'E', 'the worker creates the service user without reserving its id'],
  ['leak-membership', 'F', 'service user A is also made a member of team B before the matrix'],
];

const only = process.argv.slice(2);
const selected = CONTROLS.filter(([name]) => only.length === 0 || only.includes(name));
let missed = 0;

console.log('| mutation | serves | what it does | exit | rows that failed, by item | caught |');
console.log('|---|---|---|---|---|---|');
for (const [name, item, what] of selected) {
  const run = spawnSync(process.execPath, [join(HERE, 'round-two.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CHECK_04_MUTATION: name },
    maxBuffer: 64 * 1024 * 1024,
  });
  const failed = run.stdout.split('\n').filter(line => line.endsWith('| FAIL |'));
  const byItem = {};
  for (const line of failed) {
    const group = line.split(' | ')[1][0];
    byItem[group] = (byItem[group] ?? 0) + 1;
  }
  const summary = Object.entries(byItem).map(([group, count]) => `${group}: ${count}`).join(', ') || 'none';
  const aborted = run.stderr.includes('NOT ESTABLISHED') ? ' (run aborted)' : '';
  const caught = run.status !== 0 && (byItem[item] ?? 0) > 0;
  if (!caught) missed += 1;
  console.log(`| ${name} | ${item} | ${what} | ${run.status} | ${summary}${aborted} | ${caught ? 'yes' : 'NO'} |`);
}
console.log(`\n${selected.length - missed} of ${selected.length} mutations caught`);
process.exit(missed === 0 ? 0 : 1);
