# Check 05: the collector pipeline end to end

> "The collector pipeline runs end to end as configured, and the path rules run as collector
> statements."

**Verdict: passes with stated corrections, after one round of fixes.** An independent review
refuted the first version of this check: a tenant could write as another tenant, a raw
identifier could reach the disk queue and PostgreSQL, and one tenant could stop ingestion for
all. Each of those is fixed here with upstream components and a small writer, each fix has a
test that failed before it, and the document needs the sentences below changed. Every step of
the edge collector's pipeline is still done by an upstream component of the OpenTelemetry
Collector, with no custom Go code.

Run on 2026-11-19 against the OpenTelemetry Collector contrib distribution 0.165.0, unmodified:
`otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea`
(the latest release of `opentelemetry-collector-releases` on that day, published 2026-11-07).

**The collector was not built with the Builder.** No Go toolchain was installed. The run uses
the contrib image restricted, by configuration, to the nine components that
`builder-manifest.yaml` lists. That a binary built from that manifest behaves the same is
deduced, not run.

## Reproduce

```sh
npm ci --ignore-scripts && node run.mjs
```

About 100 seconds with the images already pulled. It starts compose project `us-check-05`
(PostgreSQL on 55105, the collector's OTLP/HTTP on 43185, the writer on 43195, and for one
case a second collector on 43186 in the role of a tenant's own), runs the test service on a
free port, prints the vector table, every assertion and the verdict, removes the stack and
exits non-zero if any assertion differs from this README. `CHECK_KEEP_STACK=1` leaves the
containers up; `CHECK_ONLY=name,name` runs only the named phases. The disk queue, the writer's
log of everything it received and each collector configuration used are in a `mktemp`
directory whose path is the first line printed.

Files: `collector.yaml` (the edge configuration), `builder-manifest.yaml`, `writer.mjs`,
`service.cjs` (the tenant side), `vectors.mjs` (the path vectors), `run.mjs` (the first nine
phases), `review.mjs` (the phases added after the review), `harness.mjs`, `lib.mjs` and
`proto.mjs` (a small protobuf encoder, so that a request can carry what no SDK would send).

## What the review found and what was done

RED is the new test against the configuration and writer as first committed; GREEN is the
same test now. Both were run on 2026-11-19.

| # | Finding | Fix | RED | GREEN |
| - | - | - | - | - |
| 1 | With a valid token of A, a resource that carries `tenant.id` = B more than once is stored under B; the same forges the token ID. The `resource` processor's `delete` removes only the first occurrence of a key | `transform/strip` runs before the stamping: `delete_matching_keys(resource.attributes, "^(tenant[.]id\|usage_signals[.].*)$")`, which removes every occurrence. `delete_key`, the fix the review tried, also removes only the first: three copies still pass it | resource level, 2 and 3 copies, JSON and protobuf: stored for B in 4 of 4; token ID "forged" in 2 of 2 | 12 of 12 cases (resource, scope and data-point level; 2 and 3 copies; JSON and protobuf) stored for A; token ID and time of receipt genuine. Control: with `delete_key`, 3 copies are stored for B |
| 2 | A raw address reaches the disk queue and PostgreSQL through a second `http.route` | `transform/allowlist` no longer filters, it rebuilds: each kept value is read once into the statement cache, `keep_keys(attributes, [])` empties the map, and the value is written back. One key, one value, and that value is the one the path rules work on | raw address in the queue and in the database; 4 of 6 routes stored raw | absent from queue and database; 6 of 6 routes as expected (two and three copies, JSON and protobuf, `http.route` with `http.target`, older metric). Control: without the emptying statement the raw address is in the queue |
| 3 | The writer answered 503 for ever to a batch it could never store; about ten such batches from one tenant held every queue consumer | The writer validates every point before storing and refuses the unstorable ones for good: 200 with `partialSuccess`, 400 for an undecodable body. Each row is written under a savepoint, so a row PostgreSQL refuses (a tenant that is not enrolled) is refused alone. 503 is left for storage that is unavailable | 28 unstorable batches of A: B's batch not stored within 15 s; 251 storage errors | B's batch stored after about 0.1 s; 28 of 28 refused with a reason; no 503. PostgreSQL stopped and started: the batch is kept on disk and stored once |
| 4 | A tenant Collector with `cumulativetodelta` emits zero-count points for idle series; the collector's JSON export leaves a zero count out, and the writer turned that into a storage error | A point without a count is a zero-count point: valid, nothing to store | a real cumulative SDK behind a real `cumulativetodelta`: 14 storage errors, retried for ever | 50 of 50 requests stored, the zero-count points accepted, no error |
| 5 | Exemplars (trace ID, raw path), the metric description, the scope's name, version and attributes and both schema URLs reached the disk queue | `set(datapoint.exemplars, nil)`, `set(metric.description, "")`, `keep_keys(metric.metadata, [])`, `set(scope.name, "")`, `set(scope.version, "")`, `keep_keys(scope.attributes, [])`, `set(scope.schema_url, "")`, `set(resource.schema_url, "")` | 8 marker strings in the queue, the exemplar's trace ID among them | none of 14. Control: without the exemplar statement, the exemplar and its trace ID are in the queue |
| 6 | Path rules: a query string after a newline survived; a route sent as an integer, array or bytes was stored raw; an absolute URL was mangled; a secret seed was stored raw when lower-cased, prefixed, suffixed or one character short | Routes that are not strings are not kept. Everything from the first `?`, `#` or control character is removed; scheme and host are removed; a seed-like run of 52 characters or more, in either case, anywhere in a segment, redacts the segment. Added: paging tokens, hex runs of 24 or more, e-mail, JWT, signed-payload strkeys, an address next to other text in its segment, a length cap | 97 of 141 vectors; routes of 6 non-string types stored as `123`, `true`, `["/users/123"]` and so on | 141 of 141; all 7 non-string types stored as `(unmatched)` |

What upstream statements could not strip: nothing that was tested. What they leave by design:
`service.name` and `service.instance.id` are tenant-chosen text, are queued and (the service
name) stored as sent, and no rule looks inside them.

Sources for the mechanisms, at v0.165.0:

- `pcommon.Map.Remove` returns after the first match:
  https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/pdata/pcommon/map.go
- `delete_key` calls `Remove`; `delete_matching_keys` and `keep_keys` call `RemoveIf`, which
  visits every entry:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.165.0/pkg/ottl/ottlfuncs
  (`func_delete_key.go`, `func_delete_matching_keys.go`, `func_keep_keys.go`). The functions'
  documentation does not mention duplicate keys.
- The `resource` processor's `delete` calls `Remove`, and `RemoveIf` only for a `pattern`:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/internal/coreinternal/attraction/attraction.go
- Setting `datapoint.exemplars` to nil clears it ("a nil val clears dest to an empty slice"):
  https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/pkg/ottl/contexts/internal/ctxutil/slice.go
- `aggregate_on_attributes` moves the exemplars of merged points into the result, so the merge
  does not remove them:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/internal/coreinternal/aggregateutil/aggregate.go
- `resource.schema_url` and `scope.schema_url` are in the source of the OTTL contexts
  (`ctxresource/resource.go`, `ctxscope/scope.go`) and not in their README. The run shows
  that they work.
- The statement cache, `datapoint.cache` and `resource.cache`:
  https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.165.0/pkg/ottl/contexts
- `cumulativetodelta` (beta): https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/cumulativetodeltaprocessor/README.md
- Partial success, and the status codes an exporter retries (429, 502, 503, 504, no other):
  https://github.com/open-telemetry/opentelemetry-proto/blob/v1.9.0/docs/specification.md

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

Edge collector, replacing "tenant.id is deleted if the client sent one, then stamped from the
verified token together with the time of receipt.":

> Every occurrence of `tenant.id`, and of the other names the edge stamps, is removed, then
> the values of the verified token and the time of receipt are written. An OTLP request can
> carry the same attribute key several times, and the statements that delete one key remove
> only its first occurrence, so the removal is by pattern.

Edge collector, replacing "Attributes outside the allowlist are deleted and identical points
merged.":

> The allowlist is rebuilt, not filtered: each kept attribute is read once, the attribute map
> is emptied and the value written back, so a key sent several times ends as one key with the
> value the path rules worked on. A route or method that is not a string is not kept.
> Exemplars, the metric description, the instrumentation scope and the schema URLs are
> cleared, so that no trace ID and no raw path reaches the disk queue. `service.name` and
> `service.instance.id` are tenant-chosen text and pass as sent. Points of one export request
> and one service instance that became identical are merged at the edge; points from
> different requests or instances are added by the writer.

Edge collector, "Only HTTP server duration histograms continue. Traces and logs end in a no-op
exporter.", adding:

> Traces and logs have pipelines of their own that end in the no-op exporter; without them the
> collector answers 404 to a tenant that sends them. The edge does not check temporality or
> bucket bounds: a cumulative histogram, a histogram with other bounds and a status code sent
> as a string are answered 200 and refused by the writer, so the tenant's exporter sees no
> error and the setup page is the only place the refusal shows.

Writer, replacing "It acknowledges after commit, answers 503 when PostgreSQL is unavailable so
the collector keeps the batch, and 400 for a batch it can never accept.":

> It decides for every data point whether it can ever be stored. Points that cannot (a
> missing or malformed field, a count that does not match its buckets, a control character or
> an over-long name, a tenant that is not enrolled) are refused for good and reported as a
> partial success; an undecodable body is answered 400. A zero-count point, which a tenant
> Collector's cumulative-to-delta step sends for an idle series, is valid and stores nothing.
> It answers 503 only when storage is unavailable, so that the collector keeps the batch,
> because a batch that is answered 503 for ever holds a queue consumer for ever. It
> acknowledges after commit and upserts the rows of a batch in key order, without which two
> batches that touch the same rows deadlock.

Path normalization, replacing "the collector statements (RE2 syntax), run through the built
collector":

> the collector statements (RE2 syntax), run through the collector. RE2 has no lookaround, so
> the statements double every slash before the rules and undo it afterwards; each rule is then
> the plain form `/<pattern>/`. A regular expression cannot verify a strkey checksum: the
> collector matches type letter, second character, alphabet and length, so a look-alike with a
> wrong checksum is normalized too.

Path normalization, replacing "S, which is always redacted":

> S, which is redacted as a whole segment whenever a run of 52 or more of its 56 characters
> appears, in either case and next to any other text. A shorter fragment of a seed, and a seed
> that is percent-encoded or sits in `service.name`, is not recognized.

Delivery, replacing "The writer removes duplicates with a point-level key kept for 2 days, so a
retried batch is not counted twice.":

> Delivery from collector to writer is at least once, so the writer has to remove duplicates
> with the point-level key; that key is not built yet. Without it, a collector killed in the
> middle of a delivery counted 2.4% too much in the review (3,750 requests sent, 3,840
> stored), and a batch that a tenant's exporter sends three times is counted three times.

## The nine points

Stability is the level each component declares for metrics in its `metadata.yaml` at v0.165.0.
"Required" assertions decide the verdict; "controls" show that an assertion can fail;
"findings" are behaviours the corrections above rest on.

| # | Step | Upstream component and configuration | Stability | Sent | Observed | Result |
| - | - | - | - | - | - | - |
| 1 | Authentication with per-tenant attribution | `oidc` extension with `public_keys_file` on the `otlp` receiver's `auth`; `transform`: `delete_matching_keys` on the stamped names; `resource` processor: `insert` `tenant.id` `from_context: auth.claims.tenant_id`, token ID from `auth.claims.jti`; `transform`: `set(resource.attributes[...], UnixNano(Now()))`; `filter`: drop where `resource.attributes["tenant.id"] == nil` | oidc beta, otlp receiver stable, resource beta, transform beta, filter alpha | 15 requests: 2 valid tokens, 1 valid token whose payload claims the other tenant, 11 bad ones (none, no scheme, malformed, expired, two wrong keys, swapped claims, `alg: none`, HMAC keyed with the public key, wrong issuer, wrong audience), 1 signed token without a tenant claim; one request with headers and no body; 14 requests with a stamped name sent 2 or 3 times | Valid: 200 and a row for the token's tenant. All 11 bad: 401 and no row. Payload claiming tenant B with A's token, once, twice or three times, at any level, JSON or protobuf: row for A, none for B; forged token ID and time of receipt replaced. No tenant claim: 200, dropped in the collector, nothing at the writer. Headers without a token and without a body: 401 arrives; with a valid token the server waits for the body | pass |
| 2 | Only HTTP server duration histograms continue | `filter` processor, `metric_conditions` on type, name and unit; `transform`: `scale_metric(0.001, "s")`, `set(metric.name, ...)`, three `set` statements for the old attribute names | filter alpha, transform beta | One request with 9 metrics: stable and older server histograms, `http.client.request.duration`, `db.client.operation.duration`, the stable name with unit ms, a sum, `http.server.active_requests`, a gauge and an exponential histogram under the stable name. Also the real Node.js service, which records a counter and client-side HTTP metrics | 2 points reach the writer, both `http.server.request.duration` in seconds. The older one: count 4, sum 12.843 s from 12,843 ms, min and max and the 14 bounds rescaled, `http.method`, `http.status_code`, `http.target` mapped. Control: with the filter removed the unrelated and client-side metrics reach the writer | pass |
| 3 | Traces and logs never reach storage or a queue | `traces` and `logs` pipelines from the `otlp` receiver to the `nop` exporter; `transform`: `set(datapoint.exemplars, nil)` | nop beta, transform beta | One trace and one log record with unique marker strings, and a metric whose exemplar carries a trace ID, while the writer answers 503 so that the queue keeps what it holds | Both answered 200. Markers and the exemplar's trace ID absent from every file of the queue directory and from a full `pg_dump`; a metric sent in the same second is found in both (control). Without a token: 401. Control: with the two pipelines removed, traces are answered 404 | pass |
| 4 | Path rules as collector statements | `transform` processor: a length cap, 20 `replace_pattern` statements and one `set` with `Concat` | transform beta | 141 vectors, each sent twice: as `http.route` on the stable metric and as `http.target` on the older one; 7 routes that are not strings; 6 requests with a duplicated route | 141 of 141 stored as expected through both carriers; non-string routes stored as `(unmatched)`; a raw address in a duplicated key reaches neither queue nor database. Control: with the rules removed, none of the 96 vectors that need a rule is stored as expected | pass |
| 5 | Attribute allowlist and merge | `transform`: cache, `keep_keys(..., [])` and `set` to rebuild point and resource attributes, statements that clear exemplars, description, metadata, scope and schema URLs, then `aggregate_on_attributes("sum")` | transform beta | 6 points in one request: three that become identical, one with another status, one in another minute, one without min and max. One point with 13 marker strings and an exemplar | 4 points reach the writer. The merged one: count 6, sum 27.3345, min 0.0005, max 20, bucket counts added. Points in different minutes stay apart; the point without min and max stays apart and gains none. Only route, method and status code remain, and none of the markers is in the queue. Control: with the merge removed, 6 points reach the writer and the writer's upsert gives the same 3 rows and 11 requests | pass |
| 6 | Body-size cap and memory limiter | `max_request_body_size: 1048576` on the receiver; `memory_limiter` processor first in every pipeline | receiver stable, memory limiter beta | 0.6 MB body; 2 MB body; 2.5 kB gzip body that inflates to 2 MB; small gzip body; one request with the limiter's limit forced to 2 MiB | 0.6 MB and small gzip: 200, stored. 2 MB and the gzip body: 400 `http: request body too large`, nothing stored. Limiter: 503 `data refused due to high memory usage`, nothing stored | pass, with the 400 as a correction |
| 7 | Queue on local disk, with retries | `otlp_http` exporter with `sending_queue.storage: file_storage/queue` and `retry_on_failure.max_elapsed_time: 0`; `file_storage` extension with `fsync: true` | exporter stable, exporter queue and retry beta, file_storage beta | 20 requests with known counts, three times: writer stopped; writer stopped and collector stopped and started; writer stopped and collector killed and started. One batch while the writer answers 503; one batch while PostgreSQL is stopped | Every request answered 200 with the writer down, found in the queue file, no row. After the writer returns: 90 of 90, 99 of 99 and 85 of 85 requests, unchanged four seconds later. The 503 batch: 7 of 7. The PostgreSQL batch: 9 of 9 | pass |
| 8 | End to end | all of the above | | 6,000 simulated requests of two tenants, two services, two instances each, six route shapes, three minutes, as 24 OTLP requests (half gzip, half in the older convention, each tenant claiming to be the other). Then 280 real HTTP requests to a Node.js service exporting with the OpenTelemetry SDK, protobuf, delta temporality, one-second interval | 6,000 requests in 432 rows; every row equal to the expected count, duration sum and 15 bucket counts per tenant, service, route, method, status and minute; 2,973 and 3,027 per tenant. Real service: 280 requests in the 5 expected route, method and status groups, all under the token's tenant, over several export intervals | pass |
| 9 | The writer | `writer.mjs`, about 320 lines, not an upstream component | | everything above; the same 6 points as cumulative; the real service with cumulative temporality, once directly and once behind a tenant Collector with `cumulativetodelta` (beta); 28 unstorable batches; one undecodable body | Cumulative refused, nothing stored; behind `cumulativetodelta` 50 of 50 requests stored. Unstorable points refused for good, another tenant's batch stored 0.1 s later. Undecodable: 400. The only storage errors of the run are the ones provoked by stopping PostgreSQL | pass |

Sources for the first version, all at the pinned version:

- oidc extension: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/extension/oidcauthextension/README.md
  ("Configuring Public Keys", "Accessing JWT Claims").
- `from_context` and the `auth.` prefix: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/attributesprocessor/README.md
  and https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/resourceprocessor/README.md
- filter processor: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/filterprocessor/README.md
- transform processor (`scale_metric`, `aggregate_on_attributes`): https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/processor/transformprocessor/README.md
- OTTL functions (`replace_pattern` and the `$$` escape, `keep_keys`, `IsString`, `Len`, `Now`, `UnixNano`, `Concat`): https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/pkg/ottl/ottlfuncs/README.md
- `max_request_body_size`, checked on the wire and again after decompression: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/config/confighttp/README.md
- memory limiter: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/processor/memorylimiterprocessor/README.md
- queue and retry, "If set to 0, the retries are never stopped": https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/exporter/exporterhelper/README.md
- file storage and `fsync`: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.165.0/extension/storage/filestorage/README.md
- `otlp_http` exporter (`otlphttp` is now a deprecated alias) and `encoding: json`: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/exporter/otlphttpexporter/README.md
- no-op exporter: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/exporter/nopexporter/README.md
- stability levels: https://github.com/open-telemetry/opentelemetry-collector/blob/v0.165.0/docs/component-stability.md
- temporality values (delta is 1, cumulative is 2) and the field numbers `proto.mjs` uses: https://github.com/open-telemetry/opentelemetry-proto/tree/v1.9.0/opentelemetry/proto
- strkey types, lengths and test vectors: SEP-23 version 1.4.0, https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0023.md
- RE2 syntax, which lists lookaround as not supported: https://github.com/google/re2/wiki/Syntax

Where the sources are silent, and the run decided: what happens to a key that appears more
than once; that `aggregate_on_attributes` keeps points with different timestamps apart and
keeps a point without min and max apart; the status code of an oversized body; that a request
is refused before its body is read.

## Path-rule vectors

These 141 vectors were written for this experiment; 70 were added after the review, most of them the reviewer's cases. The
reference set of 91 vectors that the document mentions was not available, so nothing here says
the collector statements pass it. `expected` is written by hand in `vectors.mjs` and is not
computed from the rules. Long identifiers are shortened below as first six characters, last
four and the length. "limit" rows state what the rules do today with a case they get wrong or
cannot express.

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
| 26 | rewrite | `/blobs/9f86d0…00a0(63)` | `/blobs/{hash}` | as expected | 63 hex digits: any hex run of 24 or more is taken as a hash |
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
| 47 | limit | `/accounts/GATDOS…OWNA(57)` | `/accounts/{redacted}` | as expected | 57 characters: no strkey, but it holds a seed-like run and is redacted (the result depends on the letters) |
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
| 64 | rewrite | `users/list` | `/users/list` | as expected | no leading slash: one is added |
| 65 | rewrite | `users/123` | `/users/{id}` | as expected | no leading slash, numeric ID |
| 66 | limit | `/accounts/GATDOS…LOWA(56)` | `/accounts/{account}` | as expected | wrong checksum is still rewritten: a regular expression cannot compute CRC-16 |
| 67 | limit | `/users/123.json` | `/users/123.json` | as expected | identifier with a file extension is not rewritten |
| 68 | rewrite | `/accounts/GATDOS…LOWN(56):payments` | `/accounts/{account}:payments` | as expected | address followed by other text in the same segment |
| 69 | rewrite | `/users/alice@example.org` | `/users/{email}` | as expected | e-mail address |
| 70 | limit | `/users/jane-doe` | `/users/jane-doe` | as expected | free-text identifiers need the token heuristic, which is not a regular expression |
| 71 | limit | `/blobs/111111…1111(64)` | `/blobs/{id}` | as expected | a hash made only of digits is reported as a numeric ID |
| 72 | rewrite | `/v2/accounts/123` | `/v2/accounts/{id}` | as expected | version segment then numeric ID |
| 73 | rewrite | `/a/123/456/789` | `/a/{id}/{id}/{id}` | as expected | three adjacent numeric IDs |
| 74 | rewrite | `/123/users` | `/{id}/users` | as expected | numeric ID first |
| 75 | rewrite | `123` | `/{id}` | as expected | a bare number |
| 76 | rewrite | `/2026/11/19/post` | `/{id}/{id}/{id}/post` | as expected | date as three segments |
| 77 | keep | `/1.0/users` | `/1.0/users` | as expected | dotted version |
| 78 | rewrite | `/v10/x/7` | `/v10/x/{id}` | as expected | version then numeric ID |
| 79 | limit | `/users/-123` | `/users/-123` | as expected | negative number survives |
| 80 | limit | `/users/1.5` | `/users/1.5` | as expected | decimal number survives |
| 81 | limit | `/users/123,456` | `/users/123,456` | as expected | list of numbers survives |
| 82 | limit | `/users/123;v=2` | `/users/123;v=2` | as expected | matrix parameter survives |
| 83 | limit | `/users/1e5` | `/users/1e5` | as expected | exponent notation survives |
| 84 | limit | `/users/%31%32%33` | `/users/%31%32%33` | as expected | percent-encoded number survives |
| 85 | limit | `/users/123%20` | `/users/123%20` | as expected | number with a percent-encoded space survives |
| 86 | limit | `/users/١٢٣` | `/users/١٢٣` | as expected | non-ASCII digits survive |
| 87 | rewrite | `/orders/3f2b8c…1a2b(32)` | `/orders/{hash}` | as expected | UUID without dashes |
| 88 | limit | `/orders/{3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b}` | `/orders/{3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b}` | as expected | UUID in braces survives |
| 89 | limit | `/orders/urn:uuid:3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b` | `/orders/urn:uuid:3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b` | as expected | UUID as a URN survives |
| 90 | limit | `/orders/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b.pdf` | `/orders/3f2b8c1e-9d4a-4b7f-8a61-0c5e7d9f1a2b.pdf` | as expected | UUID with an extension survives |
| 91 | rewrite | `/tx/9F86d0…0A08(64)` | `/tx/{hash}` | as expected | mixed-case hash |
| 92 | rewrite | `/tx/0X9f86…0a08(66)` | `/tx/{hash}` | as expected | hash with 0X |
| 93 | rewrite | `/tx/9f86d0…6c15(56)` | `/tx/{hash}` | as expected | 56 hex digits |
| 94 | rewrite | `/tx/9f86d0…d015(96)` | `/tx/{hash}` | as expected | 96 hex digits |
| 95 | rewrite | `/obj/9f86d081884c7d659a2feaa0` | `/obj/{hash}` | as expected | 24 hex digits |
| 96 | limit | `/obj/9f86d081884c7d65` | `/obj/9f86d081884c7d65` | as expected | 16 hex digits survive |
| 97 | rewrite | `/claimable_balances/000000…0a08(72)` | `/claimable_balances/{hash}` | as expected | claimable balance ID, 72 hex digits |
| 98 | rewrite | `/effects/0000000012884905985-0000000001` | `/effects/{paging_token}` | as expected | paging token |
| 99 | rewrite | `/accounts/GATDOS…LOWN(56)/offers/123` | `/accounts/{account}/offers/{id}` | as expected | G-address then numeric ID |
| 100 | rewrite | `/k/SCRLHR…CYVQ(56)/` | `/k/{redacted}` | as expected | secret seed and trailing slash |
| 101 | rewrite | `/k/scrlhr…cyvq(56)` | `/k/{redacted}` | as expected | lower-case secret seed |
| 102 | rewrite | `/k/SCRLHR…LCYV(55)` | `/k/{redacted}` | as expected | secret seed one character short |
| 103 | rewrite | `/k/seed=SCRLHR…CYVQ(56)` | `/k/{redacted}` | as expected | secret seed after other text in the segment |
| 104 | rewrite | `/k/SCRLHR…CYVQ(56).txt` | `/k/{redacted}` | as expected | secret seed with an extension |
| 105 | rewrite | `/k?seed=SCRLHR…CYVQ(56)` | `/k` | as expected | secret seed in the query string |
| 106 | limit | `/k/SCRLHR…OGBJ(40)` | `/k/SCRLHR…OGBJ(40)` | as expected | the first 40 characters of a secret seed survive |
| 107 | rewrite | `/x/PBIW5C…DTVQ(114)` | `/x/{strkey}` | as expected | signed-payload strkey, 114 characters |
| 108 | rewrite | `/assets/USDC:GATDOS…LOWN(56)` | `/assets/USDC:{account}` | as expected | asset code and issuer |
| 109 | rewrite | `/assets/USDC-GATDOS…LOWN(56)` | `/assets/USDC-{account}` | as expected | asset code and issuer with a dash |
| 110 | rewrite | `/accounts/GATDOS…LOWN(56).json` | `/accounts/{account}.json` | as expected | G-address with an extension |
| 111 | rewrite | `/contracts/CBSHLB…HQT5(56):events` | `/contracts/{contract}:events` | as expected | C-address followed by other text |
| 112 | rewrite | `/accounts/id=MCBZJJ…LHJ2(69)` | `/accounts/id={muxed_account}` | as expected | M-address after other text |
| 113 | limit | `/accounts/%47ATDO…LOWN(57)` | `/accounts/%47ATDO…LOWN(57)` | as expected | G-address with a percent-encoded first letter survives |
| 114 | limit | `/accounts/GATDOS…LOWN(112)` | `/accounts/{redacted}` | as expected | two G-addresses joined: redacted because they hold a seed-like run (the result depends on the letters) |
| 115 | rewrite | `/pay/GATDOS…LOWN(56)/CBSHLB…HQT5(56)/MCBZJJ…LHJ2(69)` | `/pay/{account}/{contract}/{muxed_account}` | as expected | three strkeys in a row |
| 116 | rewrite | `GATDOS…LOWN(56)` | `/{account}` | as expected | a bare G-address |
| 117 | rewrite | `/GATDOS…LOWN(56)` | `/{account}` | as expected | G-address as the only segment |
| 118 | keep | `/users/<id>` | `/users/<id>` | as expected | angle-bracket template |
| 119 | keep | `/users/*` | `/users/*` | as expected | wildcard template |
| 120 | rewrite | `/users/{id}/` | `/users/{id}` | as expected | template with a trailing slash |
| 121 | rewrite | ` ` | `/` | as expected | empty route |
| 122 | rewrite | `//` | `/` | as expected | two slashes |
| 123 | rewrite | `?a=1` | `/` | as expected | query string only |
| 124 | rewrite | `/a?token=secret` | `/a` | as expected | secret in the query string |
| 125 | rewrite | `/a?q=x\x0ay=secretline` | `/a` | as expected | query string with a newline |
| 126 | rewrite | `/a\x0a/users/123` | `/a` | as expected | newline in the path: everything after it is removed |
| 127 | rewrite | `/a\x00/users/123` | `/a` | as expected | NUL in the path |
| 128 | rewrite | `/a b/123` | `/a b/{id}` | as expected | space in a segment |
| 129 | rewrite | `/a/../123` | `/a/../{id}` | as expected | dot segments are not resolved |
| 130 | rewrite | `http://api.example.org/users/123` | `/users/{id}` | as expected | absolute URL: scheme and host removed |
| 131 | rewrite | `https://api.example.org:8443` | `/` | as expected | absolute URL without a path |
| 132 | rewrite | `/auth/eyJhbG…VCJ9(36).eyJzdWIiOiJ1c2VyLTQyIn0.c2lnbmF0dXJlLWJ5dGVz` | `/auth/{jwt}` | as expected | JWT |
| 133 | limit | `/phone/+5491155551234` | `/phone/+5491155551234` | as expected | phone number survives |
| 134 | limit | `/ip/192.168.1.10` | `/ip/192.168.1.10` | as expected | IP address survives |
| 135 | rewrite | `/a/a/…(6000)123` | `/(too_long)` | as expected | route of 6,004 characters |
| 136 | rewrite | `/users/999999…9999(5000)` | `/(too_long)` | as expected | numeric ID of 5,000 digits |
| 137 | rewrite | `/seg/123/seg/123/…(800)` | `/seg/{id}/seg/{id…(899)` | as expected | 100 numeric IDs in one route |
| 138 | rewrite | `/tx/9f86d0…0a08(64)/operations/1111111111111111111` | `/tx/{hash}/operations/{id}` | as expected | hash then numeric ID |
| 139 | rewrite | `/files/a//b` | `/files/a/b` | as expected | doubled slash inside a path |
| 140 | keep | `/GATEWAY/CONFIG` | `/GATEWAY/CONFIG` | as expected | capital words |
| 141 | rewrite | `/api/v1/` | `/api/v1` | as expected | version and trailing slash |

### Raw identifiers that can still be stored

A route is free text, and the rules know a fixed list of shapes. These survive today, each
with a "limit" vector above:

- numbers that are not plain digits: negative, decimal, exponent, a comma list, with a matrix
  parameter, with a file extension (`123.json`), in non-ASCII digits;
- anything percent-encoded, including an address whose first letter is `%47`;
- a UUID in braces, as a URN or with a file extension;
- a hex run shorter than 24 digits;
- a strkey other than a seed in lower case, with a wrong length, or joined to other base-32
  text without a separator (two addresses joined are redacted only when their letters happen
  to form a seed-like run);
- a fragment of a secret seed shorter than 52 characters;
- phone numbers, IP addresses, names and other free text, which the document leaves to a
  token heuristic that was not attempted here;
- anything at all in `service.name` and `service.instance.id`, which no rule reads.

The second review added these, each reproduced against this configuration:

- a secret seed in a form the rule does not see: without its leading `S` (55 or 54 characters,
  which is the whole secret), with its first letter percent-encoded or written as a full-width
  `S`, hyphenated, spaced or broken by a dot or a zero-width space, split across two segments,
  reversed, or base64-encoded;
- the first of two addresses in one segment (`/offers/USDC:G1,EURC:G2` keeps the first);
- T, X, L, B and W strkeys next to other text;
- hex or a UUID with a prefix or a suffix;
- a JWT after other text;
- `http.request.method`, which is free text: up to 32 bytes are stored, and a longer value
  reaches the disk queue before the writer refuses it.

So the statement in the architecture document that secret seeds are "always redacted" cannot be
kept with a fixed rule set. A regular expression recognizes a seed only in its canonical form.

No longer surviving, with vectors: claimable-balance IDs (72 hex digits), paging tokens,
signed-payload strkeys, `USDC:G...`, hex runs of 24, 56 and 96 digits, e-mail addresses, JWTs.

Two rules redact more than a strict reading asks: a strkey look-alike with a wrong checksum is
normalized, because a regular expression cannot compute CRC-16, and any segment with a
seed-like run of 52 characters is redacted whether or not it is a seed.

What RE2 or OTTL cannot express: a segment boundary after a match (worked around by doubling
the slashes), the strkey checksum, and percent-decoding, for which no upstream function was
found. The statements cannot tell a hand-set `http.route` from one copied from `http.target`
once both are in the same attribute; the same rules run on both.

## What a reviewer changing one condition will see

One change to `collector.yaml` at a time, run on 2026-11-19. The first block was run against
the first version, the second against this one.

| Change | Outcome |
| - | - |
| first version, unchanged, five runs | exit 0 |
| remove `- { key: tenant.id, action: delete }` | fails: a payload claiming tenant B is stored for B |
| remove `auth` from the receiver | fails: no point is stamped and none is stored |
| remove the filter condition on a missing `tenant.id` | fails: the resource without a tenant reaches the writer |
| remove the numeric-ID statement | fails: 12 vectors |
| remove `keep_keys` on point attributes | fails: attributes and merge |
| remove `storage: file_storage/queue` | fails: nothing on disk, nothing survives a restart |
| `fsync: false` | **still passes** |
| `max_elapsed_time: 300s` | **still passes** |
| this version, unchanged | exit 0, 123 of 123 assertions, 141 of 141 vectors |
| remove `transform/strip` from the pipeline | fails: 20 assertions, the first a payload claiming tenant B stored for B |
| replace `delete_matching_keys` with `delete_key` (in the script, as a control) | 3 copies of `tenant.id` = B are stored for B |
| remove `keep_keys(datapoint.attributes, [])` (in the script, as a control) | the raw address of a duplicated route is in the queue |
| remove `set(datapoint.exemplars, nil)` (in the script, as a control) | the exemplar and its trace ID are in the queue |
| remove `where IsString(datapoint.attributes["http.route"])` | fails: non-string routes are stored as sent |
| this version, unchanged, four more runs after the last change to the script | exit 0 each |

The writer's fixes cannot be removed by a line of configuration; their RED runs are in the
table at the top.

## Not covered, and stated plainly

- **Delivery is at least once and this writer does not remove duplicates.** The script shows
  it: one batch of 4 requests sent three times stores 12. The review measured a collector
  killed in the middle of a delivery: 3,750 requests sent, 3,840 stored, 2.4% too many. The
  kill and restart cases of point 7 pass because the writer is down while the collector is
  killed, so nothing is half delivered. The point-level key the document describes is not
  implemented here.
- **A tenant gets no error for data that is stored nowhere.** Bucket bounds other than the 14
  advised, the older SDK bounds that start at 0, cumulative data, a status code sent as a
  string and every other unstorable point are answered 200 by the collector, because it
  accepts a request before the writer sees it. The script asserts this as a finding.
- **The Builder.** The run uses the contrib image restricted by configuration.
- **"Synced".** `fsync: true` is configured. Killing the collector process does not lose a
  batch with or without it; only a power loss or a kernel crash would show the difference.
- **"Retries that never expire".** `max_elapsed_time: 0` is configured and documented. The
  longest outage in the run is a few seconds, far below the default limit of 300 seconds.
- **A full queue**, and what the tenant's exporter then sees.
- **Key rotation.** The oidc extension watches the key file and reloads it (read in
  `extension.go` at v0.165.0, not run). Revocation cannot happen at the edge with an offline
  token; the document already puts it in the writer.
- **Signing algorithms other than RS256**, and tokens with a 13-month life.
- **The older convention from a real exporter.** The Node.js HTTP instrumentation at 0.301.2
  emits only the stable metric, so the older metric was tested with hand-written payloads.
- **Exponential histograms** are dropped by the filter. Converting them at the edge was not
  tried.
- **Minute boundaries with a real exporter.** The real service's rows are compared summed over
  minutes, because the minute of a point is the SDK's collection time; per-minute equality is
  shown with the hand-written exports only.
- **Protobuf beyond what `proto.mjs` writes.** Duplicated keys were sent in JSON and in
  protobuf; other malformed protobuf was not explored.
- **Load.** 6,000 requests in 24 exports is a correctness run, not the design volume. The cost
  of the statements added per data point was not measured.
- **gRPC.** Only OTLP/HTTP is enabled, as in the document's contract.
- **The repository's `ingest_token` table** stores the hash of a random token, which needs a
  database lookup; the document's signed token does not use it. The two are not reconciled
  here.
- **`api_metric_minute` has no minimum and maximum columns**, while the document lists them.
  Min and max were checked at the writer's input, not in storage.

Observed and not part of the verdict: the 401 answer includes the verifier's reason (for an
expired token, the expiry time), and each refusal is logged at warning level with the client
address.

## What the writer does and does not implement

`writer.mjs` receives the collector's export as OTLP/HTTP JSON. It refuses for good, with a
reason: a resource without a UUID `tenant.id` or with a repeated attribute key; anything that
is not `http.server.request.duration` in seconds with delta temporality; a point with a
repeated key, without a string route and method or an integer status code from 100 to 599,
with a control character or an over-long name, with bounds other than the 14 advised, with
bucket counts that do not fit or do not add up, with a count above 2^53 or a negative or
missing sum; and a row PostgreSQL itself refuses, such as a tenant that is not enrolled. It
stores the rest in one transaction per batch, each row under a savepoint and in key order, and
answers 200 after the commit, 400 for an undecodable body and 503 when storage is unavailable.

Not implemented: tenant status and token revocation, the timestamp window against the time of
receipt, re-bucketing, point-level deduplication, the per-tenant quota, the series cap and its
"(other)" series, TLS and the ingest role. Its port is published on localhost for the
experiment; the document's writer accepts the local collector only.
