# Check 05: the collector pipeline end to end

> "The collector pipeline runs end to end as configured, and the path rules run as collector
> statements."

**Verdict: passes with stated corrections.** Every step of the edge collector's pipeline is
done by an upstream component of the OpenTelemetry Collector, with no custom Go code, and 6,000
simulated requests plus 280 real ones served by a Node.js service reach
`usage_signals.api_metric_minute` with the exact counts. The corrections are wording: what the
"signed token" has to be, how the path rules have to be written in RE2, where identical points
are merged, and what a tenant's exporter sees when it is refused.

Run on 2026-11-19 against the OpenTelemetry Collector contrib distribution 0.165.0, unmodified:
`otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea`
(the latest release of `opentelemetry-collector-releases` on that day, published 2026-11-07).

The collector was **not** built with the Builder: no Go toolchain was installed. The run used
the contrib image restricted, by configuration, to the nine components that
`builder-manifest.yaml` lists. That a binary built from that manifest behaves the same is
deduced, not run.

## Reproduce

```sh
npm ci --ignore-scripts && node run.mjs
```

About 70 seconds with the images already pulled (the collector image is 380 MB). It starts
compose project `us-check-05` (PostgreSQL on 55105, the collector's OTLP/HTTP on 43185, the
writer on 43195), runs the test service on a free port, prints the vector table, every
assertion and the verdict, removes the stack and exits non-zero if any assertion differs from
this README. `CHECK_KEEP_STACK=1` leaves the containers up. The disk queue, the writer's log
of everything it received and each collector configuration used are in a `mktemp` directory
whose path is the first line printed.

Files: `collector.yaml` (the edge configuration), `builder-manifest.yaml`, `writer.mjs`,
`service.cjs` (the tenant side), `vectors.mjs` (the path vectors), `run.mjs` and `harness.mjs`.

## The most important finding

An upstream authenticator does verify a signed per-tenant token offline and hands the tenant
identity to a processor. It is the `oidc` extension with `public_keys_file`: the token is a JWT,
the key file is a JWK Set, OpenID discovery is switched off, and the `resource` processor reads
any claim with `from_context: auth.claims.<name>`. The run used an issuer address under
`.invalid`, which cannot be resolved, so nothing was fetched. No custom authenticator is needed.
The extension is beta and has one active code owner.

## Corrections for the document

Edge collector, "Authentication" item, replacing its first three sentences:

> Authentication. Each tenant holds a signed token: a JWT (RS256 in our test) that carries the
> tenant ID, a token ID and the expiry. The upstream `oidc` authenticator verifies signature,
> issuer, audience and expiry offline against a local JWK Set file, with OpenID discovery
> switched off. No database call on the accept path. An unauthenticated request is answered
> 401 before its body is read; the answer names the reason, and the collector logs each
> refusal with the client address.

Edge collector, "Body-size cap" item, adding:

> An oversized body is answered 400, which an OTLP exporter must not retry, so the tenant
> loses that batch; the cap is therefore set well above a normal export. The memory limiter
> answers 503, which exporters retry.

Edge collector, replacing "Attributes outside the allowlist are deleted and identical points
merged.":

> Attributes outside the allowlist are deleted. Points of one export request and one service
> instance that became identical are merged at the edge; points from different requests or
> instances are added by the writer, which gives the same rows with or without the edge merge.

Edge collector, "Only HTTP server duration histograms continue. Traces and logs end in a no-op
exporter.", adding:

> Traces and logs have pipelines of their own that end in the no-op exporter; without them the
> collector answers 404 to a tenant that sends them. The edge does not check temporality: a
> cumulative histogram is answered 200 and refused by the writer, so the tenant's exporter
> never sees the refusal and the setup page is the only place it shows.

Path normalization, replacing "the collector statements (RE2 syntax), run through the built
collector":

> the collector statements (RE2 syntax), run through the collector. RE2 has no lookaround, so
> the statements double every slash before the rules and undo it afterwards; each rule is then
> the plain form `/<pattern>/`. A regular expression cannot verify a strkey checksum: the
> collector matches type letter, second character, alphabet and length, so a look-alike with a
> wrong checksum is normalized too. The JavaScript and Go programs can check the checksum; the
> vector file marks those vectors as not applying to the collector.

Writer, adding to its duties:

> The writer upserts the rows of a batch in key order; without that, two batches that touch
> the same rows deadlock in PostgreSQL.

