# Pulse proof of concept

Pulse is a shared web and API analytics service for projects built on Stellar. This repository is
a working prototype of its tenant and operator consoles and its public view. It tests the riskiest assumptions and
records a demo.

## Quick start

- Live demo: https://usage-signals-poc.vercel.app
- Demo video: https://vimeo.com/1248550588
- Try the gateway checks: in [`console/README.md`](console/README.md#try-the-gateway-checks)

## RFP requirements

| RFP | Requirement | Status | Where |
| --- | --- | --- | --- |
| 3.1 | Many projects, each with its own sites | Partial: sites are created at deploy time | [`schema.sql`](console/db/schema.sql), [`seed-profile.mjs`](console/scripts/seed-profile.mjs) |
| 3.1 | Each tenant sees only its own data, operators see all | Partial: each endpoint answers for one project, but there is no sign-in | [`web-read.test.mjs`](console/test/web-read.test.mjs), decision 38 in [`DECISIONS.md`](DECISIONS.md) |
| 3.1 | Self-service enrollment, removal, approval mode | Planned | |
| 3.1 | OSI-approved license | Built | [`LICENSE`](LICENSE) |
| 3.1 | One monorepo with infrastructure as code | Partial: Vercel and Docker files only | [`vercel.json`](console/vercel.json), [`docker-compose.yml`](console/docker-compose.yml) |
| 3.1 | Operator API keys for metrics | Planned | |
| 3.2 | Events only from frontend code, bot and inflation defense | Partial: Origin check, forged fields refused, three flag rules (known bot, missing `Sec-Fetch-*` headers, many User-Agents from one network) with flagged traffic counted apart; no fingerprint check | [`gateway.js`](console/lib/gateway.js), [`flags.js`](console/lib/flags.js), [`gateway.test.mjs`](console/test/gateway.test.mjs) |
| 3.2 | Low-friction install | Partial: one script tag, tried on static pages only | [`demo-site.js`](console/lib/demo-site.js) |
| 3.2 | Tracker pinned to a version | Built | [`pin-tracker.mjs`](console/scripts/pin-tracker.mjs), [`gateway.test.mjs`](console/test/gateway.test.mjs) |
| 3.2 | Supply-chain defense | Partial: pinned file with SRI, Umami rebuild in check 6 | [`manifest.json`](console/public/s/manifest.json), [check 6](checks/check-06/README.md) |
| 3.2 | The seven metrics | Built | [`gateway.test.mjs`](console/test/gateway.test.mjs), [`web-read.test.mjs`](console/test/web-read.test.mjs) |
| 3.2 | Custom events (nice to have) | Partial: forwarded to Umami, not shown | [`gateway.js`](console/lib/gateway.js) |
| 3.2 | Wallets Kit capture (nice to have) | Partial: check 8 only | [check 8](checks/check-08/README.md) |
| 3.2 | Names that ad blockers do not block | Planned | |
| 3.2 | GDPR without opt-in | Partial: address truncated before storage; residency, jurisdictions and erasure not written | [`client-address.js`](console/lib/client-address.js), [`client-address.test.mjs`](console/test/client-address.test.mjs) |
| 3.2 | Tenant web dashboard | Partial: seven metrics for 7, 30 and 90 days; no sign-in | [`tenant/web.html`](console/public/tenant/web.html) |
| 3.2 | Operator web dashboard: filter, sort, compare | Partial: no sign-in | [`operator/projects.html`](console/public/operator/projects.html), [`web-read.test.mjs`](console/test/web-read.test.mjs) |
| 3.3 | Collector drops traces and logs, writes metrics to PostgreSQL | Partial: `POST /v1/metrics` takes the HTTP server duration histogram over OTLP/HTTP JSON and refuses the rest; the collector is in check 5 only | [`ingest.js`](console/lib/ingest.js), [`ingest.test.mjs`](console/test/ingest.test.mjs), [check 5](checks/check-05/README.md) |
| 3.3 | Required attributes and default path rules | Built: the check 5 rules in JavaScript, held to its 165 vectors | [`route-rules.js`](console/lib/route-rules.js), [`route-rules.test.mjs`](console/test/route-rules.test.mjs) |
| 3.3 | Tenant isolation on the API path | Partial: the ingest token decides the project, never the request; no sign-in to read | [`ingest-tokens.js`](console/lib/ingest-tokens.js), [check 5](checks/check-05/README.md) |
| 3.3 | 1,000,000 requests a day | Partial: one day's disk use measured in check 5 | [check 5](checks/check-05/README.md) |
| 3.3 | 24-month retention | Planned | |
| 3.3 | Tenant and operator API dashboards | Partial: Demo site A from its demo API through `/v1/metrics`, Demo sites B and C on sample data; no sign-in | [`tenant/requests.html`](console/public/tenant/requests.html), [`api-read.js`](console/lib/api-read.js), [`demo-api.js`](console/lib/demo-api.js) |
| 5 | Automated test suite | Built | [`console/test/`](console/test/), [`checks/`](checks/README.md) |
| 5 | Tenant screen-capture video | Built | [Demo video](https://vimeo.com/1248550588) |
| 5 | Three SCF projects and one API project live | Partial: Strata Vault Kit is live for web; Demo site A's demo API sends real API metrics; demo sites stand in for the rest | [`seed-profile.mjs`](console/scripts/seed-profile.mjs) |
| 5 | Runbooks, onboarding guide, monitoring, compliance statements | Planned | |

> [!NOTE]
> Section 3.4 (hosting, support, handover) and the zero-fees rule are commitments of the proposal.
> A prototype cannot show them.

## Where to go next

- [`console/README.md`](console/README.md): what the prototype does and how to run it on your machine.
- [`checks/README.md`](checks/README.md): the architecture checks and their results.
- [`DECISIONS.md`](DECISIONS.md): each technical choice, its source, the alternative rejected and the known limits.
- [`architecture.md`](architecture.md): the code layout, the routes and the data flow.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): setting up the repository and running the tests.

## License

Apache-2.0. The tracker file under `console/public/s/` is Umami's and is MIT licensed.
