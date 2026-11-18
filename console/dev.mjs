// Local stand-in for the Vercel platform: serves public/, sends /api/* to the shared function
// in api/index.js (the same rewrite vercel.json declares) and serves public/ again on a second
// port so the demo pages under /demo/ have a different Origin from the gateway.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import api from './api/index.js';
import { requireEnv } from './lib/config.js';

const ROOT = import.meta.dirname;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
// Mirrors the "headers" rule in vercel.json.
const PINNED_ASSET_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=31536000, immutable',
};

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Vercel sets x-vercel-forwarded-for itself and discards what the caller sent. Here the caller
// is the test suite or a local browser, so its x-forwarded-for stands in for the real address.
function platformHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const callerSupplied = headers.get('x-forwarded-for')?.split(',')[0].trim();
  headers.set('x-vercel-forwarded-for', callerSupplied || incoming.socket.remoteAddress);
  return headers;
}

async function runFunction(incoming, outgoing) {
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method: incoming.method,
    headers: platformHeaders(incoming),
    body: hasBody ? await readBody(incoming) : undefined,
  });
  const response = await api.fetch(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(directory, incoming, outgoing, extraHeaders = {}) {
  const pathname = decodeURIComponent(new URL(incoming.url, 'http://localhost').pathname);
  const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const file = path.join(directory, relative);
  if (!file.startsWith(directory + path.sep)) {
    outgoing.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(file);
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
    outgoing.writeHead(200, { 'content-type': type, ...extraHeaders });
    outgoing.end(content);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
    outgoing.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

function listen(name, port, handler) {
  const server = createServer((incoming, outgoing) => {
    handler(incoming, outgoing).catch((error) => {
      console.error(`${name}: ${incoming.method} ${incoming.url} failed: ${error.stack}`);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`${name}: http://localhost:${port}`));
}

listen('gateway', Number(requireEnv('GATEWAY_PORT')), (incoming, outgoing) => {
  if (incoming.url.startsWith('/api/')) return runFunction(incoming, outgoing);
  const headers = incoming.url.startsWith('/s/') ? PINNED_ASSET_HEADERS : {};
  return serveStatic(path.join(ROOT, 'public'), incoming, outgoing, headers);
});

listen('demo site', Number(requireEnv('DEMO_PORT')), (incoming, outgoing) =>
  serveStatic(path.join(ROOT, 'public'), incoming, outgoing),
);
