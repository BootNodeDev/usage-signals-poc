// Builds the test pages and serves them with the product's tracker file and a local collector
// in place of the gateway.
// Usage: node serve.mjs   (PORT=8808 by default; prints every wallet funnel request body)
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const HERE = import.meta.dirname;
// The tracker the product serves, read from its place in this repository and never edited.
const TRACKER_PATH = '/s/3.5.0-ac07551a/t.js';
const TRACKER_FILE = path.join(HERE, '../../console/public', TRACKER_PATH);
const BEFORE_SEND = 'usWalletFunnelBeforeSend';
const KIT_FILES = /@creit\.tech[\\/]stellar-wallets-kit[\\/]esm[\\/](.+)$/;

// Edits to the kit's source at bundle time, each standing for a kit update that changes the
// modal. `count` is how many times the text must occur, so a new kit release that no longer
// matches fails the build instead of silently testing an unchanged page.
const KIT_CHANGES = {
  'changed-class': {
    'components/app.js': [['class="stellar-wallets-kit ', 'class="swk-app ', 1]],
  },
  'changed-list': {
    'components/pages/auth-options.page.js': [
      ['<li\n', '<div role="option"\n', 1],
      ['</li>', '</div>', 1],
      ['<ul class', '<div role="listbox" class', 1],
      ['</ul>', '</div>', 1],
    ],
  },
  'closed-shadow': {
    'sdk/kit.js': [
      [
        'const wrapper = document.createElement("div");',
        'const host = document.createElement("div");' +
          ' const wrapper = host.attachShadow({ mode: "closed" });' +
          ' globalThis.__check08ShadowRoot = wrapper;',
        2,
      ],
      ['document.body).appendChild(wrapper);', 'document.body).appendChild(host);', 2],
      ['wrapper.parentNode?.removeChild(wrapper);', 'host.remove();', 2],
    ],
  },
};

// `entry` is bundled once per page; a page with `bundle` reuses another page's bundle.
// `hook: false` leaves the capture's beforeSend hook off the tracker tag, and
// `capture: false` leaves capture.js for the test to add later.
export const PAGES = {
  kit: { entry: 'tenant/app.js' },
  'custom-module': { entry: 'tenant/app-custom-module.js' },
  'changed-class': { entry: 'tenant/app.js' },
  'changed-list': { entry: 'tenant/app.js' },
  'closed-shadow': { entry: 'tenant/app.js' },
  'no-hook': { bundle: 'kit', hook: false },
  'late-capture': { bundle: 'kit', capture: false },
  'no-kit': { html: 'test-pages/no-kit.html' },
};

function occurrences(text, part) {
  return text.split(part).length - 1;
}

function kitChangePlugin(page) {
  const changes = KIT_CHANGES[page];
  const applied = new Set();
  return {
    name: 'kit-change',
    setup(context) {
      context.onLoad({ filter: KIT_FILES }, (file) => {
        const relative = file.path.match(KIT_FILES)[1].split(path.sep).join('/');
        const edits = changes[relative];
        if (!edits) return undefined;
        let contents = readFileSync(file.path, 'utf8');
        for (const [from, to, count] of edits) {
          const found = occurrences(contents, from);
          if (found !== count) {
            const wanted = `${count} of ${JSON.stringify(from)}`;
            throw new Error(`${page}: expected ${wanted} in ${relative}, found ${found}`);
          }
          contents = contents.replaceAll(from, to);
        }
        applied.add(relative);
        return { contents, loader: 'js' };
      });
      context.onEnd(() => {
        const missing = Object.keys(changes).filter((relative) => !applied.has(relative));
        if (missing.length > 0) {
          throw new Error(`${page}: kit files not found in the bundle: ${missing}`);
        }
      });
    },
  };
}

