// The tenant side of check 05: a small HTTP service instrumented with the OpenTelemetry SDK.
// It exports metrics over OTLP/HTTP (protobuf) with the temporality given in
// CHECK_TEMPORALITY, and carries the tenant token in the exporter's own headers.
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { context, metrics } = require('@opentelemetry/api');
const { getRPCMetadata } = require('@opentelemetry/core');
const { AggregationTemporalityPreference } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');

const temporality = {
  delta: AggregationTemporalityPreference.DELTA,
  cumulative: AggregationTemporalityPreference.CUMULATIVE,
}[process.env.CHECK_TEMPORALITY];
if (temporality === undefined) throw new Error('CHECK_TEMPORALITY must be delta or cumulative');

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
const exporter = new OTLPMetricExporter({
  url: `${process.env.CHECK_COLLECTOR}/v1/metrics`,
  headers: { authorization: `Bearer ${process.env.CHECK_TOKEN}` },
  temporalityPreference: temporality,
});
const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({
    'service.name': process.env.CHECK_SERVICE_NAME,
    // A tenant cannot name itself: the collector replaces this value.
    'tenant.id': 'set-by-the-client',
  }),
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 1000 })],
});
metrics.setGlobalMeterProvider(meterProvider);
registerInstrumentations({ instrumentations: [new HttpInstrumentation()], meterProvider });

// Required after the instrumentation is registered, so that the module is patched.
const http = require('node:http');

// An unrelated metric, as a real service would have.
const jobs = metrics.getMeter('check-05').createCounter('jobs.processed');

/** The few lines of middleware the guide asks for: name the route template. */
function setRoute(template) {
  const metadata = getRPCMetadata(context.active());
  if (metadata) metadata.route = template;
}

const server = http.createServer((request, response) => {
  const pathname = request.url.split('?')[0];
  jobs.add(1);
  if (/^\/users\/[^/]+$/.test(pathname)) setRoute('/users/{id}');
  else if (pathname === '/health') setRoute('/health');
  // A route set by hand to the raw path: the collector's rules have to normalize it.
  else if (pathname.startsWith('/accounts/')) setRoute(pathname);
  // /nowhere/* names no route at all.
  const failing = pathname.startsWith('/users/') && request.method === 'DELETE';
  response.writeHead(failing ? 500 : 200, { 'content-type': 'text/plain' });
  response.end('ok');
});

// Port 0: the system picks a free port, printed for the caller.
server.listen(0, '127.0.0.1', () => console.log(`ready ${server.address().port}`));

process.on('SIGTERM', () => {
  server.close(async () => {
    // Shutdown collects and exports the last interval.
    await meterProvider.shutdown();
    process.exit(0);
  });
  server.closeAllConnections();
});
