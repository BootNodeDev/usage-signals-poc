// Negative controls of round two: each mutation changes one thing in a copy of this folder
// and runs the phases that should notice. A mutation is caught when the run exits non-zero
// with a failed assertion. Usage: node mutations.mjs   (about 7 minutes; run it alone, it
// uses the same compose project as run.mjs)
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const ROUND_TWO = 'builderBuild,deduplication,keyLifetime,segmentBound,refusalPaths';

const MUTATIONS = [
  { claim: '-', name: 'no change (the copy itself must pass)', phases: ROUND_TWO, edits: [] },
  {
    claim: 'A',
    name: 'the writer adds the counts whether or not the key was new',
    phases: 'deduplication',
    edits: [
      [
        'writer.mjs',
        'const fresh = membersOf(groups.filter((group) => freshKeys.has(group.key)));',
        'const fresh = membersOf(groups);',
      ],
    ],
  },
  {
    claim: 'A',
    name: 'the key leaves out the service instance ID',
    phases: 'deduplication',
    edits: [['writer.mjs', "    point.resource['service.instance.id'] ?? '',\n", '']],
  },
  {
    claim: 'A',
    name: 'the key includes the time of receipt',
    phases: 'deduplication',
    edits: [
      [
        'writer.mjs',
        '    String(point.timeUnixNano),\n',
        "    String(point.timeUnixNano),\n    point.resource['usage_signals.received_at_unix_nano'],\n",
      ],
    ],
  },
  {
    claim: 'A',
    name: 'check, then insert: no unique key, the insert asks first whether the key exists',
    phases: 'deduplication',
    edits: [
      ['dedup.sql', '  numbers    integer NOT NULL,\n  PRIMARY KEY (point_day, key)\n', '  numbers    integer NOT NULL\n'],
      ['writer.mjs', '  ON CONFLICT (point_day, key) DO NOTHING\n', ''],
      [
        'writer.mjs',
        '  ORDER BY k.n\n',
        '  WHERE NOT EXISTS (SELECT 1 FROM usage_signals.api_point_key p\n                    WHERE p.point_day = k.day AND p.key = k.key)\n  ORDER BY k.n\n',
      ],
    ],
  },
  {
    claim: 'A',
    name: 'the keys are written outside the transaction that adds the counts',
    phases: 'deduplication',
    edits: [['writer.mjs', 'await client.query(INSERT_KEYS,', 'await pool.query(INSERT_KEYS,']],
  },
  {
    claim: 'A',
    name: 'copies of a point inside one request are all counted',
    phases: 'deduplication',
    edits: [
      [
        'writer.mjs',
        'if (group.members.some((member) => member.numbers === point.numbers)) copies.push(point);\n    else group.members.push(point);',
        'group.members.push(point);',
      ],
    ],
  },
  {
    claim: 'B',
    name: 'the age check accepts points 30 days older than the keys kept',
    phases: 'keyLifetime',
    edits: [['writer.mjs', '< today() - settings.keyDays\n', '< today() - settings.keyDays - 30\n']],
  },
  {
    claim: 'B',
    name: 'the purge deletes keys two days early',
    phases: 'keyLifetime',
    edits: [['writer.mjs', 'today() - settings.keyDays - 1)', 'today() - settings.keyDays + 1)']],
  },
  {
    claim: 'C',
    name: 'the run uses the contrib image instead of the Builder build',
    phases: 'builderBuild',
    env: { CHECK_EDGE: 'contrib' },
    edits: [],
  },
  {
    claim: 'D',
    name: 'the bound is 40 characters instead of 36',
    phases: 'checkPathRules,segmentBound',
    edits: [['collector.yaml', '"/[^/]{37,}/"', '"/[^/]{41,}/"']],
  },
  {
    claim: 'D',
    name: 'the rule for characters outside printable ASCII is removed',
    phases: 'checkPathRules,segmentBound',
    edits: [
      [
        'collector.yaml',
        '      - replace_pattern(datapoint.attributes["http.route"], "/[^/]*[^ -~][^/]*/", "/{non_ascii}/")\n',
        '',
      ],
    ],
  },
  {
    claim: 'D',
    name: 'the writer does not check the bound',
    phases: 'segmentBound',
    edits: [['writer.mjs', "    segmentRefusal(attributes['http.route']) ??\n", '']],
  },
  {
    claim: 'E',
    name: 'the writer does not record refusals',
    phases: 'refusalPaths',
    edits: [['writer.mjs', '    await countRefusals(client, refused);\n', '']],
  },
  {
    claim: 'E',
    name: 'the body-size cap is 10 MiB instead of 1 MiB',
    phases: 'refusalPaths',
    edits: [['collector.yaml', 'max_request_body_size: 1048576', 'max_request_body_size: 10485760']],
  },
];

const root = mkdtempSync(path.join(tmpdir(), 'us-check-05-r2-mutations-'));
const copy = path.join(root, 'checks', 'check-05');
mkdirSync(path.join(root, 'console', 'db'), { recursive: true });
cpSync(HERE, copy, { recursive: true });
cpSync(path.join(HERE, '../../console/db/schema.sql'), path.join(root, 'console/db/schema.sql'));
console.log(`mutated copies and their output: ${root}`);

function mutate(edits) {
  const originals = new Map();
  for (const [file, from, to] of edits) {
    const target = path.join(copy, file);
    const text = readFileSync(target, 'utf8');
    if (!originals.has(target)) originals.set(target, text);
    if (!text.includes(from)) throw new Error(`${file} does not contain: ${from}`);
    writeFileSync(target, text.replace(from, to));
  }
  return () => originals.forEach((text, target) => writeFileSync(target, text));
}

let wrong = 0;
for (const [i, mutation] of MUTATIONS.entries()) {
  const restore = mutate(mutation.edits);
  const run = spawnSync(process.execPath, ['run.mjs'], {
    cwd: copy,
    env: { ...process.env, CHECK_ONLY: mutation.phases, CHECK_KEEP_STACK: '', ...mutation.env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  restore();
  writeFileSync(path.join(root, `mutation-${i}.log`), `${run.stdout}\n${run.stderr}`);
  const failed = [...run.stdout.matchAll(/^ {2}FAIL \[\w+\] (.*)$/gm)].map((match) => match[1]);
  const expectPass = mutation.edits.length === 0 && !mutation.env;
  const caught = run.status !== 0 && failed.length > 0;
  const good = expectPass ? run.status === 0 : caught;
  if (!good) wrong += 1;
  const verdict = expectPass ? (good ? 'passes' : 'FAILS') : caught ? 'caught' : 'NOT CAUGHT';
  console.log(`${verdict.padEnd(10)} ${mutation.claim}  ${mutation.name}`);
  for (const label of failed.slice(0, 3)) console.log(`             failed: ${label.slice(0, 150)}`);
  if (failed.length > 3) console.log(`             and ${failed.length - 3} more`);
}
console.log(wrong === 0 ? '\nEvery mutation was caught.' : `\n${wrong} result(s) not as required.`);
process.exit(wrong === 0 ? 0 : 1);
