# Contributing to the Pulse proof of concept

## Requirements

- Node 24 or newer
- pnpm
- Docker

## Setup

```sh
git clone git@github.com:BootNodeDev/usage-signals-poc.git
cd usage-signals-poc
git submodule update --init
cd console
pnpm install --ignore-scripts
```

The submodule `umami/` is Umami, unmodified, pinned to the commit of tag `v3.5.0`. Vercel deploys
it as a second project. The local stack does not use it and runs Umami's Docker image instead.

## Local development

In `console/`:

```sh
npm run up
```

The command starts PostgreSQL 18 and Umami in Docker and seeds them. It then serves the start
page and the consoles on port 4300 and the demo sites on port 4301, and stays in the foreground.

`local.env` holds the local values and documents every variable. Put your overrides in
`.env.local`, which git ignores.

## Scripts

Run them in `console/`.

| Script | What it does |
| --- | --- |
| `npm run up` | Starts the local stack, seeds it and serves the pages |
| `npm test` | Runs `test/*.test.mjs` against the running stack, one file at a time |
| `npm run build` | Runs the seed, `scripts/seed.mjs`. It is also the Vercel build command |
| `npm run pin-tracker` | Regenerates the pinned tracker, its `manifest.json` and `lib/tracker.generated.js` |

## Before a pull request

1. Start the stack with `npm run up`.
2. Run `npm test` in a second terminal.

Some tests use a second Umami at http://localhost:3302. It has no geo database, like the one on
Vercel, and `npm run up` starts it too.

Each architecture check in `checks/` starts its own stack. Its README says how to run it.
