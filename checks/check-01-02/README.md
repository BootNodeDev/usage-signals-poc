# Checks 1 and 2: forwarding through Umami's batch route

Run on 2026-11-19 against Umami 3.5.0 and PostgreSQL 18, the images pinned in `compose.yml`.

Round two, run on 2026-11-24, is the last section of this file. It corrects one statement of
round one (visits and the clock hour) and closes three of the gaps listed under "Not covered".

## Verdicts

| Check | Verdict |
|---|---|
| 1. Batch route with gateway-supplied country, browser, OS, device, timestamp and salt gives the same seven metrics as direct ingestion | **Passes with a stated correction to the design**: every metric is equal, but only when Umami runs with `ENABLE_CLIENT_SALT=1` and the forwarder sends a User-Agent that Umami's bot check accepts. |
| 2. The country reaches Umami by header (placeholder address in the proxy header, no ip in the payload, one batch per country), so that no part of the IP is written to disk | **Passes as written**, with one precision: the placeholder must not be a private, loopback, unspecified or invalid address. |

## Reproduce

```sh
node run.mjs
```

About 40 seconds from a cold start (4 seconds with `--keep` once the stack is up). It needs
Docker and Node 24 or newer, starts the compose project `us-check-01` on ports 55101, 33101 and
33102, prints the tables below, removes the stack, and exits 1 if any fact a verdict rests on
no longer holds.

## Corrected sentences for the architecture document

Check 1, replace with:

> Forwarding through Umami's batch route with gateway-supplied country, browser, OS, device,
> timestamp and salt gives the same seven metrics as direct ingestion, **provided Umami runs
> with `ENABLE_CLIENT_SALT=1` and the forwarder identifies itself with a User-Agent that
> Umami's bot check accepts.**

Check 2, add the precision:

> The country reaches Umami by header (**a documentation-range placeholder address, for
> example 192.0.2.1,** in the proxy header, no ip in the payload, one batch per country), so
> that no part of the IP is written to disk.

Two other sentences of the document are affected by the same findings:

- "Umami's own check stays enabled behind the gateway" (Bot and inflation defense): behind the
  forwarder that check only ever sees the forwarder's own User-Agent, so it filters nothing.
  The gateway's check is the only one.
- "with ... the per-visitor value as salt": true only with the setting above. Umami ignores a
  client salt by default.

## Evidence: check 1

Nine page views from five visitors, replayed five hours in the past, sent two ways into two
websites of the same Umami. Direct: one request per event, the visitor's address in
`x-forwarded-for` and its own User-Agent. Forwarded: `POST /api/batch`, one batch per country,
with `browser`, `os`, `device`, `timestamp` and `salt` in every item, the placeholder address
in `x-forwarded-for`, the country in `cf-ipcountry`, and no `ip` or `userAgent` in the payload.

| Metric | Direct | Forwarded | Equal | Note |
|---|---|---|---|---|
| Page views | 9 | 9 | yes | |
| Unique visitors | 5 | 5 | yes | All five share one forwarder address and User-Agent; only the salt separates them. |
| Visits | 6 | 6 | yes | One visitor crosses a clock hour and counts as two visits on both sides: Umami cuts visits at the hour. **Corrected in round two:** this holds only when the token of Umami's tracker is not resent, as on a multi-page site. Round one's direct side did not resend it. |
| Referrers | news.ycombinator.com 1, stellar.org 2 | the same | yes | |
| Session duration | 600 s over 6 visits | 600 s over 6 visits | yes | Follows the supplied timestamps, not the time of the replay. |
| Bounce rate | 4 of 6 | 4 of 6 | yes | |
| Country | AR 1, AU 1, DE 1, US 2 | the same | yes | Direct: from Umami's own geo database. Forwarded: from the header. |
| Device | desktop 4, mobile 1 | the same | yes | |
| Browser | chrome 3, firefox 1, ios 1 | the same | yes | |
| OS | Linux 1, Mac OS 1, Windows 10 2, iOS 1 | the same | yes | |

There is no difference to explain. The scenario covers several visitors, a three-page visit, a
bounce, four countries, mobile and desktop, a replay hours in the past, a visit across an hour
boundary, and two visitors with the identical browser build.

