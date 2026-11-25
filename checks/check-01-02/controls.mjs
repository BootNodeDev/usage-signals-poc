// Negative controls for round two. Runs round2.mjs once unchanged, which must pass, and then
// once per mutation of mutation.mjs. A mutation is caught when the run exits 1 and reports
// the fact that mutation is aimed at as BROKEN. Exits 1 if any mutation is not caught.
//
//   node controls.mjs    about ten minutes; removes the stack at the end
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MUTATIONS } from './mutation.mjs';
import { removeStack } from './stack.mjs';

const ROUND_TWO = path.join(import.meta.dirname, 'round2.mjs');
const scratch = mkdtempSync(path.join(tmpdir(), 'us-check-01-r2-controls-'));

function run(mutation) {
  const flags = mutation ? ['--keep', `--mutate=${mutation}`] : ['--keep'];
  const result = spawnSync(process.execPath, [ROUND_TWO, ...flags], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(path.join(scratch, `${mutation ?? 'unchanged'}.txt`), result.stdout + result.stderr);
  const broken = result.stdout.split('\n').filter((line) => line.startsWith('BROKEN '));
  return { status: result.status, broken: broken.map((line) => line.slice(7).trim()) };
}

let allCaught = false;
try {
  const unchanged = run();
  if (unchanged.status !== 0) {
    throw new Error(`The unchanged run failed (exit ${unchanged.status}); see ${scratch}.`);
  }
  console.log('| mutation | aimed at | exit | caught | other facts broken |\n|---|---|---|---|---|');
  allCaught = true;
  for (const [mutation, fact] of Object.entries(MUTATIONS)) {
    const { status, broken } = run(mutation);
    const caught = status === 1 && broken.includes(fact);
    allCaught &&= caught;
    const others = broken.filter((other) => other !== fact).length;
    console.log(`| ${mutation} | ${fact} | ${status} | ${caught ? 'yes' : 'NO'} | ${others} |`);
  }
} finally {
  removeStack();
}
console.log(`\nOutput of every run (not deleted): ${scratch}`);
process.exit(allCaught ? 0 : 1);
