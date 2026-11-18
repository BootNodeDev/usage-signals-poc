# Usage Signals proof of concept

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
| Demo site (tenant "Aurora Wallet") | http://localhost:4301 |
| Gateway and pinned tracker | http://localhost:4300 (`/api/e`, `/s/<version>-<hash>/t.js`) |
| Umami (login `admin` / `umami`, local only) | http://localhost:3301 |

## Layout

| Path | Purpose |
|------|---------|
| `api/index.js` | The single Vercel function; routes by path |
| `lib/` | Gateway, address truncation, database and Umami clients |
| `db/schema.sql` | Our tables (schema `usage_signals`); applied by the seed |
| `public/s/` | Pinned tracker, `manifest.json` with its SRI value, Umami's MIT licence |
| `scripts/seed.mjs` | Schema, Umami websites, three tenants (two active, one suspended) |
| `scripts/pin-tracker.mjs` | Regenerates the tracker and manifest from the pinned image (`npm run pin-tracker`) |
| `dev.mjs` | Local stand-in for Vercel: static files, `/api/*`, demo site on a second port |
| `demo-site/` | Two pages carrying the tracking tag |

## Configuration

`local.env` holds the local values and documents every variable. On Vercel, `DATABASE_URL`
and `DATABASE_URL_UNPOOLED` come from the Neon Marketplace integration; `UMAMI_URL` is set by
hand. Overrides go in `.env.local` (gitignored).

After `npm run pin-tracker` changes the hash, update `src` and `integrity` in `demo-site/*.html`
from `public/s/manifest.json`; `npm test` fails until they match.

Licence: Apache-2.0. The tracker file is Umami's, MIT (`public/s/UMAMI-LICENSE.txt`).
