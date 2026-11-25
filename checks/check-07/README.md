# Check 07: falling back to the second ingest address

> "Browsers and OTLP exporters fall back to the second address when one ingest location is
> dead."

**Verdict: does not hold as written.** It depends on how the location is dead and on whether
the client already holds a connection to it. With one name that answers two A records:

On a new connection (no connection open, no cached DNS answer):

- Dead address refuses the connection: every client delivers to the other address inside the
  same request, in milliseconds.
- Dead address answers nothing: every client delivers. Chromium and the Node.js SDK take about
  0.3 s. The Python SDK takes its exporter timeout (10 s by default), the Go SDK 15 to 17 s
  and the Collector 15 s, against the document's 5 s for OTLP.
- Dead address accepts the connection and never answers: no client falls back.

On a connection that was open when the location failed:

- Location goes silent: Chromium and the Python SDK lose the request. The Node.js SDK loses it
  when the connection was idle for 8 s and delivers it in 0.3 s when idle for 20 s or more.
  The Go SDK delivers after 31 to 37 s and the Collector after 50 s.
- Location resets the connection: Chromium, Node.js and Python deliver in about 6 ms, the
  Collector after 5 to 7 s. The Go SDK loses the export and does not retry it.
- In every case the next send, 60 s later, was delivered.

Every client used the addresses in the order DNS gave them. None rotated. Closing the page
while a new request was in flight changed nothing in Chromium.

Run on 2026-11-24 and 2026-11-25 on one machine (Docker 29.9.2, linux/arm64) against the
images and packages pinned in this folder.

## Reproduce

```sh
node run.mjs
```

About 30 minutes with the images built. It starts compose project `us-check-07` on an internal
Docker network (10.207.7.0/24, no published ports), checks the fixtures, runs the clients side
by side, prints the tables and the verdict, removes the stack and exits non-zero when a
control fails or a result differs from the one below. The scratch directory (`mktemp`) is the
first line printed; it holds every request, SYN packet and DNS query as JSON lines.

For the open-connection cases the comparison is on deliveries (all, none or some of each send),
not on timings: a change in how late a send arrives does not fail the run. Each of those cases
also checks that the failure was in place in time: the failing location must receive the first
send of every repetition and nothing after it. In the run of 2026-11-25 that held on all 20
failure rows (50 POSTs at the failing location for 50 repetitions).

- `CHECK_PART=new` or `open` runs one half (about 10 and 20 minutes).
- `CHECK_REPS` (50), `CHECK_WINDOW_MS` (150000): repetitions, and how long a new-connection
  request is observed before it counts as not delivered.
- `CHECK_NEGATIVE=1`: negative control. The second location is dead too. The run must exit 1.
- `CHECK_PART=open CHECK_REPS=20 CHECK_OPEN_GAPS=8000 node run.mjs`: the supplementary run
  with a connection idle for 8 s (fewer repetitions, so that all first sends fit in the gap).
- `CHECK_KEEP_STACK=1` leaves the containers up.

## Set-up

- Two ingest endpoints, `10.207.7.10` (fails) and `10.207.7.11` (stays up). Each case has its
  own port, so each connection attempt belongs to one case.
- New-connection failure modes are fixed per port. Refused: no listener. No answer:
  `iptables -j DROP`. Accepts and never answers: a TCP listener that reads and stays silent.
- Open-connection failure modes are applied by `run.mjs` after every repetition has sent once.
  Silent: `iptables -j DROP` on the port in both directions. Reset:
  `iptables -j REJECT --reject-with tcp-reset`, as a host that lost its connection state does.
  The endpoint never closes an idle connection itself.
- A DNS server (`dns.mjs`) that answers `*.df.ingest.test` with the failing address first and
  `*.ds.ingest.test` with it second, TTL 5 s, never rotated, no AAAA. Clients query it
  directly through a mounted `resolv.conf`.
- Every repetition uses its own host name. Repetitions start 100 ms apart (250 ms for tabs).
- Chromium 159.0.8154.13 (`chromedp/headless-shell`), driven over the DevTools protocol. Each
  repetition is a tab that loads a page carrying the product's tracker file,
  `console/public/s/3.5.0-ac07551a/t.js`, unmodified. The tracker sends with
  `fetch(..., {method: "POST", keepalive: true, credentials: "omit"})` and a JSON content
  type, cross-origin, so Chromium sends a preflight first. It does not use `sendBeacon` and
  does not retry. Later sends on the same tab call the tracker's `umami.track()`.