Before the experiment's writer sorted its rows, PostgreSQL reported a deadlock in two of nine
runs of the end-to-end step. The writer answered 503 and the collector's retry delivered the
batch, so no request was lost, but the batch arrived late.

## The nine points

Stability is the level each component declares for metrics in its `metadata.yaml` at v0.165.0.
"Required" assertions decide the verdict; "controls" show that an assertion can fail.

| # | Step | Upstream component and configuration | Stability | Sent | Observed | Result |
| - | - | - | - | - | - | - |
| 1 | Authentication with per-tenant attribution | `oidc` extension with `public_keys_file` on the `otlp` receiver's `auth`; `resource` processor: delete `tenant.id`, then `insert` it `from_context: auth.claims.tenant_id`, token ID from `auth.claims.jti`; `transform`: `set(resource.attributes[...], UnixNano(Now()))`; `filter`: drop where `resource.attributes["tenant.id"] == nil` | oidc beta, otlp receiver stable, resource beta, transform beta, filter alpha | 15 requests: 2 valid tokens, 1 valid token whose payload claims the other tenant, 11 bad ones (none, no scheme, malformed, expired, two wrong keys, swapped claims, `alg: none`, HMAC keyed with the public key, wrong issuer, wrong audience), 1 signed token without a tenant claim; one request with headers and no body | Valid: 200 and a row for the token's tenant. All 11 bad: 401 and no row. Payload claiming tenant B with A's token: row for A, none for B; forged token ID replaced. No tenant claim: 200, dropped in the collector, nothing at the writer. Headers without a token and without a body: 401 arrives; with a valid token the server waits for the body | pass |
| 2 | Only HTTP server duration histograms continue | `filter` processor, `metric_conditions` on type, name and unit; `transform`: `scale_metric(0.001, "s")`, `set(metric.name, ...)`, three `set` statements for the old attribute names | filter alpha, transform beta | One request with 9 metrics: stable and older server histograms, `http.client.request.duration`, `db.client.operation.duration`, the stable name with unit ms, a sum, `http.server.active_requests`, a gauge and an exponential histogram under the stable name. Also the real Node.js service, which records a counter and client-side HTTP metrics | 2 points reach the writer, both `http.server.request.duration` in seconds. The older one: count 4, sum 12.843 s from 12,843 ms, min and max and the 14 bounds rescaled, `http.method`, `http.status_code`, `http.target` mapped. Control: with the filter removed the unrelated and client-side metrics reach the writer | pass |
| 3 | Traces and logs never reach storage or a queue | `traces` and `logs` pipelines from the `otlp` receiver to the `nop` exporter | nop beta | One trace and one log record with unique marker strings, while the writer answers 503 so that the queue keeps what it holds | Both answered 200. Markers absent from every file of the queue directory and from a full `pg_dump`; a metric sent in the same second is found in both (control). Without a token: 401. Control: with the two pipelines removed, traces are answered 404 | pass |
| 4 | Path rules as collector statements | `transform` processor, 14 `replace_pattern` statements and one `set` with `Concat` | transform beta | 71 vectors, each sent twice: as `http.route` on the stable metric and as `http.target` on the older one | 71 of 71 stored as expected through both carriers. Control: with the rules removed, all 41 vectors that should change are stored raw. A raw address sent while the writer was down is absent from the queue file; its normalized route is there | pass |
| 5 | Attribute allowlist and merge | `transform`: `keep_keys` on point and resource attributes, then `aggregate_on_attributes("sum")` | transform beta | 6 points in one request: three that become identical, one with another status, one in another minute, one without min and max | 4 points reach the writer. The merged one: count 6, sum 27.3345, min 0.0005, max 20, bucket counts added. Points in different minutes stay apart; the point without min and max stays apart and gains none. Only route, method and status code remain. Control: with the merge removed, 6 points reach the writer and the writer's upsert gives the same 3 rows and 11 requests | pass |
| 6 | Body-size cap and memory limiter | `max_request_body_size: 1048576` on the receiver; `memory_limiter` processor first in every pipeline | receiver stable, memory limiter beta | 0.6 MB body; 2 MB body; 2.5 kB gzip body that inflates to 2 MB; small gzip body; one request with the limiter's limit forced to 2 MiB | 0.6 MB and small gzip: 200, stored. 2 MB and the gzip body: 400 `http: request body too large`, nothing stored. Limiter: 503 `data refused due to high memory usage`, nothing stored | pass, with the 400 as a correction |
| 7 | Queue on local disk, with retries | `otlp_http` exporter with `sending_queue.storage: file_storage/queue` and `retry_on_failure.max_elapsed_time: 0`; `file_storage` extension with `fsync: true` | exporter stable, exporter queue and retry beta, file_storage beta | 20 requests with known counts, three times: writer stopped; writer stopped and collector stopped and started; writer stopped and collector killed and started. One batch while the writer answers 503 | Every request answered 200 with the writer down, found in the queue file, no row. After the writer returns: 90 of 90, 99 of 99 and 85 of 85 requests, unchanged four seconds later. The 503 batch: 7 of 7 | pass |
| 8 | End to end | all of the above | | 6,000 simulated requests of two tenants, two services, two instances each, six route shapes, three minutes, as 24 OTLP requests (half gzip, half in the older convention, each tenant claiming to be the other). Then 280 real HTTP requests to a Node.js service exporting with the OpenTelemetry SDK, protobuf, delta temporality, one-second interval | 6,000 requests in 432 rows; every row equal to the expected count, duration sum and 15 bucket counts per tenant, service, route, method, status and minute; 2,973 and 3,027 per tenant. Real service: 280 requests in the 5 expected route, method and status groups, all under the token's tenant, over several export intervals | pass |
| 9 | The writer | `writer.mjs`, about 200 lines, not an upstream component | | everything above; the same 6 points as cumulative; the real service with the SDK's default cumulative temporality | Cumulative refused, nothing stored. No storage error and no undecodable body in the whole run | pass |

