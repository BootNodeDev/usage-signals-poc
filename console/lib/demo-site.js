// The demo tenant sites. Every registered host serves these pages from the same deployment,
// and the tag on each page carries the website id registered for the host it was asked on,
// which is the same row the gateway checks the Origin against.
import { findActiveSiteByDomain } from './db.js'
import { TRACKER } from './tracker.generated.js'

// Each site gets one look, by its position among the registered sites, so that three tenants
// read as three projects and their figures can be told apart. Nothing here names a real
// company, product or person: the pages say what they are.
const LOOKS = [
  {
    accent: 'violet',
    heading: 'A sample wallet site',
    lead: 'A stand-in for the site of a wallet project. Nothing is offered here.',
    pages: ['pricing', 'docs'],
  },
  {
    accent: 'gold',
    heading: 'A sample exchange site',
    lead: 'A stand-in for the site of an exchange project. Nothing is traded here.',
    pages: ['wallets', 'fees'],
  },
  {
    accent: 'ink',
    heading: 'A sample explorer site',
    lead: 'A stand-in for the site of a block explorer. Nothing is indexed here.',
    pages: ['explorer', 'status'],
  },
  {
    accent: 'tone',
    heading: 'A sample markets site',
    lead: 'A stand-in for the site of a markets project. Nothing is listed here.',
    pages: ['markets', 'changelog'],
  },
]

function html(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function escapeHtml(text) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  )
}

function titleOf(page) {
  return page.charAt(0).toUpperCase() + page.slice(1)
}

function navigation(look, page) {
  const current = (name) => (name === page ? ' aria-current="page"' : '')
  const home = `<a href="/demo/"${current('')}>Home</a>`
  const others = look.pages.map(
    (name) => `<a href="/demo/${name}"${current(name)}>${titleOf(name)}</a>`,
  )
  return [home, ...others].join('\n          ')
}

function mainOf(look, page, domain) {
  if (page) {
    return {
      heading: titleOf(page),
      lead: `The ${page} page of a sample site. It has no ${page} to show.`,
      sections: [
        [
          'Why this page exists',
          'So that a visit to this site can have a second page, and a visit of two pages can be told from a visit of one.',
        ],
        [
          'Where it sits',
          `It is served on ${domain}, next to the home page of the same sample site.`,
        ],
      ],
      links: '<a class="button" href="/demo/">Back to the home page</a>',
    }
  }
  return {
    heading: look.heading,
    lead: look.lead,
    sections: [
      [
        'What this site is',
        'A sample site for a prototype. It exists so that there is a real page, on a real address, for a real browser to visit.',
      ],
      [
        'What a visit leaves',
        'One page view, the site that linked here, a country, and the kind of browser and device. No cookie is set and no full address is kept.',
      ],
    ],
    links: look.pages
      .map((name) => `<a class="button" href="/demo/${name}">${titleOf(name)}</a>`)
      .join('\n          '),
  }
}

function renderPage({ site, origin, page, look }) {
  const name = escapeHtml(site.name)
  const main = mainOf(look, page, escapeHtml(site.domain))
  const sections = main.sections
    .map(([title, text]) => `<section><h2>${title}</h2><p>${text}</p></section>`)
    .join('\n        ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${page ? `${name}: ${titleOf(page)}` : name}</title>
    <script
      defer
      src="${origin}${TRACKER.path}"
      integrity="${TRACKER.integrity}"
      crossorigin="anonymous"
      data-host-url="${origin}"
      data-website-id="${site.umamiWebsiteId}"
    ></script>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="preload" href="/fonts/nunito-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/demo.css">
  </head>
  <body data-accent="${look.accent}">
    <header class="top">
      <div class="wrap">
        <a class="site-name" href="/demo/">${name}</a>
        <nav aria-label="Pages">
          ${navigation(look, page)}
        </nav>
      </div>
    </header>
    <main>
      <div class="hero">
        <div class="wrap">
          <div class="strokes" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
          <h1>${main.heading}</h1>
          <p>${main.lead}</p>
        </div>
      </div>
      <div class="sections">
        <div class="wrap">
        ${sections}
        <div class="links">
          ${main.links}
          <a class="button button-quiet" href="https://stellar.org/">Stellar</a>
        </div>
        </div>
      </div>
    </main>
    <footer>
      <div class="wrap">Sample site for the Pulse prototype, served on ${escapeHtml(site.domain)}.</div>
    </footer>
  </body>
</html>
`
}

function requestOrigin(request) {
  const url = new URL(request.url)
  const host = request.headers.get('host') ?? url.host
  const protocol = request.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1)
  return { host, origin: `${protocol}://${host}` }
}

/** GET /demo/ and /demo/<page> */
export async function handleDemoSite(request) {
  if (request.method !== 'GET') return html(405, 'Use GET.')
  const { host, origin } = requestOrigin(request)
  let site
  try {
    site = await findActiveSiteByDomain(host)
  } catch (error) {
    console.error(`demo site: lookup failed: ${error.message}`)
    return html(503, 'The demo site is unavailable right now. Retry later.')
  }
  if (!site) return html(404, 'No demo site is registered for this host.')
  const look = LOOKS[site.position % LOOKS.length]
  const page = new URL(request.url).pathname.replace(/^\/demo\/?/, '')
  if (page !== '' && !look.pages.includes(page)) return html(404, 'No such page.')
  return html(200, renderPage({ site, origin, page, look }))
}
