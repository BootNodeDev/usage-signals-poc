# Notes for the product

What building this prototype taught us that the product should start from. Each entry says what we found, why it matters for the product, and where it came from. [`DECISIONS.md`](DECISIONS.md) records what the prototype chose; this file records what the product needs to know. The product will not run on the prototype's hosting, so each entry is written to hold on any platform.

## Reading from Umami

- **Umami answers per hour only for ranges of 30 days or less.** Umami 3.5.0 replaces `unit=hour` with `unit=day` beyond that (`getMinimumUnit` in `umami/src/lib/date.ts`). Any job or view that asks Umami for hours must keep its window at 30 days, or read our own rollups instead. Found in PR #28.
- **Umami's "set" and "not set" filters build no SQL on PostgreSQL.** `mapFilter` falls through to its default branch, so the filter is silently ignored. Flag filters use a regular expression on the tag instead. Found in PR #29, decision 54.
- **Umami's own bot check drops bot events before they are stored.** To flag bots instead of losing them, the product runs Umami with `DISABLE_BOT_CHECK=1` and flags at the gateway. Found in PR #29, decision 53.
- **A tag filter and the code that reads the tag must agree on case.** The prototype filters flagged events case-insensitively but maps tags to rules case-sensitively, so a tag such as `BOT` counts as flagged under no rule. The product should normalise tags when it writes them. Found in the review of PR #29.

## Scheduled jobs

- **A scheduled run can arrive twice, or not at all.** Schedulers deliver at least once on a best-effort basis, so every job must be idempotent, reconcile against what is already stored, and exclude two runs at once with a lock. Found in PR #28.
- **Session-level advisory locks do not work through a transaction-mode connection pooler.** PgBouncer in transaction mode hands each transaction to any server connection; take `pg_try_advisory_xact_lock` inside a transaction instead. Found in PR #28.
- **Inputs that grow with time must be tested at the size production reaches.** The first sample job worked for an hour and would have broken after 30 days. Found in PR #28.
- **Every job needs a bound per run and a count of what is left.** Without one, a backlog turns into one long run that holds the lock. Found in the review of PR #32.
- **Time windows must start on a whole hour.** A window that starts mid-hour shifts every planned hour, and the next run writes the same hours again at other minutes. Found in PR #32.

## Figures and views

- **Percentiles from fixed buckets are estimates.** p95 is interpolated inside the bucket that holds it, so a p95 of 386 ms means "between 250 and 500 ms". The product labels them as estimates, as the architecture document asks, and keeps one set of bucket bounds for every tenant so histograms can be summed. Found in PR #32.
- **API metrics belong to a project, web metrics to a site.** One project can have several sites, so a view per site must not repeat the project's API figures on each of them. Found in the review of PR #32.
- **One failing source must not blank a whole view.** The operator view reads each project's API figures on its own and shows the rest when one fails (PR #32). The public view still fails as a whole when one site's Umami read fails (review of PR #36).
- **Hiding counts of 1 to 9 is not enough on its own.** When a total is exact and only one of its parts is hidden, subtraction recovers it. The product needs secondary suppression, or totals that are hidden with their parts. Found in the review of PR #29.
- **Sample data must be marked and must not predate the service.** Sample page views carry Umami's tag `sample`, sample API rows a service name used only by the sample, and nothing is dated before the prototype went live. Found in PRs #28 and #32.

## Bot and abuse rules

- **Counting User-Agents per /24 network flags real people on shared networks.** Carrier NAT, offices and campuses pass 10 distinct User-Agents quickly, and their visits leave the counted figures for the rest of the day. The product needs a threshold measured on real traffic, or a key narrower than /24. Found in the review of PR #29.

## API ingestion

- **The OpenTelemetry JavaScript SDK does not use the advised bucket bounds by default, and exports cumulative by default.** A project must set the 14 bounds through `advice.explicitBucketBoundaries` (or a view) and ask for delta, or every point is refused. The product's writer can re-bucket other bounds conservatively, as the architecture document plans, and onboarding must say both settings. Found in PR for issue #21, checked with `@opentelemetry/exporter-metrics-otlp-http` 0.301.2.
- **The route rules now exist as a JavaScript module held to the check 5 vectors.** The product needs the same rules twice (collector and tracker); keeping one vector set that both implementations must pass is what keeps them equal. Found in PR for issue #21.
- **The project must come from the token, never from the request.** The prototype replaces any `tenant.id` a client sends with the token's project, as the product's collector does. Found in PR for issue #21.
- **A token checked in the database costs one query per export.** The prototype looks up the ingest token's hash on each request; the architecture document's signed token, checked against a local key, removes that query from the accept path at the price of key management and slower revocation. Found in PR for issue #21.
- **Most refusals answer 200.** OTLP answers refused points with 200 and `partialSuccess`, so a project only sees them if it reads the response or the console shows the refusal counts. The product needs refusal counts on the project's screen. Found in check 5 and PR for issue #21.

## Metrics API and keys

- **Key management needs sign-in before it gets a screen.** Without sign-in, a screen would let anyone make a key, so the prototype manages keys from the command line, which needs `DATABASE_URL`. The product puts the same create, list and revoke behind operator sign-in, and records the signed-in account as the actor in the audit log. Found in PR #40.
- **Every keyed request writes to the database.** The prototype stores the last-used time and a per-minute count on each request, one write per read. At product volume, count requests outside the database (in memory or a shared cache) and write last-used times in batches. Found in PR #40.
- **A contract test keeps the API description honest.** The prototype checks the real answers against its OpenAPI description with a small validator; the product can publish the same description and run a full JSON Schema validator in CI. Found in PR #40.
- **The metrics API should read rollups, not Umami.** The prototype reads Umami live, so an Umami upgrade can change the answer; the product reads its own rollup tables, as the architecture document says. Found in PR #40.

- **A configuration mistake in one feature must not stop ingestion.** The prototype serves the event gateway and every API from one process, so a setting that throws at start would stop event collection too. Validate settings per feature and fail that feature alone, and run ingestion apart from the read APIs, as the architecture document's separate components do. Found in the native review of PR #40.

## Platform

- **Review environments must not share the production database and Umami.** In the prototype, building a branch for review applies its schema to production, and trying it writes production data. The product needs its own database and Umami per environment. Found in PR #29, decision 55.
- **`pg` warns that `sslmode=require` will change meaning.** The production logs show the warning on several cron runs. The product should set `sslmode=verify-full` in its connection string. Found in the production logs after PR #28.
