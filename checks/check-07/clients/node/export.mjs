// OpenTelemetry SDK for Node.js: one OTLP/HTTP (protobuf) metrics export per repetition,
// each with its own exporter and its own host name, with the exporter's default settings.
// Usage: node export.mjs '<case as JSON>'   Prints one line: RESULT <json>.
import { setTimeout as sleep } from 'node:timers/promises';

import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const { hosts, port, staggerMs, offsetsMs } = JSON.parse(process.argv[2]);
const ONE_HOUR_MS = 3_600_000;

async function exportOnce(host) {
  const exporter = new OTLPMetricExporter({ url: `http://${host}:${port}/v1/metrics` });
  // The reader only collects here; its interval never fires during the run.
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: ONE_HOUR_MS });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'check-07-node' }),
    readers: [reader],
  });
  provider.getMeter('check-07').createCounter('check07.requests').add(1);
  const { resourceMetrics } = await reader.collect();
  // With offsets, the same exporter sends again later, on whatever connection it kept.
  if (offsetsMs) return { host, sends: await sendAt(exporter, resourceMetrics) };
  return { host, ...(await send(exporter, resourceMetrics)) };
}

async function sendAt(exporter, resourceMetrics) {
  const start = Date.now();
  const sends = [];
  for (const offset of offsetsMs) {
    await sleep(Math.max(0, start + offset - Date.now()));
    sends.push(await send(exporter, resourceMetrics));
  }
  return sends;
}

async function send(exporter, resourceMetrics) {
  const t0 = Date.now();
  const result = await new Promise((resolve) => exporter.export(resourceMetrics, resolve));
  const elapsedMs = Date.now() - t0;
  if (result.code === 0) return { t0, outcome: 'ok', elapsedMs };
  const cause = result.error?.cause?.code || result.error?.code || '';
  const error = `${result.error?.message || 'export failed'} ${cause}`.trim();
  return { t0, outcome: 'error', elapsedMs, error };
}

const running = [];
for (const host of hosts) {
  running.push(exportOnce(host));
  await sleep(staggerMs);
}
const reps = await Promise.all(running);
console.log(`RESULT ${JSON.stringify({ reps })}`);
process.exit(0);
