// Searches everything the experiment writes to disk for visitor addresses and their parts.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { truncateAddress } from './gateway.mjs';
import { mutated } from './mutation.mjs';
import { docker, psql } from './stack.mjs';

// The forms in which an address, or the part of it the design truncates to, could be written.
export function needlesFor(address) {
  const truncated = truncateAddress(address);
  if (address.includes(':')) {
    const groups = address.split(':').slice(0, 3);
    return [address, truncated, `${groups.join(':')}:`, groups.join(''), encodeURIComponent(address)];
  }
  const octets = address.split('.').map(Number);
  const asNumber = octets.reduce((sum, octet) => sum * 256 + octet, 0);
  return [
    address,
    truncated,
    `${octets.slice(0, 3).join('.')}.`,
    octets.join('-'),
    String(asNumber),
    asNumber.toString(16).padStart(8, '0'),
  ];
}

function readDirectory(directory) {
  return readdirSync(directory).map((name) => readFileSync(path.join(directory, name), 'utf8')).join('\n');
}

// The raw files of the database: tables, indexes and the write-ahead log, deleted rows
// included. Returns the search strings that occur in them.
function searchDatabaseFiles(strings) {
  psql('CHECKPOINT');
  const command = 'grep -rhoF -f /dev/stdin /var/lib/postgresql | sort -u';
  return docker(['exec', '-T', 'postgres', 'sh', '-c', command], { input: strings.join('\n') });
}

const UMAMI_SERVICES = ['umami', 'umami-clock', 'umami-defaults'];
const PLANTED_FILE = '/tmp/us-check-planted';

// Files each Umami container has written since it started, outside the database, and the
// search strings found in them. A file is planted first, so that a blind search shows.
function searchFilesWrittenByUmami(strings, plantedString) {
  const files = [];
  let matches = '';
  for (const service of UMAMI_SERVICES) {
    const id = docker(['ps', '-q', service]).trim();
    const inspect = ['inspect', '--format', '{{.State.StartedAt}}', id];
    const startedAt = execFileSync('docker', inspect, { encoding: 'utf8' }).trim();
    const since = mutated('file-scan-misses-new-files') ? new Date(Date.now() + 60_000) : new Date(startedAt);
    const reference = since.toISOString().slice(0, 19).replace('T', ' ');
    // The preloaded clock of `umami-clock` must not reach these commands.
    const run = (command, input) =>
      docker(['exec', '-T', '-e', 'LD_PRELOAD=', service, 'sh', '-c', command], { input });
    run(`echo "${plantedString}" > ${PLANTED_FILE}; touch -d "${reference}" /tmp/us-check-started`);
    const find =
      'find / -xdev -type f -newer /tmp/us-check-started ' +
      '-not -path "/proc/*" -not -path "/sys/*" -not -name us-check-needles 2>/dev/null';
    const written = run(`${find}; true`).split('\n').filter(Boolean);
    files.push(...written.filter((file) => file !== PLANTED_FILE).map((file) => `${service}:${file}`));
    matches += run(`cat > /tmp/us-check-needles; ${find} | xargs grep -hoF -f /tmp/us-check-needles; true`, strings.join('\n'));
  }
  return { files, matches };
}

// One row per place: the needles found there, and whether a string known to be there was
// found, which shows that the search of that place works.
export function scanDisk({ scratch, spoolDirs, gatewayLog, wireLog, needles, planted }) {
  const dump = docker(['exec', '-T', 'postgres', 'pg_dump', '-U', 'check', 'check']);
  const logs = docker(['logs', '--no-color'], { stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(path.join(scratch, 'dump.sql'), dump);
  writeFileSync(path.join(scratch, 'containers.log'), logs);
  const umamiFiles = searchFilesWrittenByUmami([...needles, ...planted], planted[0]);
  const places = {
    'spool files': spoolDirs.map(readDirectory).join('\n'),
    'gateway log': readFileSync(gatewayLog, 'utf8'),
    'forwarder requests': readFileSync(wireLog, 'utf8'),
    'database dump': dump,
    'database files (raw)': searchDatabaseFiles([...needles, ...planted]),
    'container logs': logs,
    'files written by the Umami containers': umamiFiles.matches,
  };
  const rows = Object.entries(places).map(([place, content]) => {
    const text = mutated('scanner-blind') ? '' : content;
    return {
      place,
      found: needles.filter((needle) => text.includes(needle)),
      plantedFound: planted.some((string) => text.includes(string)),
    };
  });
  return { rows, filesWrittenByUmami: umamiFiles.files };
}