- OTLP/HTTP protobuf with default settings: `@opentelemetry/exporter-metrics-otlp-proto`
  0.301.2 on Node.js 24.22.1 (musl), `opentelemetry-exporter-otlp-proto-http` 1.45.2 on Python
  3.14.10 (glibc), `otlpmetrichttp` 1.47.0 on Go 1.27.4 (no cgo), and the `otlphttp` exporter
  of `otel/opentelemetry-collector-contrib` 0.165.0, one pipeline per repetition.
- A request is delivered when its POST arrives at an endpoint. Connection attempts are counted
  from SYN packets captured by `tcpdump` at each endpoint.

## Verdict per client and failure mode

| Client | New: refused | New: no answer | New: accepts, never answers | Open: goes silent | Open: reset |
|---|---|---|---|---|---|
| Chromium | Yes | Yes | No | No: lost | Yes |
| Chromium, page closed in flight | Yes | Yes | No | not run | not run |
| OTel SDK, Node.js | Yes | Yes | No | Yes, with one stated condition: idle 20 s or more; lost at 8 s | Yes |
| OTel SDK, Python | Yes | Yes, with one stated condition: after its timeout, 10 s | No | No: lost | Yes |
| OTel SDK, Go | Yes | Yes, with one stated condition: 15 to 17 s | No | Yes, with one stated condition: 31 to 37 s | No: lost; Yes when idle 100 s |
| Collector `otlphttp` | Yes | Yes, with one stated condition: 15 s | No | Yes, with one stated condition: 50 s; 15 s when idle 100 s | Yes, with one stated condition: 5 to 7 s |

With the dead address second in the DNS answer every new-connection case is Yes: the dead
address is never contacted.

## Results: new connection

50 repetitions, 150 s window, run of 2026-11-25. Delivered; median / worst ms; connection
attempts to the failing address and to the live one. Dead address first:

| Client | Refused | No answer | Accepts, never answers |
|---|---|---|---|
| Chromium, page open | 50/50; 2 / 20; 50 and 50 | 50/50; 304 / 315; 100 and 100 | 0/50; 50 and 0; pending at 150 s |
| Chromium, page closed | 50/50; 2 / 41; 50 and 50 | 50/50; 304 / 309; 98 and 98 | 0/50; 50 and 0 |
| Node.js SDK | 50/50; 4 / 196; 50 and 50 | 50/50; 253 / 302; 50 and 50 | 0/50; 50 and 0; "Request timed out" at 10 s |
| Python SDK | 50/50; 2 / 38; 50 and 50 | 50/50; 10012 / 10052; 50 and 50 | 0/50; 50 and 0; failed at 10 s |
| Go SDK | 50/50; 2 / 43; 50 and 50 | 50/50; 15047 / 17443; 76 and 50 | 0/50; 215 and 0; gave up at about 66 s |
| Collector | 50/50; 3 / 19; 50 and 50 | 50/50; 15003 / 15099; 50 and 50 | 0/50; 219 and 0; still retrying |

Dead address second: 50/50 in all 18 rows, median 1 to 3 ms, worst 64 ms, no connection
attempt to the dead address.

Controls: with both alive, 50/50 for every client in both orders, always at the first address
(median 1 to 7 ms). With both refusing, 0/50 for every client: Chromium one attempt per
address; Node.js 5 rounds; Python 8 rounds; Go one round and no retry; the Collector was
still retrying at 150 s.

Negative control at run level (2026-11-24): `CHECK_NEGATIVE=1 CHECK_REPS=10
CHECK_WINDOW_MS=30000 node run.mjs` reported 0/10 and "No" in all 36 rows and exited 1.

What the clients did on a new connection:

- **Refused.** One attempt to the dead address, one to the live one, one DNS query.
- **No answer.** Chromium starts an attempt to the next address after about 0.3 s, for the
  preflight and again for the POST. Node.js moves on after about 0.25 s. Python waits its
  exporter timeout on the first address, then connects to the second. The Collector waits
  15 s. The Go SDK delivers at about 15 s, after its first request has timed out at 10 s and
  been retried (76 connection attempts for 50 exports).
- **Accepts, never answers.** The connection succeeds, so nothing moves on. Chromium waits
  without limit (observed 150 s). Node.js and Python fail after 10 s. Go and the Collector
  retry, resolve the name again and connect to the first address again.

## Results: open connection

