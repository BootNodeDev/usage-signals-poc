// The DNS server and the page origin of the experiment.
// DNS (UDP 53): <anything>.df.ingest.test answers the failing address first, then the live
// one; <anything>.ds.ingest.test answers them in the other order; page.test is this container.
// The answer is never rotated. AAAA and other types get an empty answer. TTL is 5 seconds.
// Every query is written to /scratch/dns.jsonl.
// HTTP (8080): a page that loads the product's tracker file, unmodified, with the ingest
// host taken from the `host` query parameter.
import dgram from 'node:dgram';
import { createWriteStream, readFileSync } from 'node:fs';
import http from 'node:http';

const { ADDR_FAILING, ADDR_LIVE, ADDR_SELF } = process.env;
if (!ADDR_FAILING || !ADDR_LIVE || !ADDR_SELF) throw new Error('addresses are required');
const TYPE_A = 1;
const TTL_SECONDS = 5;
const log = createWriteStream('/scratch/dns.jsonl', { flags: 'a' });

function addressesFor(name) {
  if (name.endsWith('.df.ingest.test')) return [ADDR_FAILING, ADDR_LIVE];
  if (name.endsWith('.ds.ingest.test')) return [ADDR_LIVE, ADDR_FAILING];
  if (name === 'page.test') return [ADDR_SELF];
  return null;
}

function readQuestion(message) {
  const labels = [];
  let offset = 12;
  while (message[offset] !== 0) {
    const length = message[offset];
    labels.push(message.toString('latin1', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  const type = message.readUInt16BE(offset + 1);
  return { name: labels.join('.').toLowerCase(), type, end: offset + 5 };
}

function buildAnswer(query, question, addresses) {
  const known = addresses !== null;
  const records = known && question.type === TYPE_A ? addresses : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  // Response, authoritative, recursion available; RD copied; NXDOMAIN for unknown names.
  header.writeUInt16BE(0x8480 | (query.readUInt16BE(2) & 0x0100) | (known ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  const parts = [header, query.subarray(12, question.end)];
  for (const address of records) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(TYPE_A, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(TTL_SECONDS, 6);
    record.writeUInt16BE(4, 10);
    Buffer.from(address.split('.').map(Number)).copy(record, 12);
    parts.push(record);
  }
  return Buffer.concat(parts);
}

const socket = dgram.createSocket('udp4');
socket.on('message', (query, remote) => {
  if (query.length < 17 || query.readUInt16BE(4) !== 1) return;
  const question = readQuestion(query);
  const record = { t: Date.now(), src: remote.address, name: question.name, type: question.type };
  log.write(`${JSON.stringify(record)}\n`);
  const answer = buildAnswer(query, question, addressesFor(question.name));
  socket.send(answer, remote.port, remote.address);
});
socket.bind(53, '0.0.0.0');

const tracker = readFileSync('/tracker/t.js');
const WEBSITE_ID = '00000000-0000-4000-8000-000000000007';

http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://page.test');
    if (url.pathname === '/t.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(tracker);
      return;
    }
    const host = url.searchParams.get('host') || '';
    if (url.pathname !== '/' || !/^http:\/\/[a-z0-9.-]+:\d+$/.test(host)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><title>check-07</title>
<script defer src="/t.js" data-website-id="${WEBSITE_ID}" data-host-url="${host}"></script>
<p>check-07</p>`,
    );
  })
  .listen(8080, '0.0.0.0');