Controls, each on its own website:

| Control | Result |
|---|---|
| A. The same batches into Umami with default settings | 9 page views but **1 visitor**, 4 visits, one country, one browser. The salt is ignored and all visitors collapse into one session. |
| B. Per-visitor value in `id` instead of `salt`, default settings | All metrics equal to direct ingestion. But the value is then written to the database (5 of 5 found in the dump); as `salt` it is not (0 of 5). |
| C. Batches sent with the HTTP client's default User-Agent (`node`) | Umami answers 200 and reports every item "processed", and stores **nothing**. |

## Evidence: check 2

Placeholder address in `x-forwarded-for`, `cf-ipcountry: UY`, no `ip` in the payload:

| Address | Kind | Country stored |
|---|---|---|
| 192.0.2.1, 198.51.100.1, 203.0.113.1 | Documentation ranges (RFC 5737) | UY |
| 2001:db8::1 | IPv6 documentation range (RFC 3849) | UY |
| 100.64.0.1 | Shared address space (RFC 6598) | UY |
| 240.0.0.1 | Reserved, class E | UY |
| 9.9.9.9 | A public address (works, but it belongs to someone) | UY |
| 10.0.0.1 | Private (RFC 1918) | none |
| 127.0.0.1 | Loopback | none |
| 0.0.0.0 | Unspecified | none |
| `not-an-address` | Not an address | none |

In every case the event itself is stored; only the country is lost.

After the run, a full `pg_dump` and the logs of the three containers were searched for the
five visitor addresses, their truncated forms (/24 and /48) and the placeholder: **none is in
either.** Umami has no address column; the address only enters the session hash.

One batch per country is required, not optional: the batch route copies the request's headers
onto every item, so a batch has exactly one country.

## What the source says (Umami at tag v3.5.0)

| Question | Answer | Where |
|---|---|---|
| What does the batch route apply per item and per request? | The payload per item; the request headers are copied to every item. At most 500 items. | `src/app/api/batch/route.ts:7`, `:26-36` |
| Are `browser`, `os`, `device` honoured? | Yes, always: a payload value wins over detection from the User-Agent. | `src/lib/detect.ts:143-145`; accepted at `src/app/api/send/request-schema.ts:102-104` |
| Is `timestamp` honoured? | Yes, always, in seconds; it becomes the event time and marks the event as historical. | `src/app/api/send/route.ts:106`, `:118` |
| Is `salt` honoured? | Only when `ENABLE_CLIENT_SALT` is set. It is mixed into Umami's own salt and does not replace it, so Umami's rotation (monthly by default, keyed on the event time) still applies on top. | `src/lib/collection-session.ts:106-109`; `src/lib/crypto.ts:88-101` |
| Is `id` honoured? | Yes, always; it is part of the session hash and is stored as the distinct id. | `src/app/api/send/route.ts:107`; `src/lib/collection-session.ts:111` |
| How is the session derived? | `uuid(site, address, userAgent, sessionSalt, distinctId)`; the visit from the session and the clock hour of the event. | `src/lib/collection-session.ts:110-113` |
| Where does the country come from? | From the first location header present (`cf-ipcountry` first), unless the payload carries `ip`. | `src/lib/detect.ts:12-47`, `:95-109`, `:139` |
| Can a placeholder address work? | Yes, unless it is local or invalid: then no location is returned before any header is read. | `src/lib/detect.ts:90-93` |
| What does the bot check look at? | The request's User-Agent (or a payload `userAgent`), for every item; a match is answered 200 with `{"beep":"boop"}` and nothing is stored. | `src/app/api/send/route.ts:91-99` |

Documentation: `ENABLE_CLIENT_SALT` and `DISABLE_BOT_CHECK` at
https://docs.umami.is/docs/environment-variables; the batch route at
https://docs.umami.is/docs/api/sending-stats. The documentation does not mention `timestamp`,
`browser`, `os`, `device` or `salt` as payload fields: they are in the source only, so an
upgrade of Umami can change them without notice.

## What worked and what did not

- **Worked:** `salt` with `ENABLE_CLIENT_SALT=1`; a documentation-range placeholder; the
  country in `cf-ipcountry`; a forwarder User-Agent of `Mozilla/5.0 UsageSignalsForwarder/1.0`.
