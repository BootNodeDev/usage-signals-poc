// One ingest location. Each failure mode has two ports, one per DNS order, so that every
// connection attempt can be attributed to its case by destination port alone.
// ROLE decides what the ports do:
//   live     answers on all of them
//   failing  answers on 4000, 4010 and 4020; 4001 and 4011 have no listener (refused);
//            4002 and 4012 drop every packet; 4003 and 4013 accept the connection and
//            never answer
//   dead     no listener on any port
// Ports 4100-4159 answer in the live and failing roles; run.mjs fails them at run time with
// an iptables rule, after a client has a connection open (open.mjs).
// Port 4009 has no listener in any role. Every POST and every TCP SYN that arrives is
// written to /scratch/endpoint-<NAME>.jsonl.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createInterface } from 'node:readline';

const { NAME, ROLE } = process.env;
if (!NAME || !['live', 'failing', 'dead'].includes(ROLE)) {
  throw new Error('NAME and ROLE (live, failing or dead) are required');
}
const PORTS = {
  answer: [4000, 4010, 4020],
  refused: [4001, 4011],
  drop: [4002, 4012],
  hang: [4003, 4013],
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type,x-umami-website-id,x-umami-hostname,x-umami-cache',
};
const log = createWriteStream(`/scratch/endpoint-${NAME}.jsonl`, { flags: 'a' });
const write = (record) => log.write(`${JSON.stringify(record)}\n`);

function answer(port) {
  return (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS).end();
      return;
    }
    let bytes = 0;
    request.on('data', (chunk) => (bytes += chunk.length));
    request.on('end', () => {
      write({
        k: 'req',
        t: Date.now(),
        port,
        method: request.method,
        path: request.url,
        host: request.headers.host,
        bytes,
        src: request.socket.remoteAddress,
      });
      const json = (request.headers['content-type'] || '').includes('json');
      const type = json ? 'application/json' : 'application/x-protobuf';
      // An empty body is a valid OTLP protobuf response; the tracker reads JSON.
      response.writeHead(200, { ...CORS, 'content-type': type }).end(json ? '{}' : '');
    });
  };
}

function listenHttp(port) {
  const server = http.createServer(answer(port));
  // The server never closes an idle connection first, so only the client's own limit can.
  server.keepAliveTimeout = 3_600_000;
  return new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
}

function listenSilent(port) {
  const server = net.createServer((socket) => {
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
}

/** Logs every SYN without ACK, retransmissions included. Port and sequence number together
 * identify the connection attempt a packet belongs to. */
function captureSyns() {
  const filter = 'tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn';
  const tcpdump = spawn('tcpdump', ['-p', '-l', '-nn', '-tt', '-i', 'eth0', filter]);
  const line =
    /^(\d+\.\d+) IP (\d+\.\d+\.\d+\.\d+)\.(\d+) > \d+\.\d+\.\d+\.\d+\.(\d+): .*? seq (\d+)/;
  createInterface({ input: tcpdump.stdout }).on('line', (text) => {
    const match = line.exec(text);
    if (!match) return;
    const [, seconds, src, sport, dport, seq] = match;
    const t = Math.round(Number(seconds) * 1000);
    write({ k: 'syn', t, src, dport: +dport, connection: `${sport}/${seq}` });
  });
  tcpdump.on('exit', (code) => {
    throw new Error(`tcpdump exited with code ${code}`);
  });
  return new Promise((resolve) => {
    createInterface({ input: tcpdump.stderr }).on('line', (text) => {
      if (text.includes('listening on')) resolve();
    });
  });
}

const OPEN_PORTS = Array.from({ length: 60 }, (_, index) => 4100 + index);
if (ROLE !== 'dead') await Promise.all(OPEN_PORTS.map(listenHttp));
if (ROLE === 'live') {
  await Promise.all(Object.values(PORTS).flat().map(listenHttp));
}
if (ROLE === 'failing') {
  await Promise.all(PORTS.answer.map(listenHttp));
  for (const port of PORTS.drop) {
    execFileSync('iptables', ['-A', 'INPUT', '-p', 'tcp', '--dport', String(port), '-j', 'DROP']);
  }
  await Promise.all(PORTS.hang.map(listenSilent));
}
await captureSyns();
write({ k: 'ready', t: Date.now(), role: ROLE });
writeFileSync('/tmp/ready', '');
