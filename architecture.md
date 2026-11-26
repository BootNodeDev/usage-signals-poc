# Architecture Overview

## Tech Stack

| Category | Technology | Notes |
|----------|-----------|-------|
| Framework | None | One Vercel function and static files |
| Language | JavaScript, ES modules | Node code in `console/lib/`, `scripts/`, `test/`; plain browser scripts in `console/public/` |
| Data fetching | `fetch` in the browser through `window.LData` (`public/data.js`) | The server reads Umami's statistics API (`lib/web-read.js`) and PostgreSQL (`lib/db.js`) |
| Database | PostgreSQL 18, `pg` 8.23.1 | Neon on Vercel. Umami's tables in `public`, ours in `usage_signals` |
| Analytics engine | Umami 3.5.0, unmodified | Git submodule `umami/`, its own Vercel project, closed with Vercel Authentication |
| UI primitives | Hand-written HTML and inline SVG charts | `public/charts.js` for the consoles, `public/landing.js` for the start page |
| Styling | Plain CSS | `styles.css` (consoles), `landing.css` (start page), `demo.css` (demo sites) |
| Testing | `node:test` | Runs against the local Docker stack |
| Runtime | Vercel Node.js functions | `engines.node` is `>=24`, which Vercel runs as 26.x |

## Project Structure

```
console/                  Vercel project 1: gateway, read API, start page, consoles, demo sites
  api/index.js            The single function; routes /api/* and /demo/* by path
  lib/                    Gateway, tenant and operator endpoints, Umami and database clients, demo site
  public/                 Static files
    index.html            Start page (Pulse), with landing.css and landing.js
    tenant/, operator/    Console pages, served at /<slug>/web|requests|setup and /operator/*
    data.js               The only data source of every page (window.LData)
    app.js, charts.js     Console shell, formatters and charts
    s/                    Pinned Umami tracker and its manifest (generated)
    fonts/                Nunito Sans for every page (OFL)
  db/schema.sql           Our tables, schema usage_signals; applied by the seed
  scripts/                seed.mjs (the Vercel build command), seed-profile.mjs, fixtures.mjs, pin-tracker.mjs
  test/                   node:test suites, run against the local stack
  dev.mjs                 Local stand-in for Vercel: static files, /api/*, demo sites on a second port
  docker-compose.yml      PostgreSQL 18 and Umami 3.5.0, plus an Umami without its geo database for tests
umami/                    Umami v3.5.0, unmodified git submodule; Vercel project 2
checks/                   Architecture experiments, each with its own script and README
DECISIONS.md              Every technical choice, its source and the alternative rejected
CONTRIBUTING.md           Setup, local stack, scripts and tests
```

## Key Abstractions

- **Gateway** (`lib/gateway.js`, `handleEvent`): the only public write path for web events. It takes the visitor's address and user agent from the connection, never from the body. It refuses events from an Origin that is not a registered domain of an active tenant, and events that carry `ip`, `userAgent`, `timestamp`, `id`, `salt`, `browser`, `os` or `device`. It truncates the address (IPv4 to /24, IPv6 to /48), flags the event when it matches a rule, and forwards it to Umami.
- **Flags** (`lib/flags.js`, `flagTag`): three rules. `bot`: `isbot` matches the User-Agent. `no-sec-fetch`: a `Sec-Fetch-Site`, `Sec-Fetch-Mode` or `Sec-Fetch-Dest` header is missing. `many-agents`: the truncated address has shown more than 10 User-Agents today (UTC). The codes of the rules that matched go in Umami's `tag` field, joined with `+`. A flagged event is stored, never dropped, and counted apart.
- **Read endpoints**: `lib/tenant-api.js` answers for one site, named by the slug in the path. `lib/operator-api.js` answers for every site at once and replaces small counts with a marker. Both get their figures from `readFigures()` in `lib/web-read.js`.
- **Data seam** (`public/data.js`, `window.LData`): the only thing pages read. `currentProjectSlug()` is the one place that decides which project a tenant page shows.
- **Seed profiles** (`scripts/seed-profile.mjs`): local runs seed the fixtures in `scripts/fixtures.mjs`; production builds seed Demo site A, B and C from `DEMO_SITE_HOSTS`, and Strata Vault Kit on its own host; preview builds apply only the schema, through `DATABASE_URL`.
- **Demo sites** (`lib/demo-site.js`): `/demo/` pages rendered for the host they are asked on, each tagged with that host's website id.
- **Brand** (`landing.css`, `styles.css`, `demo.css`): the Pulse look of the start page, the consoles and the demo sites. Nunito Sans from `public/fonts/`, ink `#201d3a`, the gradient from `#5b2134` to `#064a8c`. Spacing scale 4 8 12 16 24 32 48 64; type scale 12 14 16 20 28 40. Hierarchy comes from size, weight and space: the `--tone` field groups things, borders do not.

### Data Access Layer

- The browser talks only to our API, never to Umami.
- `lib/db.js` holds every query on our tables (`listSites`, `findSiteBySlug`, `findActiveSiteByDomain`, `countAgentsToday`, ...) through one `pg` pool registered with `attachDatabasePool`.
- `usage_signals.agent_sighting` holds one row per truncated address and User-Agent seen today, both as SHA-256 hashes. `countAgentsToday()` deletes the rows of earlier days as it writes.
- `lib/umami.js` forwards events to Umami's `/api/send`. `lib/umami-admin.js` logs in with the admin account for the seed, the tests and the read endpoints.
- `umamiAccessHeaders()` in `lib/config.js` adds `x-vercel-protection-bypass` to every call to Umami, which is closed with Vercel Authentication.

