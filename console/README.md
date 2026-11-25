# Pulse console

This folder holds the code of the [Pulse proof of concept](../README.md). It has the gateway that
receives events, the read API, the start page, the tenant and operator consoles, and the demo
sites. An unmodified Umami 3.5.0 stores and counts the events behind it.

A demo site loads a pinned tracker, which posts each event to `/api/e`. The gateway checks the
page's origin and refuses forged identity fields. It then truncates the visitor's address and
forwards the event to Umami.

> [!WARNING]
> There is no sign-in. Anyone who knows a project's slug can read its figures, and anyone can open
> the operator console. Decision 38 in [`DECISIONS.md`](../DECISIONS.md) records this choice.

## Run it

You need Docker, Node 24 or newer, and pnpm.

1. Install the dependencies in `console/`.

   ```sh
   pnpm install --ignore-scripts
   ```

2. Start PostgreSQL 18 and Umami in Docker, seed them, and serve the pages. The command stays in
   the foreground.

   ```sh
   npm run up
   ```

3. Open the pages.

   | Page | Address |
   | --- | --- |
   | Start page | http://localhost:4300/ |
   | Tenant console of Aurora Wallet | http://localhost:4300/aurora-wallet/web |
   | Operator console | http://localhost:4300/operator/projects |
   | Demo site of Aurora Wallet | http://localhost:4301/demo/ |
   | Umami, login `admin` and password `umami` | http://localhost:3301 |

[`CONTRIBUTING.md`](../CONTRIBUTING.md) covers the tests and the other scripts.
[`architecture.md`](../architecture.md) explains how the console works inside.