Each repetition sends three times with one exporter or one tab to a name whose first address
is the location that fails. 1st send: both locations up. Then the location fails. 2nd send:
after the idle gap. 3rd send: 60 s after the 2nd, as a periodic exporter would. 50 repetitions
for gaps of 20 and 100 s, 20 repetitions for 8 s. Delivered; median / worst ms. Every first
send arrived (all rows).

Location goes silent:

| Client | Idle | 2nd send | 3rd send |
|---|---|---|---|
| Chromium | 8 s | 0/20; pending when the tab closed 150 s later | 20/20; 311 / 330 |
| Chromium | 20 s | 0/50; pending | 50/50; 312 / 343 |
| Chromium | 100 s | 0/50; pending | 50/50; 313 / 325 |
| Node.js SDK | 8 s | 0/20; "Request timed out" at 10.0 s | 20/20; 261 / 282 |
| Node.js SDK | 20 s | 50/50; 254 / 266 | 50/50; 3 / 13 |
| Node.js SDK | 100 s | 50/50; 258 / 273 | 50/50; 3 / 16 |
| Python SDK | 8 s | 0/20; failed at 10.0 s | 20/20; 10016 / 10026 |
| Python SDK | 20 s | 0/50; failed at 10.0 s | 50/50; 10018 / 10069 |
| Python SDK | 100 s | 0/50; failed at 10.0 s | 50/50; 10012 / 10039 |
| Go SDK | 8 s | 20/20; 33135 / 37132 | 20/20; 1 / 7 |
| Go SDK | 20 s | 50/50; 31312 / 37186 | 50/50; 1 / 10 |
| Go SDK | 100 s | 50/50; 15007 / 17396 | 50/50; 1 / 2 |
| Collector | 8 s | 20/20; 49331 / 52331 | 20/20; 5 / 28 |
| Collector | 20 s | 50/50; 49687 / 52443 | 50/50; 3 / 14 |
| Collector | 100 s | 50/50; 15006 / 15021 | 50/50; 4 / 13 |

Location resets the connection:

| Client | Idle | 2nd send | 3rd send |
|---|---|---|---|
| Chromium | 8, 20, 100 s | 20/20, 50/50, 50/50; 6 to 7 / 33 | all; 9 to 11 / 53 |
| Node.js SDK | 8, 20, 100 s | 20/20, 50/50, 50/50; 4 to 5 / 14 | all; 3 / 18 |
| Python SDK | 8, 20, 100 s | 20/20, 50/50, 50/50; 5 to 7 / 33 | all; 2 to 4 / 20 |
| Go SDK | 8 s | 0/20; "connection reset by peer" at once, no retry | 20/20; 4 / 16 |
| Go SDK | 20 s | 0/50; "connection reset by peer" at once, no retry | 50/50; 3 / 12 |
| Go SDK | 100 s | 50/50; 3 / 13 | 50/50; 1 / 6 |
| Collector | 8 s | 20/20; 5450 / 6433 | 20/20; 4 / 22 |
| Collector | 20 s | 50/50; 5247 / 7341 | 50/50; 5 / 17 |
| Collector | 100 s | 50/50; 4 / 34 | 50/50; 5 / 20 |

Control (no failure): 150 of 150 sends delivered for every client at 20 and 100 s (60 of 60 at
8 s), all at the first address.

Lost or late, and the next export:

- **Chromium.** Silent: the event is lost. The request stays pending and the tracker does not
  retry. Reset: delivered on a new connection to the second address. The next event is
  delivered in both cases.
- **Node.js SDK.** Silent: lost after 8 s idle, delivered in 0.3 s after 20 s or more idle.
  In the second case the SDK opened a new connection for the send instead of using the old
  one. Reset: delivered. The next export is delivered.
- **Python SDK.** Silent: the export fails at the exporter timeout and is lost. The next
  export is delivered, 10 s late. Reset: delivered.
- **Go SDK.** Silent: late by 31 to 37 s, not lost. Reset: the export fails at once and is not
  retried; lost. The next export is delivered in both cases.
- **Collector.** Never lost here: its queue retries. Late by 50 s (silent) or 5 to 7 s (reset).
- **Idle longer than the client's keep-alive.** With no failure and 100 s idle, the Go SDK and
  the Collector opened a second connection on their own (100 connection attempts for 50
  repetitions); at 20 s they reused the first. After 100 s idle they therefore behave as on a
  new connection. Chromium, Node.js and Python reused one connection for all three sends at
  100 s; the server never closed it.
