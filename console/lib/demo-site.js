// The demo tenant sites. Every registered host serves these pages from the same deployment,
// and the tag on each page carries the website id registered for the host it was asked on,
// which is the same row the gateway checks the Origin against.
import { findActiveSiteByDomain } from './db.js';
import { TRACKER } from './tracker.generated.js';

// Each site gets one set, by its position among the registered sites, so that the figures of
// the demo sites can be told apart.
const PAGE_SETS = [
  ['pricing', 'docs'],
  ['wallets', 'fees'],
  ['explorer', 'status'],
  ['markets', 'changelog'],
];

function html(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function titleOf(page) {
  return page.charAt(0).toUpperCase() + page.slice(1);
}

function renderPage({ site, origin, page, pages }) {
  const name = escapeHtml(site.name);
  const heading = page ? `${name}: ${titleOf(page)}` : name;
  const links = page
    ? '<a href="/demo/">Home</a>'
    : pages.map((other) => `<a href="/demo/${other}">${titleOf(other)}</a>`).join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
    <script
      defer
      src="${origin}${TRACKER.path}"
      integrity="${TRACKER.integrity}"
      crossorigin="anonymous"
      data-host-url="${origin}"
      data-website-id="${site.umamiWebsiteId}"
    ></script>
  </head>
  <body>
    <h1>${heading}</h1>
    <p>Demo site on ${escapeHtml(site.domain)} for the Usage Signals proof of concept.</p>
    <nav>
      ${links}
      <a href="https://stellar.org/">Stellar</a>
    </nav>
  </body>
</html>
`;
}

function requestOrigin(request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const protocol = request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1);
  return { host, origin: `${protocol}://${host}` };
}

/** GET /demo/ and /demo/<page> */
export async function handleDemoSite(request) {
  if (request.method !== 'GET') return html(405, 'Use GET.');
  const { host, origin } = requestOrigin(request);
  let site;
  try {
    site = await findActiveSiteByDomain(host);
  } catch (error) {
    console.error(`demo site: lookup failed: ${error.message}`);
    return html(503, 'The demo site is unavailable right now. Retry later.');
  }
  if (!site) return html(404, 'No demo site is registered for this host.');
  const pages = PAGE_SETS[site.position % PAGE_SETS.length];
  const page = new URL(request.url).pathname.replace(/^\/demo\/?/, '');
  if (page !== '' && !pages.includes(page)) return html(404, 'No such page.');
  return html(200, renderPage({ site, origin, page, pages }));
}