Sources, all at the pinned version:

- oidc extension: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/extension/oidcauthextension/README.md
  ("Configuring Public Keys", "Accessing JWT Claims").
- `from_context` and the `auth.` prefix: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/attributesprocessor/README.md
  and https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/resourceprocessor/README.md
- filter processor: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/filterprocessor/README.md
- transform processor (`scale_metric`, `aggregate_on_attributes`): https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/transformprocessor/README.md
- OTTL functions (`replace_pattern` and the `$$` escape, `keep_keys`, `Now`, `UnixNano`, `Concat`): https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/pkg/ottl/ottlfuncs/README.md
- `max_request_body_size`, checked on the wire and again after decompression: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/config/confighttp/README.md
- memory limiter: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/processor/memorylimiterprocessor/README.md
- queue and retry, "If set to 0, the retries are never stopped": https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/exporter/exporterhelper/README.md
- file storage and `fsync`: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/extension/storage/filestorage/README.md
- `otlp_http` exporter (`otlphttp` is now a deprecated alias) and `encoding: json`: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/exporter/otlphttpexporter/README.md
- no-op exporter: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/exporter/nopexporter/README.md
- stability levels: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/docs/component-stability.md
- which HTTP status codes an OTLP exporter retries (429, 502, 503, 504, no other), "Retryable Response Codes": https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/docs/specification.md
- temporality values (delta is 1, cumulative is 2): https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/opentelemetry/proto/metrics/v1/metrics.proto
- strkey types, lengths and test vectors: SEP-23 version 1.4.0, https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0023.md
- RE2 syntax, which lists lookaround as not supported: https://github.com/google/re2/wiki/Syntax

Where the sources are silent, and the run decided: that `aggregate_on_attributes` keeps points
with different timestamps apart and keeps a point without min and max apart; the status code
of an oversized body; that a request is refused before its body is read.

## Path-rule vectors

These 71 vectors were written for this experiment. The reference set of 91 vectors that the
document mentions was not available, so nothing here says the collector statements pass it.
`expected` is written by hand in `vectors.mjs` and is not computed from the rules. Long
identifiers are shortened below as first six characters, last four and the length. "limit"
rows state what the rules do today with a case they get wrong or cannot express.

The strkeys are generated in `lib.mjs` from SEP-23; the generator reproduces the SEP's first
test vector, and vectors 31 and 35 are the SEP's own addresses.