- **Did not work:** `salt` with default settings (control A); a private, loopback or invalid
  placeholder; a forwarder User-Agent of `node`, `UsageSignalsForwarder/1.0` or
  `Mozilla/5.0 (compatible; UsageSignalsForwarder/1.0)`, all classed as bots.
- **Works but not recommended:** the per-visitor value in `id` (control B), because it is then
  stored.

## Not covered

Round two covers three of these: duplicate delivery, the spool and logs of a gateway, and a
direct side without a `timestamp`. The others stand.

- `DISABLE_BOT_CHECK=1` on Umami as the alternative to a browser-like forwarder User-Agent. It
  is documented; it was not run here.
- A daily change of the per-visitor value across two days. From the source, a new value gives a
  new session, which is what "counted once per day" needs; it was not run.
- Duplicate delivery of a batch (the document's "at-least-once" limit), batches near the
  500-item cap, and concurrent batches.
- The gateway's own spool and logs. "No part of the IP is written to disk" was checked for
  Umami's database and the three containers' logs only.
- The direct side carries a `timestamp` too, the only field a browser would not send, because
  events cannot otherwise be placed hours in the past. Neither side sends a screen size, so
  desktop and laptop are not told apart on either.
- Umami on Vercel. This ran on the Docker image, which has a geo database; on Vercel the direct
  side would take its country from the platform's header instead.

## Round two (2026-11-24)

Same Umami 3.5.0 and PostgreSQL 18 images, in a second stack (`compose.round2.yml`, compose
project `us-check-01-r2`, host ports assigned by Docker). Round one's script is unchanged.

### Verdicts

| Claim | Verdict |
|---|---|
| A. Forwarded metrics equal direct ingestion also for visits that cross the clock hour | **Yes, within one UTC day, with two conditions.** (1) The spool record carries a value that is the same for every event of one page load: a new field in the tracker's payload and in the record. (2) The forwarder's memory of running visits survives a restart. Across 00:00 UTC the two paths differ by design: the per-visitor value changes, so the forwarded path counts a new visitor and a new visit. |
| B. The conditions of check 1 are enforced by a probe that fails when one is violated | **Yes.** Seven violating deployments, seven caught, the silent drop included. |
| C. Duplicates | **Not prevented, but removable: yes, with stated conditions.** Unmodified Umami stores a resent event again. A count detects it, and deleting the affected sessions through Umami's API and replaying them from the spool restores the exact metrics. Corrected after review: the first version of this section said a duplicate could not be removed. |
| D. No part of the IP is written to disk in the preferred path | **Yes**, for the gateway model of this experiment, the forwarder and Umami. The product gateway has no spool yet and was not scanned. |

For the architecture document: check 1 is yes within a UTC day with the two conditions of A,
and its round-one conditions are now a test. Check 2 is yes for everything this experiment can reach.

### Reproduce

```sh
node round2.mjs      # roughly 75 to 100 s from a cold start; exits 1 if a fact does not hold
node controls.mjs    # about twelve minutes; one unchanged run, then fourteen mutated runs
UMAMI_URL=... UMAMI_USERNAME=... UMAMI_PASSWORD=... node probe.mjs   # the probe on its own
```

Docker and Node 24 or newer. No npm package. One new download: `libfaketime` 0.9.14-r0 from
the Alpine 3.24 package mirror, fetched by a helper container on first start. It is needed
because direct ingestion takes the event time from Umami's clock. The library is preloaded
into a third process of the unmodified Umami image (`umami-clock`), and the script sets that
process's clock before each direct request. The Umami the forwarder posts to has no preload.

Files: `round2.mjs` (the run), `gateway.mjs` (gateway model and spool), `forwarder.mjs`,
`probe.mjs`, `scan.mjs`, `stack.mjs`, `mutation.mjs` and `controls.mjs` (negative controls).

### A. Visit continuity

**What direct ingestion does.** Umami's tracker keeps the `cache` token of the last answer in a
variable of the page and resends it in `x-umami-cache` (`src/tracker/index.ts:484-492`). With a
token, Umami keeps the visit until an event arrives more than 30 minutes after the visit
began, whatever the clock hour (`src/lib/collection-session.ts:113-118`). Without one, the
visit id is derived from the session and the clock hour. A full page load loses the variable,
so a multi-page site is cut at the hour and a single-page app is not.

**What was run.** 23 page views from 8 visitors, sent two ways. Direct: `/api/send`, no
`timestamp`, the visitor's address and User-Agent, the token resent per page load, Umami's
clock set to each event's time. Forwarded: the same events through the gateway model into a
spool, then through the forwarder in 6 flushes, with a restart of the forwarder after 8
records. The scenario has a multi-page visitor across
the hour, a single-page app across the hour with a view 35 minutes after the visit began, an
app open for 90 minutes over two hour boundaries, and two tabs of one visitor either side of
the hour.

| Metric | Direct | Forwarded, token carried | Forwarded, no token (round one) |
|---|---|---|---|
| Page views | 23 | 23 | 23 |
| Unique visitors | 8 | 8 | 8 |
| Visits | 12 | 12 | 13 |
| Session duration | 8160 s | 8160 s | 5880 s |
| Bounces | 5 of 12 | 5 of 12 | 7 of 13 |
| Referrer, country, device, browser, OS, pages | | equal | equal |

The script also compares which page views share a visit, not only the totals. Direct and
forwarded with the token give the same 12 groups. Without the token 6 of the 12 are not
reproduced.

**How the forwarder does it.** It does not store tokens. For each page load it remembers when
the current visit began, and starts a new visit when an event is more than 30 minutes after
that. An event in the same clock hour as the start of its visit is sent as before: Umami
derives the same visit id. An event in a later hour needs the token. The forwarder asks Umami
for it with an `identify` item that has no data and the timestamp of the visit's start. That
request stores no event and no session data; it stores the `session` row if that does not
exist yet (measured: events 0, session data 0, sessions 1). A session without events is not
counted in the statistics. It then sends the event in a batch with `x-umami-cache`.

**Cost.**

- Record: one new field, the same for all events of a page load. The experiment uses the time
  of the page load's first event, computed by the gateway from "seconds since the first event
  of this page load", which the tracker would keep in a variable. No cookie, no storage.
- State: one timestamp per page load with a running visit, for 30 minutes after that visit
  began. At most 4 entries here. It must survive a restart. The forwarder writes it to a
  file after every flush and reads it at start; the run restarts the forwarder once. Without
  the file the visit groups change (negative control).
- Batch shape: the batch route copies the request headers onto every item, so a token applies
  to the whole batch. Each page load that crosses the hour gets its own batch, plus one token
  request. Here: 18 requests for 23 page views, of which 4 token requests and 4 token batches.
  Another visitor's item in a token batch is left alone (measured); another page load of the
  same visitor would be pulled into the visit, so the forwarder keeps them apart.
- The batch answer returns one token, that of its first accepted item (measured). Taking tokens from
  ordinary answers would need one batch per visit, so the forwarder asks instead.
- Umami never ends a visit for timestamped events: a token used five hours later still joined
  the old visit (measured). The 30-minute rule has to be the forwarder's.

**The token.** A JWT signed with a key derived from `APP_SECRET`. Decoded: `websiteId`,
`sessionId`, `visitId`, `iat` (Umami's clock when it answered) and `type`. No address, no
User-Agent, no expiry field. It is not encrypted. It never expires by itself, but Umami uses
it only when its session id equals the one it computes for the event. With the next day's
per-visitor value the session differs and the token linked nothing (measured). It names
nothing that is not already in Umami's `session` and `website_event` tables, and it does not
identify a visitor beyond the day. The forwarder holds it in memory for one request.

**Across 00:00 UTC.** The gateway model now derives the per-visitor value from a salt per UTC
day, as the design does. The 23 page views are kept inside one UTC day. A separate case puts a
multi-page visitor and a single-page app either side of midnight, 4 page views:

| | Unique visitors | Visits |
|---|---|---|
| Direct | 2 | 3 |
| Forwarded | 4 | 4 |

This is the design's "counted once per day and never linked across days", and it cannot be
made equal without linking the two days. Each visitor active across midnight adds one visitor
and, if a visit was running, one visit.

**Now enforced by a test:** equality of the seven metrics and of the visit groups on this
scenario, restart included; the midnight difference; the token facts above.

**Not tested:** a crash in the middle of a flush (the state is written after it); a real
browser and the real tracker; the new field under network jitter (a
random per-page-load value would avoid depending on timing); two tabs opened in the same
second; one page load whose events reach two ingest locations, each with its own forwarder
state; custom events; a caller that lies about the field (it can only regroup its own views).

### B. The conditions as a probe

`probe.mjs` sends 9 canary events through the deployment's forwarder and 4 direct events with
browser User-Agents, reads both back through Umami's API, and deletes its two websites. It
trusts no response: Umami answers 200 and "processed" to events it drops.

| Deployment | Reported |
|---|---|
| As designed | nothing |
| Umami without `ENABLE_CLIENT_SALT` | `ENABLE_CLIENT_SALT`: 9 visitors sent, Umami counts 1 |
| Forwarder User-Agent `node` | forwarder User-Agent: acknowledged 9 of 9, holds 0 |
| Forwarder User-Agent `Mozilla/5.0 (compatible; UsageSignalsForwarder/1.0)` | the same |
| Gateway labels in another spelling (`Chrome`, `IOS`, `Desktop`) | browser, OS and device labels, each against Umami's own detection |
| Placeholder `10.0.0.1` | placeholder address: sent NZ=4, UY=5, stored none |
| Placeholder `not-an-address` | the same |
| All countries in one batch | one batch per country: sent NZ=4, UY=5, stored UY=9 |

Run on its own it exits 0 on the stack as designed and 1 with `FORWARDER_USER_AGENT=curl/8.7.1`
or `PLACEHOLDER_ADDRESS=10.0.0.1`. After a run no probe row is left in `website_event`.

**Now enforced by a test:** all five round-one conditions.

The probe stops at the first of two violations that hide the others: when Umami drops the
User-Agent nothing is stored, and when it ignores the salt all canaries are one visitor, so
labels and countries cannot be read. Fix and run again.

**Not tested:** the probe against the hosted deployment. It needs an Umami admin login. The
label check covers four User-Agents; the product gateway's reducer needs a larger set.
`DISABLE_BOT_CHECK=1` was again not run.

### C. Duplicates

| Case | Result |
|---|---|
| A batch of 6 in which 3 items fail (their website does not exist yet) | The answer lists the failed indexes. The forwarder resends those 3: 2 requests, 9 items sent, 3 and 3 page views held for 3 and 3 spooled. |
| Two answers lost after Umami stored the batches (4 page views), both batches resent | Page views 27 instead of 23. Bounces 4 of 12 instead of 5 of 12. Visitors, visits, duration and every breakdown unchanged. |
| Reconciliation after that | Spooled 23, acknowledged 23, Umami holds 27: difference 4. The run without a loss: 23, 23, 23. |
| Repair after that: the 2 sessions of the resent batches deleted through the API, their 4 page views replayed from the spool | Page views 23. All metrics and the visit groups equal the run without a loss. Difference 0. |
| The same loss, the forwarder reads Umami's count before resending | Page views 23, all metrics equal, difference 0. |

The reconciliation compares, per site and UTC day, records in the spool, items Umami
acknowledged, and page views Umami holds, read through its API.

**The repair.** Umami cannot delete one event, but it can delete a session:
`DELETE /api/websites/:id/sessions/:sessionId`
(`src/app/api/websites/[websiteId]/sessions/[sessionId]/route.ts:60-87`). The forwarder
remembers the records of every batch it resent without an answer. For each visitor in them it
asks Umami for the session id (the token request of A), deletes that session, and sends all
records of that visitor and site again from the spool.

What it needs:

- Umami on PostgreSQL without ClickHouse. The route refuses otherwise (`isRelationalOnly`,
  `src/lib/db.ts:22-24`).
- A user allowed to delete the website, such as the admin session.
- The spool or its archive still holding every record of those visitors for that site and
  day. The design keeps segments 14 days.
- The list of resent batches. In the experiment it is in memory and is lost with the process.

What it costs: one token request and one delete per affected visitor, and a replay of that
visitor's whole day on that site, not only the duplicated events. Between the delete and the
replay those visitors are missing from the statistics. Here: 2 sessions, 4 page views.

**What remains.**

- Umami has no idempotency key. It creates the event id itself
  (`src/queries/sql/events/saveEvent.ts:106`). Prevention is not possible; only repair.
- The count shows how many events are surplus, not which. Without the list of resent
  batches the repair has to replay every session of that site and day.
- Reading back before resending is safe only while one forwarder writes that site and day
  into that Umami, and only once Umami has finished the lost batch. With two forwarders on one
  database, as in check 3, the count mixes both and the forwarder could skip events it should
  send. This follows from the logic and was not run.
- A loss and a duplicate of the same size on the same site and day cancel out in the count.

**Not tested:** the repair with two forwarders on one database, on a site with custom events
or session data, or after the forwarder lost its list of resent batches;
counts of custom events (the count reads page views only); a timeout while
Umami is still working through the batch; batches near the 500-item cap; concurrent batches.

### D. No part of the IP on disk

The gateway model (`gateway.mjs`) receives the address and User-Agent, computes the
per-visitor value, the labels, the quality class and the country from the truncated address
in memory, appends one JSON line to a spool file and syncs it. A record:

```json
{"site":"...","timestamp":1795532700,"url":"/","referrer":"https://stellar.org/learn","country":"US","browser":"chrome","os":"Windows 10","device":"desktop","quality":"hosting","visitor":"b78abdf515817c65051759722f88e4eb","pageStart":1795532700}
```

8 visitor addresses (7 IPv4, 1 IPv6) in 47 written forms: full, truncated (/24 or /48), dotted
prefix, dashed, decimal and hexadecimal.

| Place searched | Forms found |
|---|---|
| Spool files (5 spools) | none |
| Gateway log | none |
| Every request the forwarder sent | none; the proxy header is always `192.0.2.1`, no item has `ip` or `userAgent` |
| `pg_dump` of Umami's database | none |
| Raw database files, write-ahead log included | none |
| Logs of all containers, PostgreSQL logging every statement and its parameters | none |
| Files the three Umami containers wrote since they started (4 each) | none |

Corrected after review: the first version reported that the Umami containers wrote no file.
That check was blind. Each container writes four files after start: two Prisma checkpoint
files, Prisma's `commands.json` and a jiti cache of the Prisma config. The search now starts
from the container's start time and reads those files; none holds an address. A string known
to be in each place was found there, and a file planted in each container was found, so each
search works. The direct side sends the real addresses to Umami in
the proxy header, and the same scans cover it: Umami stores none on that path either.

**Now enforced by a test:** all rows above.

**Not tested:** the product gateway (`console/lib/gateway.js` has no spool); anything in front
of the gateway that logs addresses, such as a load balancer; swap and core dumps; the fallback
path, which stores the truncated prefix by design. The per-visitor value in the spool is a
keyed digest of address, User-Agent and site. It is not a part of the address, but whoever
holds the daily salt can test candidate addresses against it until the salt is deleted.

### Negative controls

`node controls.mjs`: the unchanged run passed, then each mutation ran once. A mutation is
caught when the run exits 1 and reports the fact it is aimed at as broken. 14 of 14 caught.

| Mutation | Aimed at | Caught |
|---|---|---|
| Forwarder never carries the token | A, same visits | yes |
| Forwarder never ends a visit after 30 minutes | A, same visits | yes |
| Forwarder starts without its saved state after the restart | A, same visits | yes |
| Probe trusts the batch answer instead of reading back | B, silent drop | yes |
| Probe does not compare countries | B, placeholder and batching | yes |
| Forwarder resends the whole batch after a partial failure | C, every event once | yes |
| Reconciliation reads its own ledger instead of Umami | C, duplicate found | yes |
| Read-back skipped before a resend | C, duplicate avoided | yes |
| Repair replays without deleting the sessions | C, duplicate removed | yes |
| Gateway writes the truncated prefix to the spool | D, spool | yes |
| Gateway logs the address | D, gateway log | yes |
| Forwarder puts an address in the payload `ip` | D, forwarder requests | yes |
| File search starts from the wrong time and sees no new file | D, planted file | yes |
| Scanner searches nothing | D, planted string | yes |

