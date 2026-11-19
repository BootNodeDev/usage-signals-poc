# Checks 1 and 2: forwarding through Umami's batch route

Run on 2026-11-19 against Umami 3.5.0 and PostgreSQL 18, the images pinned in `compose.yml`.

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
| Visits | 6 | 6 | yes | One visitor crosses a clock hour and counts as two visits on both sides: Umami cuts visits at the hour. |
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