| # | Kind | Raw path | Expected route | Stored | Why |
| - | - | - | - | - | - |
| 1 | rewrite | `/users/123` | `/users/{id}` | as expected | numeric ID |
| 2 | rewrite | `/users/123/orders/456` | `/users/{id}/orders/{id}` | as expected | two numeric IDs |
| 3 | rewrite | `/1/2/3/4` | `/{id}/{id}/{id}/{id}` | as expected | adjacent numeric segments |
| 4 | rewrite | `/ledgers/0` | `/ledgers/{id}` | as expected | zero |
| 5 | rewrite | `/ledgers/00051234567890123456` | `/ledgers/{id}` | as expected | long number |
| 6 | rewrite | `/42` | `/{id}` | as expected | number as the only segment |
| 7 | keep | `/v2/users` | `/v2/users` | as expected | version segment |
| 8 | keep | `/api/v1/items` | `/api/v1/items` | as expected | version segment |
| 9 | keep | `/oauth2/token` | `/oauth2/token` | as expected | digits inside a word |
| 10 | keep | `/reports/2026-11-19` | `/reports/2026-11-19` | as expected | a date is not a numeric ID |
| 11 | keep | `/items/12a` | `/items/12a` | as expected | digits followed by a letter |
| 12 | rewrite | `/orders/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b` | `/orders/{uuid}` | as expected | UUID |
| 13 | rewrite | `/orders/3F2B8C1E-9D4A-4B7F-8A61-0C5E7D9F1A2B/items` | `/orders/{uuid}/items` | as expected | upper-case UUID |
| 14 | rewrite | `/a/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b` | `/a/{uuid}/{uuid}` | as expected | adjacent UUIDs |
| 15 | keep | `/orders/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2` | `/orders/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2` | as expected | UUID one character short |
| 16 | keep | `/orders/zzzz8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b` | `/orders/zzzz8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b` | as expected | UUID shape with non-hex letters |
| 17 | rewrite | `/tx/9f86d0…0a08(64)` | `/tx/{hash}` | as expected | transaction hash, 64 hex digits |
| 18 | rewrite | `/tx/9F86D0…0A08(64)/effects` | `/tx/{hash}/effects` | as expected | upper-case hash |
| 19 | rewrite | `/tx/0x9f86…0a08(66)` | `/tx/{hash}` | as expected | hash with 0x |
| 20 | rewrite | `/blobs/da39a3…0709(40)` | `/blobs/{hash}` | as expected | 40 hex digits |
| 21 | rewrite | `/blobs/d41d8c…427e(32)` | `/blobs/{hash}` | as expected | 32 hex digits |
| 22 | rewrite | `/blobs/9f86d0…0a08(128)` | `/blobs/{hash}` | as expected | 128 hex digits |
| 23 | keep | `/assets/cafe` | `/assets/cafe` | as expected | short hex word |
| 24 | keep | `/assets/deadbeef` | `/assets/deadbeef` | as expected | short hex word |
| 25 | keep | `/assets/facade` | `/assets/facade` | as expected | English word made of hex letters |
| 26 | keep | `/blobs/9f86d0…00a0(63)` | `/blobs/9f86d0…00a0(63)` | as expected | 63 hex digits is no known hash length |
| 27 | keep | `/blobs/9f86d0…0a0g(64)` | `/blobs/9f86d0…0a0g(64)` | as expected | 64 characters, one not hex |
| 28 | rewrite | `/accounts/GATDOS…LOWN(56)` | `/accounts/{account}` | as expected | G-address |
| 29 | rewrite | `/accounts/GATDOS…LOWN(56)/payments` | `/accounts/{account}/payments` | as expected | G-address inside a path |
| 30 | rewrite | `/paths/GATDOS…LOWN(56)/GBCVMZ…JBY7(56)` | `/paths/{account}/{account}` | as expected | adjacent G-addresses |
| 31 | rewrite | `/accounts/GA7QYN…VSGZ(56)` | `/accounts/{account}` | as expected | the G-address of SEP-23 test vector 1 |
| 32 | rewrite | `/contracts/CBSHLB…HQT5(56)` | `/contracts/{contract}` | as expected | C-address |
| 33 | rewrite | `/contracts/CBSHLB…HQT5(56)/events/7` | `/contracts/{contract}/events/{id}` | as expected | C-address then numeric ID |
| 34 | rewrite | `/accounts/MCBZJJ…LHJ2(69)` | `/accounts/{muxed_account}` | as expected | M-address, 69 characters |
| 35 | rewrite | `/accounts/MA7QYN…CJUQ(69)` | `/accounts/{muxed_account}` | as expected | the M-address of SEP-23 test vector 2 |
| 36 | rewrite | `/keys/SCRLHR…CYVQ(56)` | `/keys/{redacted}` | as expected | secret seed |
| 37 | rewrite | `/x/TDA5FY…BBQY(56)` | `/x/{strkey}` | as expected | pre-authorized transaction strkey |
| 38 | rewrite | `/x/XDQPCA…7MCR(56)` | `/x/{strkey}` | as expected | hash-x strkey |
| 39 | rewrite | `/pools/LD7RAI…5MF4(56)` | `/pools/{strkey}` | as expected | liquidity pool strkey |
| 40 | rewrite | `/balances/BAPC6Q…QFZA(58)` | `/balances/{strkey}` | as expected | claimable balance strkey, 58 characters |
| 41 | rewrite | `/x/WA6U4X…R6HI(69)` | `/x/{strkey}` | as expected | muxed contract strkey, 69 characters |
| 42 | keep | `/accounts/QATDOS…LOWN(56)` | `/accounts/QATDOS…LOWN(56)` | as expected | 56 capital letters and digits starting with Q: no such strkey type |
| 43 | keep | `/accounts/ABCDEF…ABCD(56)` | `/accounts/ABCDEF…ABCD(56)` | as expected | a word of 56 capital letters |
| 44 | keep | `/accounts/GATDOS…LOWN(56)` | `/accounts/GATDOS…LOWN(56)` | as expected | G-shape with a character outside the base-32 alphabet |
| 45 | keep | `/accounts/GZTDOS…LOWN(56)` | `/accounts/GZTDOS…LOWN(56)` | as expected | G-shape with an impossible second character |
| 46 | keep | `/accounts/GATDOS…DLOW(55)` | `/accounts/GATDOS…DLOW(55)` | as expected | G-address one character short |
| 47 | keep | `/accounts/GATDOS…OWNA(57)` | `/accounts/GATDOS…OWNA(57)` | as expected | G-address one character long |
| 48 | keep | `/accounts/gatdos…lown(56)` | `/accounts/gatdos…lown(56)` | as expected | lower-case G-shape: strkeys are upper case |
| 49 | keep | `/accounts/MCBZJJ…DLHJ(68)` | `/accounts/MCBZJJ…DLHJ(68)` | as expected | M-address one character short |
| 50 | keep | `/GET/CONFIG` | `/GET/CONFIG` | as expected | short capital words starting with G and C |
| 51 | rewrite | `/users/` | `/users` | as expected | trailing slash |
| 52 | rewrite | `/users/123/` | `/users/{id}` | as expected | numeric ID and trailing slash |
| 53 | rewrite | `/accounts/GATDOS…LOWN(56)/` | `/accounts/{account}` | as expected | G-address and trailing slash |
| 54 | rewrite | `/users///` | `/users` | as expected | several trailing slashes |
| 55 | rewrite | `/users//123` | `/users/{id}` | as expected | doubled slash inside a path |
| 56 | keep | `/` | `/` | as expected | the root stays |
| 57 | rewrite | `/users/123?cursor=456&limit=10` | `/users/{id}` | as expected | query string removed |
| 58 | rewrite | `/accounts/GATDOS…LOWN(56)?cursor=now` | `/accounts/{account}` | as expected | query string after an address |
| 59 | rewrite | `/search?q=/users/123` | `/search` | as expected | query string holding a path |
| 60 | rewrite | `/docs/page#section-2` | `/docs/page` | as expected | fragment removed |
| 61 | keep | `/users/{id}` | `/users/{id}` | as expected | route template |
| 62 | keep | `/users/:id/orders/:orderId` | `/users/:id/orders/:orderId` | as expected | colon-style template |
| 63 | keep | `/rpc/getTransaction` | `/rpc/getTransaction` | as expected | JSON-RPC method as route |
| 64 | keep | `users/list` | `users/list` | as expected | no leading slash |
| 65 | rewrite | `users/123` | `users/{id}` | as expected | no leading slash, numeric ID |
| 66 | limit | `/accounts/GATDOS…LOWA(56)` | `/accounts/{account}` | as expected | wrong checksum is still rewritten: a regular expression cannot compute CRC-16 |
| 67 | limit | `/users/123.json` | `/users/123.json` | as expected | identifier with a file extension is not rewritten |
| 68 | limit | `/accounts/GATDOS…LOWN(56):payments` | `/accounts/GATDOS…LOWN(56):payments` | as expected | address that is only part of a segment is not rewritten and stays raw |
| 69 | limit | `/users/alice@example.org` | `/users/alice@example.org` | as expected | e-mail addresses have no rule here |
| 70 | limit | `/users/jane-doe` | `/users/jane-doe` | as expected | free-text identifiers need the token heuristic, which is not a regular expression |
| 71 | limit | `/blobs/111111…1111(64)` | `/blobs/{id}` | as expected | a hash made only of digits is reported as a numeric ID |

