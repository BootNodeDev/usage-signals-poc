# Pulse console

This folder holds the code of the [Pulse proof of concept](../README.md). It has the gateway that
receives events, the read API, the start page, the tenant and operator consoles, the public view,
and the demo sites. An unmodified Umami 3.5.0 stores and counts the events behind it.

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
   | Public view | http://localhost:4300/public |
   | Demo site of Aurora Wallet | http://localhost:4301/demo/ |
   | Umami, login `admin` and password `umami` | http://localhost:3301 |

## Try the flags

The gateway flags an event that matches a rule: a known bot, missing `Sec-Fetch-*` headers, or
more than 10 User-Agents from one network in a day. It stores the event and counts it apart.

1. Visit the demo site of Aurora Wallet in a browser. The page view is counted.
2. Send an event the way a script does. It has a bot User-Agent and no `Sec-Fetch-*` headers.

   ```sh
   curl -X POST http://localhost:4300/api/e -A 'curl/8.7.1' \
     -H 'origin: http://localhost:4301' -H 'content-type: application/json' \
     -d '{"type":"event","payload":{"website":"a0000000-0000-4000-8000-0000000000aa","url":"/"}}'
   ```

3. Send 11 events from one network, each with another User-Agent. The 11th is flagged.

   ```sh
   for i in $(seq 1 11); do
     curl -X POST http://localhost:4300/api/e -A "Mozilla/5.0 Firefox/143.$i" \
       -H 'x-forwarded-for: 45.67.89.10' -H 'sec-fetch-site: same-site' \
       -H 'sec-fetch-mode: cors' -H 'sec-fetch-dest: empty' \
       -H 'origin: http://localhost:4301' -H 'content-type: application/json' \
       -d '{"type":"event","payload":{"website":"a0000000-0000-4000-8000-0000000000aa","url":"/"}}'
   done
   ```

4. Open the tenant console of Aurora Wallet. It shows the flagged page views apart from the
   counted ones, and the rule behind each.

[`CONTRIBUTING.md`](../CONTRIBUTING.md) covers the tests and the other scripts.
[`architecture.md`](../architecture.md) explains how the console works inside.
