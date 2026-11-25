# Pulse proof of concept

A gateway in front of an unmodified Umami 3.5.0: the demo site loads a pinned tracker, the
tracker posts to `/api/e`, the gateway checks the Origin, refuses forged identity fields,
truncates the client address and forwards to Umami. Not the product: see `../DECISIONS.md`.

## Quick path

Needs Docker, Node 24 or newer and pnpm.

```sh
pnpm install --ignore-scripts
npm run up      # PostgreSQL 18 + Umami, seed, then the local server (stays in the foreground)
npm test        # in a second terminal, against the running stack
```

| What | Where |
|------|-------|
| Start page: role picker and a preview of each console | http://localhost:4300/ |
| Tenant console of a project | http://localhost:4300/aurora-wallet/web (also `/requests`, `/setup`) |
| Operator console | http://localhost:4300/operator/projects |
| Demo site of "Aurora Wallet" | http://localhost:4301/demo/ |
| Umami (login `admin` / `umami`, local only) | http://localhost:3301 |
| The same Umami without its geo database, as on Vercel (tests only) | http://localhost:3302 |

## No access control

The address says who you are and nothing checks it. Anyone who knows a project's slug can read
its aggregates, and anyone can open the operator console. There is no sign-in in this
prototype. See decision 38 in `../DECISIONS.md`.

## Layout

| Path | Purpose |
|------|---------|
| `api/index.js` | The single Vercel function; routes by path |
| `lib/` | Gateway, tenant and operator read endpoints, demo site, database and Umami clients |
| `public/index.html`, `landing.css`, `landing.js` | The Pulse start page; it reads `/api/operator/projects` through `data.js` |
| `public/tenant/`, `public/operator/` | The pages of the two consoles |
| `public/app.js`, `charts.js`, `data.js`, `styles.css` | Shared by the pages; `data.js` is their only data source |
| `db/schema.sql` | Our tables (schema `usage_signals`); applied by the seed |
| `public/s/` | Pinned tracker, `manifest.json` with its SRI value, Umami's MIT licence |
| `scripts/seed.mjs` | Schema, Umami websites, four tenants (three active, one suspended) |
| `scripts/pin-tracker.mjs` | Regenerates the tracker and manifest from the pinned image (`npm run pin-tracker`) |
| `dev.mjs` | Local stand-in for Vercel: static files, `/api/*`, demo site on a second port |
| `lib/demo-site.js` | Demo pages, rendered for the host they are asked on |

## Configuration

`local.env` holds the local values and documents every variable. On Vercel, `DATABASE_URL`
and `DATABASE_URL_UNPOOLED` come from the Neon Marketplace integration; `UMAMI_URL` is set by
hand, and so is `UMAMI_BYPASS_SECRET`, the Protection Bypass for Automation secret of the Umami
project, which lets the console reach that closed deployment. Overrides go in `.env.local` (gitignored).

`npm run pin-tracker` regenerates the tracker, its manifest and `lib/tracker.generated.js`.

On Vercel the seed is the build command (`vercel.json`). A production build needs
`DEMO_SITE_HOSTS`: the hosts of Demo site A, B and C, comma-separated, in that order. A preview
build seeds nothing.

Licence: Apache-2.0. The tracker file is Umami's, MIT (`public/s/UMAMI-LICENSE.txt`).