What RE2 or OTTL cannot express:

- A segment boundary after a match, because RE2 has no lookahead. Worked around by doubling
  the slashes; the statements are in `collector.yaml` under `transform/path_rules`.
- The CRC-16 checksum of a strkey (vector 66).
- The "shape-based token heuristic" of the document was not attempted. Vectors 67 to 70 show
  what is left raw without it: an identifier with a file extension, an address that is only
  part of a segment, an e-mail address, a free-text name.
- The statements cannot tell a hand-set `http.route` from one copied from `http.target` once
  both are in the same attribute; here the same rules run on both. Running a rule on raw
  paths only would need a marker attribute set by the mapping step. Not tested.

Not covered by these rules: signed-payload strkeys (type P, variable length), e-mail
addresses and JWTs, which the document lists and the RFP does not name.

## What a reviewer changing one condition will see

Run on 2026-11-19, one change to `collector.yaml` at a time:

| Change | Outcome |
| - | - |
| none, four consecutive runs | exit 0, 78 of 78 assertions |
| remove `- { key: tenant.id, action: delete }` | fails: a payload claiming tenant B is stored for B |
| remove `auth` from the receiver | fails: the run aborts, because no point is stamped and none is stored |
| remove the filter condition on a missing `tenant.id` | fails: the resource without a tenant reaches the writer |
| remove the numeric-ID statement | fails: 12 vectors |
| remove `keep_keys` on point attributes | fails: attributes and merge |
| remove `storage: file_storage/queue` | fails: nothing on disk, nothing survives a restart |
| `fsync: false` | **still passes** |
| `max_elapsed_time: 300s` | **still passes** |