/** Bundles every tenant page into `outDir/<page>/app.js`, as a tenant's build would. */
export async function buildPages(outDir) {
  for (const [page, { entry }] of Object.entries(PAGES)) {
    if (!entry) continue;
    await build({
      entryPoints: [path.join(HERE, entry)],
      outfile: path.join(outDir, page, 'app.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'error',
      plugins: KIT_CHANGES[page] ? [kitChangePlugin(page)] : [],
    });
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type,x-umami-website-id,x-umami-hostname,x-umami-cache',
};

/** The tags the tenant's one tracker tag stands for: the tracker, then the capture. */
function ourTags({ hook = true, capture = true }, collectorUrl) {
  const attributes = [
    `src="${TRACKER_PATH}"`,
    'data-website-id="00000000-0000-4000-8000-000000000008"',
    `data-host-url="${collectorUrl}"`,
    hook ? `data-before-send="${BEFORE_SEND}"` : '',
  ];
  const tags = [`    <script ${attributes.filter(Boolean).join(' ')}></script>`];
  if (capture) tags.push('    <script src="/capture.js"></script>');
  return tags.join('\n');
}

function resolveFile(urlPath, bundleDir, collectorUrl) {
  const script = (file) => ({ body: readFileSync(file), type: 'text/javascript' });
  if (urlPath === '/capture.js') return script(path.join(HERE, 'capture.js'));
  if (urlPath === TRACKER_PATH) return script(TRACKER_FILE);
  // A page also answers under /<page>/account/<anything>/, as an account page would.
  const [, name, bundle] = urlPath.match(/^\/([a-z-]+)\/(?:(app\.js)|account\/[^/]+\/)?$/) ?? [];
  const page = PAGES[name];
  if (!page) return undefined;
  if (bundle) return page.entry ? script(path.join(bundleDir, name, 'app.js')) : undefined;
  const html = readFileSync(path.join(HERE, page.html ?? 'tenant/index.html'), 'utf8')
    .replace('__BUNDLE__', page.bundle ?? name)
    .replace('__OURS__', ourTags(page, collectorUrl));
  return { body: html, type: 'text/html' };
}

/**
 * Serves the pages on http://localhost:<port> and collects what the tracker posts to
 * http://127.0.0.1:<port>, another origin, as the gateway is for a tenant's page.
 *
 * Args:
 *   bundleDir: directory written by buildPages.
 *   port: port to listen on; 0 picks a free one.
 *   onRequest: called with every collected request.
 *
 * Returns: the page URL, the collector URL, the requests received so far as
 *   { body, headers }, and a close function.
 */
export async function startServer({ bundleDir, port = 0, onRequest = () => {} }) {
  const received = [];
  let collectorUrl;
  const server = createServer((request, response) => {
    const urlPath = new URL(request.url, 'http://localhost').pathname;
    if (urlPath === '/api/e' && request.method === 'OPTIONS') {
      response.writeHead(204, CORS).end();
      return;
    }
    if (urlPath === '/api/e' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received.push({ body, headers: request.headers });
        onRequest({ body, headers: request.headers });
        response.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end('{}');
      });
      return;
    }
    const found =
      request.method === 'GET' ? resolveFile(urlPath, bundleDir, collectorUrl) : undefined;
    if (!found) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const headers = { 'content-type': `${found.type}; charset=utf-8`, 'cache-control': 'no-store' };
    response.writeHead(200, headers);
    response.end(found.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  collectorUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `http://localhost:${server.address().port}`,
    collectorUrl,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const isWalletFunnel = ({ body }) => body.includes('"name":"wallet_funnel"');

if (import.meta.url === `file://${process.argv[1]}`) {
  const bundleDir = await mkdtemp(path.join(tmpdir(), 'us-check-08-'));
  await buildPages(bundleDir);
  const port = Number(process.env.PORT ?? 8808);
  const onRequest = (request) => {
    if (isWalletFunnel(request)) console.log(`event ${request.body}`);
  };
  const server = await startServer({ bundleDir, port, onRequest });
  console.log(`bundles in ${bundleDir}`);
  console.log(`open ${server.url}/kit/`);
}
