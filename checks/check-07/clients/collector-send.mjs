// Posts one OTLP/JSON metrics batch to each of the collector's receivers, one at a time.
// The first receiver is a warm-up: it is retried while the collector starts and its
// pipeline is not measured. With `offsetsMs` every receiver gets one batch per offset; the
// batches of a round have their own metric name, so the endpoints can tell the rounds apart
// by body size. Usage: node collector-send.mjs '<{warmUpPort, ports, staggerMs, offsetsMs}>'
// Prints RESULT {"rounds": [[<ms when the request to each port was sent>]]}.
import { setTimeout as sleep } from 'node:timers/promises';

const { warmUpPort, ports, staggerMs, offsetsMs = [0] } = JSON.parse(process.argv[2]);
const now = `${Date.now()}000000`;
const point = { asInt: '1', timeUnixNano: now, startTimeUnixNano: now };
const sum = { aggregationTemporality: 2, isMonotonic: true, dataPoints: [point] };
const service = { key: 'service.name', value: { stringValue: 'check-07-collector' } };

function batchOf(round) {
  const name = `check07.requests${'.again'.repeat(round)}`;
  const scopeMetrics = [{ scope: { name: 'check-07' }, metrics: [{ name, sum }] }];
  const resource = { attributes: [service] };
  return JSON.stringify({ resourceMetrics: [{ resource, scopeMetrics }] });
}

async function post(port, round = 0) {
  const response = await fetch(`http://10.207.7.24:${port}/v1/metrics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: batchOf(round),
  });
  if (!response.ok) throw new Error(`the collector answered HTTP ${response.status}`);
}

async function warmUp() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await post(warmUpPort);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('the collector did not accept a batch within 30 seconds');
}

await warmUp();
await sleep(2000);
const start = Date.now();
const rounds = [];
for (const [round, offset] of offsetsMs.entries()) {
  await sleep(Math.max(0, start + offset - Date.now()));
  const sent = [];
  for (const port of ports) {
    sent.push(Date.now());
    await post(port, round);
    await sleep(staggerMs);
  }
  rounds.push(sent);
}
console.log(`RESULT ${JSON.stringify({ rounds })}`);
