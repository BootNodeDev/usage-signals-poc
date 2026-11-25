// Confirms that the fixtures behave as the cases assume, before anything is measured.
// Runs in the DNS container, so that no client address appears in the endpoints' logs.
// Usage: node probe.mjs <live|dead>   (what the second location is expected to be)
import { Resolver } from 'node:dns/promises';
import net from 'node:net';

const FAILING = '10.207.7.10';
const LIVE = '10.207.7.11';
const WAIT_MS = 1500;
const liveExpected = process.argv[2] === 'dead' ? 'refused' : 'answers';

/** One of: answers, refused, no connection, connects then silent. */
function behaviour(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const finish = (text) => {
      socket.destroy();
      resolve(text);
    };
    let connected = false;
    const timer = setTimeout(
      () => finish(connected ? 'connects then silent' : 'no connection'),
      WAIT_MS,
    );
    socket.on('connect', () => {
      connected = true;
      socket.write('POST /probe HTTP/1.1\r\nHost: probe\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('data', (data) => {
      clearTimeout(timer);
      finish(data.toString().startsWith('HTTP/1.1 200') ? 'answers' : 'unexpected answer');
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      finish(error.code === 'ECONNREFUSED' ? 'refused' : error.code);
    });
  });
}

const resolver = new Resolver();
resolver.setServers(['10.207.7.53']);
const order = async (name) => (await resolver.resolve4(name)).join(',');
const expectations = [
  ['DNS df order', await order('probe.df.ingest.test'), `${FAILING},${LIVE}`],
  ['DNS ds order', await order('probe.ds.ingest.test'), `${LIVE},${FAILING}`],
  ['failing :4009', await behaviour(FAILING, 4009), 'refused'],
  ['live :4009', await behaviour(LIVE, 4009), 'refused'],
];
const FAILING_PORTS = {
  answers: [4000, 4010, 4020],
  refused: [4001, 4011],
  'no connection': [4002, 4012],
  'connects then silent': [4003, 4013],
};
for (const [expected, ports] of Object.entries(FAILING_PORTS)) {
  for (const port of ports) {
    expectations.push([`failing :${port}`, await behaviour(FAILING, port), expected]);
    expectations.push([`live :${port}`, await behaviour(LIVE, port), liveExpected]);
  }
}
let failed = false;
for (const [what, got, expected] of expectations) {
  const ok = got === expected;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${got}${ok ? '' : ` (expected ${expected})`}`);
}
process.exit(failed ? 1 : 0);