The last two rows are the limits of this experiment: see below.

## Not covered

- **"Synced".** `fsync: true` is configured. Killing the collector process does not lose a
  batch with or without it; only a power loss or a kernel crash would show the difference,
  and that was not tested.
- **"Retries that never expire".** `max_elapsed_time: 0` is configured and documented. The
  longest outage in the run was a few seconds, far below the default limit of 300 seconds, so
  the run does not show it.
- **A full queue**, and what the tenant's exporter then sees. Not tested.
- **Delivered twice.** At-least-once delivery can repeat a batch when the writer commits and
  its answer is lost. The experiment's writer does not remove duplicates, and no such case was
  provoked: "counted once" holds here for a stopped writer, a 503 and a restarted or killed
  collector.
- **The Builder.** See the top of this file.
- **Key rotation.** The oidc extension watches the key file and reloads it (read in
  `extension.go` at v0.165.0, not run). Revocation cannot happen at the edge with an offline
  token; the document already puts it in the writer.
- **Signing algorithms other than RS256**, and tokens with a 13-month life.
- **The older convention from a real exporter.** The Node.js HTTP instrumentation at 0.301.2
  emits only the stable metric, so the older metric was tested with hand-written payloads.
  The older SDK default buckets, which start with a bound at 0, would need the writer's
  re-bucketing and were not sent.
- **Exponential histograms** are dropped by the filter. Converting them at the edge was not
  tried.
- **Minute boundaries with a real exporter.** The real service's rows are compared summed over
  minutes, because the minute of a point is the SDK's collection time; per-minute equality is
  shown with the hand-written exports only.
- **Load.** 6,000 requests in 24 exports is a correctness run, not the design volume.
- **gRPC.** Only OTLP/HTTP is enabled, as in the document's contract.
- **The repository's `ingest_token` table** stores the hash of a random token, which needs a
  database lookup; the document's signed token does not use it. The two are not reconciled
  here.
- **`api_metric_minute` has no minimum and maximum columns**, while the document lists them.
  Min and max were checked at the writer's input, not in storage.

Observed and not part of the verdict: the 401 answer includes the verifier's reason (for an
expired token, the expiry time), and each refusal is logged at warning level with the client
address.

## What the writer does not implement

`writer.mjs` receives the collector's export as OTLP/HTTP JSON, refuses a resource without
`tenant.id`, anything that is not `http.server.request.duration` in seconds, cumulative
temporality, points without route, method or a valid status code and points whose bounds are
not the 14 advised ones, and adds the rest to `usage_signals.api_metric_minute` in one
transaction per batch. It answers 200 after the commit and 503 when storage fails.

Not implemented: tenant status and token revocation, the timestamp window against the time of
receipt, re-bucketing, point-level deduplication, the per-tenant quota, the series cap and its
"(other)" series, histogram sanity checks beyond the ones above, TLS, the ingest role, and
400 for a batch it can never accept (it stores what it can and reports the rest as
`partialSuccess`). Its port is published on localhost for the experiment; the document's
writer accepts the local collector only.