## Routes

| Route | Module | Description |
|-------|--------|-------------|
| `/` | `public/index.html`, `landing.js` | Start page: role picker and a preview of each console |
| `/<slug>/web`, `/<slug>/requests`, `/<slug>/setup` | `public/tenant/*.html` | Tenant console of one project |
| `/operator/projects`, `/operator/access` | `public/operator/*.html` | Operator console |
| `/demo/`, `/demo/<page>` | `lib/demo-site.js` | Demo site of the host the request came to |
| `POST /api/e` | `lib/gateway.js` | Tracker events |
| `GET /api/tenant/<slug>/project` | `lib/tenant-api.js` | The project, its website id and the pinned tracker |
| `GET /api/tenant/<slug>/web?days=7\|30\|90` | `lib/tenant-api.js` | Web figures of one site |
| `GET /api/tenant/<slug>/api?days=7\|30\|90` | `lib/tenant-api.js`, `lib/api-read.js` | API figures of one project, per route and day |
| `GET /api/operator/projects?days=7\|30\|90[&figures=all\|totals\|one[&project=<slug>]]` | `lib/operator-api.js` | Web and API figures of every site, small counts masked. The start page asks for `totals` (no breakdowns) or `one` (one project's figures and referrers, the rest listed without figures) |
| `GET /api/cron/sample-traffic` | `lib/sample-traffic.js` | Vercel cron: sample page views and API rows for the demo sites |
| `/s/<version>/...` | `public/s/` | Pinned tracker, served with immutable caching |

## Data Flow

Write path:

1. A demo page loads the pinned tracker from `/s/` with its SRI hash.
2. The tracker posts each event to `/api/e`.
3. The gateway checks the Origin, refuses forged fields and truncates the address.
4. The gateway records the User-Agent for the address in `usage_signals.agent_sighting` and sets the `tag` to the rules the event matched, if any.
5. The gateway forwards the event to Umami's `/api/send`, with the truncated address in `cf-connecting-ip` and the country in `cf-ipcountry`.
6. Umami stores the event in its own tables (schema `public`). Its own bot check is off (`DISABLE_BOT_CHECK`), so bot traffic is stored too, flagged.

Read path:

1. A page calls `LData`, which fetches `/api/tenant/...` or `/api/operator/projects`.
2. The endpoint finds the site rows in `usage_signals.site` and reads Umami's statistics API with the admin account: counted figures with `tag=nre.<FLAG_TAG_PATTERN>` (no tag, or a tag that is not made of rule codes), flagged page views per day with `tag=re.<FLAG_TAG_PATTERN>`, and flagged page views by rule from `/breakdown?fields=["tag"]`. That is eight reads per site, four per site with `figures=totals`, five in all with `figures=one`.
3. The operator endpoint replaces counts from 1 to 9 with `{ small: true, below: 10 }`.
4. Answers are cached by the CDN for 10 seconds (`Cache-Control: public, max-age=0, s-maxage=10`).

## Environment Variables

All server-side; there are no public variables. `console/local.env` holds the local values.

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Pooled PostgreSQL URL for the function. Set by the Neon integration on Vercel |
| `DATABASE_URL_UNPOOLED` | Direct PostgreSQL URL for the seed's schema changes. Set by the Neon integration on Vercel |
| `UMAMI_URL` | Base URL of the Umami deployment. Set by hand on Vercel |
| `UMAMI_BYPASS_SECRET` | Protection Bypass for Automation secret of the Umami Vercel project, which lets the console reach that closed deployment. Set by hand on Vercel |
| `UMAMI_ADMIN_USER` | Umami account for the seed, the tests and the read endpoints. Defaults to `admin` |
| `UMAMI_ADMIN_PASSWORD` | Password of that account |
| `DEMO_SITE_HOSTS` | Production builds only: hosts of Demo site A, B and C, comma-separated, in that order |
| `UMAMI_NOGEO_URL` | Tests only: the Umami without its geo database |
| `GATEWAY_PORT`, `DEMO_PORT`, `GATEWAY_URL`, `DEMO_URL` | Local server and tests only |

The scripts are in [`CONTRIBUTING.md`](CONTRIBUTING.md#scripts).

---

## Domain-Specific Sections (Examples)

### Number / Precision Handling

- **Small counts:** the operator endpoint never sends a count from 1 to 9. It sends `{ small: true, below: 10 }`, and the pages show `<10`. Zero stays zero; 10 and above are exact.
- **Rates:** a bounce rate or visit duration over fewer than 10 visits is not sent; the pages show "Too few visits".
- **Charts:** days with a small count are not drawn.
- **Counted and flagged:** every figure leaves flagged page views out, except `flagged` and `flagged_by_rule`. Raw page views are counted plus flagged. A page view that matched two rules counts under both, so the rules can add up to more than `flagged`.
- **Visitors:** the sum of each day's distinct visitors (`sumOfDaily` in `lib/web-read.js`), not distinct visitors over the whole range.

### Auth / Session Management

There is none. The address names the project and nothing checks it: anyone who knows a slug can read that project's figures, and anyone can open the operator console (decision 38 in `DECISIONS.md`). `currentProjectSlug()` in `public/data.js` and `projectOf()` in `lib/tenant-api.js` are the two places a session would plug in.

### Error Handling Patterns

The gateway fails closed. It answers 202 when Umami accepts the event, 400 when the event or Umami's answer says it is malformed, 403 for a refused Origin, 413 for a body over 16 KiB, and 503 when the database or Umami cannot be reached. The read endpoints answer 503 with a message the page shows as is.
