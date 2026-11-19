// Local stand-in for the Vercel platform: serves public/ with clean URLs and sends /api/* and
// /demo/* to the shared function in api/index.js, as vercel.json declares.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import api from './api/index.js';
import { requireEnv } from './lib/config.js';

const PUBLIC_ROOT = path.join(import.meta.dirname, 'public');
const TENANT_SCREEN = /^\/[^/]+\/(web|requests|setup)$/;
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
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
// The caller's x-vercel-ip-country is passed through the same way; a local browser sends none.
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

async function sendFile(file, outgoing, extraHeaders) {
  const content = await readFile(file);
  const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
  outgoing.writeHead(200, { 'content-type': type, ...extraHeaders });
  outgoing.end(content);
}

// Mirrors Vercel's cleanUrls: /web serves web.html, and /web.html redirects to /web with 308.
async function serveStatic(incoming, outgoing) {
  const pathname = decodeURIComponent(new URL(incoming.url, 'http://localhost').pathname);
  const file = path.join(PUBLIC_ROOT, pathname);
  if (!file.startsWith(PUBLIC_ROOT + path.sep)) {
    outgoing.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  if (pathname.endsWith('.html')) {
    outgoing.writeHead(308, { location: pathname.slice(0, -'.html'.length) }).end();
    return;
  }
  const extraHeaders = pathname.startsWith('/s/') ? PINNED_ASSET_HEADERS : {};
  const candidate = path.extname(file) ? file : `${file}.html`;
  try {
    await sendFile(candidate, outgoing, extraHeaders);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
    outgoing.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

// The rewrites of vercel.json: /api/* and /demo/* go to the function, and /<slug>/<screen>
// serves the one tenant page for that screen, whatever the slug.
function route(incoming, outgoing) {
  const { pathname } = new URL(incoming.url, 'http://localhost');
  if (pathname.startsWith('/api/') || pathname === '/demo' || pathname.startsWith('/demo/')) {
    return runFunction(incoming, outgoing);
  }
  const tenant = pathname.match(TENANT_SCREEN);
  if (tenant) incoming.url = `/tenant/${tenant[1]}`;
  else if (pathname === '/') incoming.url = '/index';
  return serveStatic(incoming, outgoing);
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

// The second port serves the same deployment under another host, as an extra domain does on
// Vercel: its /demo/ pages belong to the site registered for that host.
listen('gateway', Number(requireEnv('GATEWAY_PORT')), route);
listen('demo site', Number(requireEnv('DEMO_PORT')), route);
