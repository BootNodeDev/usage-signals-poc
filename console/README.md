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

## Send API metrics

A project sends the duration of its HTTP requests with the OpenTelemetry SDK, next to its own
exporter. Make an ingest token for the project, then point a second OTLP exporter at the console.

1. Make a token. It is printed once.

   ```sh
   npm run ingest-token -- create --project aurora-wallet
   ```

2. Configure the exporter: OTLP over HTTP with JSON, delta temporality, and the token.

   ```sh
   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4300/v1/metrics
   OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20pit_..."
   OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
   ```

3. Record `http.server.request.duration` in seconds with these bucket bounds, which the SDK does
   not use by default, and with `http.route`, `http.request.method` and
   `http.response.status_code`:

   ```js
   meter.createHistogram('http.server.request.duration', {
     unit: 's',
     advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10] },
   });
   ```

The figures show on the project's API page. A refused point is answered with its reason in
`partialSuccess`.

## Try the gateway checks

The gateway accepts an event only from a registered site. It refuses identity fields that only
the gateway may set. The values below point at the live demo. To use your local stack, set them
to `http://localhost:4300`, `http://localhost:4301` and `a0000000-0000-4000-8000-0000000000aa`.

```sh
GATEWAY=https://usage-signals-poc.vercel.app
ORIGIN=https://usage-signals-poc-demo-site-a.vercel.app
WEBSITE=f0000000-0000-4000-8000-0000000000ff
```

Each command prints the response body and then the HTTP status code.

1. The gateway accepts a normal event.

   ```sh
   curl -s -w ' %{http_code}\n' "$GATEWAY/api/e" -H "origin: $ORIGIN" \
     -H 'content-type: application/json' \
     -d "{\"type\":\"event\",\"payload\":{\"website\":\"$WEBSITE\",\"url\":\"/\"}}"
   ```

   `{} 202`

2. The gateway refuses an event from a foreign origin.

   ```sh
   curl -s -w ' %{http_code}\n' "$GATEWAY/api/e" -H 'origin: https://evil.example' \
     -H 'content-type: application/json' \
     -d "{\"type\":\"event\",\"payload\":{\"website\":\"$WEBSITE\",\"url\":\"/\"}}"
   ```

   `{"error":"Origin is not a registered domain of an active project."} 403`

3. The gateway refuses an event that sets the visitor's address.

   ```sh
   curl -s -w ' %{http_code}\n' "$GATEWAY/api/e" -H "origin: $ORIGIN" \
     -H 'content-type: application/json' \
     -d "{\"type\":\"event\",\"payload\":{\"website\":\"$WEBSITE\",\"url\":\"/\",\"ip\":\"9.9.9.9\"}}"
   ```

   `{"error":"These fields are set by the gateway and must not be sent: ip."} 400`

The gateway stores the first event as flagged, because `curl` sends a bot User-Agent and no
`Sec-Fetch-*` headers. The next section explains the flags.

## Try the flags

The gateway flags an event that matches a rule: a known bot, missing `Sec-Fetch-*` headers, or
more than 10 User-Agents from one network in a day. It stores the event and counts it apart.

1. Visit the demo site of Aurora Wallet in a browser. The gateway counts the page view.
2. Send an event the way a script does. It has a bot User-Agent and no `Sec-Fetch-*` headers.

   ```sh
   curl -X POST http://localhost:4300/api/e -A 'curl/8.7.1' \
     -H 'origin: http://localhost:4301' -H 'content-type: application/json' \
     -d '{"type":"event","payload":{"website":"a0000000-0000-4000-8000-0000000000aa","url":"/"}}'
   ```

3. Send 11 events from one network, each with another User-Agent. The gateway flags the eleventh.

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