- "Lost" means that export call failed. With cumulative temporality the next export carries
  the totals again; with delta temporality the interval is gone. Not tested here.

## Sentence for the document

Replace the check with:

> On a new connection, browsers and OTLP exporters reach the second address when the first
> refuses connections. When the first address does not answer at all, Chromium and the Node.js
> SDK reach the second in about 0.3 seconds; the Python SDK takes its exporter timeout (10
> seconds by default), the Go SDK and the Collector 15 to 17 seconds, which is outside the
> 5-second indicator. When the first address accepts connections and does not answer, no
> client falls back. On a connection that was open when the location failed, the request in
> progress can be lost: by Chromium, the Python SDK and, within seconds of the last send, the
> Node.js SDK when the location goes silent, and by the Go SDK when the location resets the
> connection. The Collector delivers in every one of these cases, up to 50 seconds late. The
> next send, 60 seconds later, was delivered in every case.

In the topology paragraph, after "removes one that fails its health check", a statement of
fact:

> Client fallback is not relied on. Clients use the first address DNS returns and do not
> rotate.

**Recommendation, not a measured result:** a location that knows it is unhealthy should close
its listening port and its open connections, because refusal and reset are the failures
clients recover from fastest; the DNS health check should test a full request and answer, not
an open port; and tenants who need no loss during a location failure should export through a
Collector.

## Sources

Read on 2026-11-24. They describe the mechanisms; the numbers above are measured.

- Tracker behaviour: `console/public/s/3.5.0-ac07551a/t.js` in this repository.
- `keepalive`: "the browser will not abort the associated request if the page that initiated
  it is unloaded". https://developer.mozilla.org/en-US/docs/Web/API/RequestInit
- Chromium connects to the resolved addresses in order and has a 300 ms fallback timer between
  address families.
  https://chromium.googlesource.com/chromium/src/+/HEAD/net/socket/transport_connect_job.h
  The source read does not document the 0.3 s step between two IPv4 addresses seen here.
- Node.js `autoSelectFamily`, default true since v20: connects "to all obtained IPv6 and IPv4
  addresses, in sequence", each attempt but the last limited by
  `autoSelectFamilyAttemptTimeout`. https://nodejs.org/api/net.html
- Python `socket.create_connection`: "try to connect to all possible addresses in turn until a
  connection succeeds". https://docs.python.org/3/library/socket.html
- Go `net.Dialer`: "Dial will try each IP address in order until one succeeds"; "the timeout
  may be divided between them". https://pkg.go.dev/net
- OTLP exporter timeout default 10 s; transient errors retried with exponential back-off
  within it. https://opentelemetry.io/docs/specs/otel/protocol/exporter/
- OTLP/HTTP: "If the client cannot connect to the server, the client SHOULD retry the
  connection using an exponential backoff strategy". https://opentelemetry.io/docs/specs/otlp/
- Collector retry defaults (5 s initial, 300 s maximum elapsed, queue enabled).
  https://github.com/open-telemetry/opentelemetry-collector/blob/main/exporter/exporterhelper/README.md

No source was read for why the Node.js SDK abandons a silent connection between 8 and 20 s
idle, or for the idle limits of Go and the Collector; those are observations only.

## Not covered

- The DNS provider removing the dead address: health checks, their interval, TTL, and caching
  by resolvers, browsers and operating systems. Here DNS always answers both addresses.
- IPv6, and names with both A and AAAA records.
- HTTPS. Everything ran over plain HTTP. A stalled TLS handshake, HTTPS DNS records, HTTP/2
  and HTTP/3 were not tested.
- Firefox, Safari, mobile browsers, and Chromium on other operating systems.
- Closing the whole browser, navigating away, a frozen tab, and closing the tab while a send
  on an open connection is in flight.
- Non-default exporter timeouts and retry settings. An independent reviewer measured them
  separately; this folder does not.
- A server that closes idle connections, which real gateways do, and a location that closes
  its connections cleanly when it stops. Idle gaps other than 8, 20 and 100 s.
- A location that fails while a request is being answered.
- The periodic reader of the SDKs and the effect of temporality on a lost export.
- Node.js on glibc, Python on musl, Go built with cgo, other SDK languages, OTLP over gRPC.
- A location that answers with errors (5xx), answers slowly, or is "host unreachable".
- Times beyond 150 s. The Collector retries for up to 300 s by default.
