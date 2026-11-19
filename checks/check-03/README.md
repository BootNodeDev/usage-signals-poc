# Check 03: one visitor through two gateways

> "One visitor sent through two gateways on one day is counted once."

**Verdict: passes with a stated correction.** One visitor whose page views alternate between
two gateways, each forwarding to its own Umami 3.5.0 instance on one database, is one visitor
and one visit. That holds for the gateway as it is today and for the document's design, where
the per-visitor value travels as `salt`. The design works only when Umami runs with
`ENABLE_CLIENT_SALT` set, which the document does not say. Umami's source is not changed.

Run on 2026-11-19 against the images pinned in `compose.yml` (the same as
`console/docker-compose.yml`).

## Reproduce

```sh
node run.mjs
```

About 50 seconds with the images already pulled. It starts compose project `us-check-03`
(PostgreSQL on 55103; Umami on 33103, 33203 and 33303), runs two gateway processes on 43103
and 43203, prints the table and the verdict, removes the stack and exits non-zero if any
figure differs from the ones below. `CHECK_KEEP_STACK=1` leaves the containers up. Gateway
logs go to a `mktemp` directory whose path is the first line printed.

## Corrections for the document

Forwarder paragraph, replacing "and the per-visitor value as salt":

> ... and the per-visitor value in the payload field `salt`. Both Umami instances run with
> `ENABLE_CLIENT_SALT` set; without it Umami ignores the field and every visitor behind the
> placeholder address is counted as one. Umami mixes the value into its own session salt and
> still hashes the address and the User-Agent of the request, so the forwarder sends the same
> placeholder address and the same fixed User-Agent at both locations, and that User-Agent is
> one Umami's bot check does not match.

Topology paragraph, replacing the last sentence:

> The two Umami instances use the same `APP_SECRET`, the same `ENABLE_CLIENT_SALT` and
> `SALT_ROTATION` settings and the same time zone, and the two gateways the same daily salt.

## Cases

Location A is gateway 43103 forwarding to Umami 33103; location B is gateway 43203 forwarding
to Umami 33203. Both Umami instances share the database and `APP_SECRET` and have
`ENABLE_CLIENT_SALT=1`. Every case has its own website. Figures are read from
`GET /api/websites/<id>/stats?startAt=&endAt=` (`pageviews`, `visitors`, `visits`).

"Today" is `console/lib/gateway.js`, imported unmodified by `gateway-today.mjs`. "Design" is
`gateway-design.mjs`: value = HMAC-SHA-256(daily salt; site id, full IP, raw User-Agent), sent
as `payload.salt` with the placeholder address `192.0.2.1` in `cf-connecting-ip`, the country
in `cf-ipcountry`, a fixed forwarder User-Agent, `browser`, `os`, `device` and `timestamp`.

| Case | Gateway | Sent | Umami reported | Expected | Pass |
|---|---|---|---|---|---|
| 1 | today | one visitor, 4 page views alternating A, B, A, B | 4 page views, 1 visitor, 1 visit | counted once | yes |
| 2a | design | the same; both gateways hold the same daily salt | 4 page views, 1 visitor, 1 visit | counted once | yes |
| 2b | design | the same, on a day when each gateway holds its own salt | 4 page views, 2 visitors, 2 visits | degraded: once per location | yes |
| 2c | design | one visitor on two consecutive UTC days, through A and B on each | 1 visitor on day 1, 1 on day 2, 2 over both days | a new visitor each day, not linked | yes |
| 3 | today | two visitors, same address, Chrome and Firefox, each through A and B | 4 page views, 2 visitors, 2 visits | two visitors | yes |
| 3 | design | the same | 4 page views, 2 visitors, 2 visits | two visitors | yes |
| c1 | design, Umami without `ENABLE_CLIENT_SALT` (33303) | as case 3 | 4 page views, **1 visitor**, 1 visit | shows the setting is required | yes |
| i1 | today | two visitors, same /24, different addresses, same browser | 2 page views, 1 visitor, 1 visit | informative | - |
| i1 | design | the same | 2 page views, 2 visitors, 2 visits | informative | - |
| i2 | today | one visitor on two UTC days | 1 visitor over both days | informative | - |
| i3 | design | a page view whose body carries its own `salt` | HTTP 400, nothing stored | refused | yes |

How events were placed on other days: Umami's route accepts `payload.timestamp` in Unix
seconds (`umami/src/app/api/send/request-schema.ts:99`, `route.ts:106`). The design gateway
always sends it, as the document's forwarder does. For the check it takes the instant from an
`x-check-clock` request header, honoured only when the process is started with
`CHECK_TEST_CLOCK=1`; the days are the three UTC days before the run, at 12:00. Case i2 is
written straight to Umami in the shape `console/lib/umami.js` sends plus `timestamp`, because
today's gateway refuses that field.

What the informative rows say about today's code: it identifies a visitor by truncated
address and User-Agent, so two people in one /24 with the same browser are one visitor (i1),
and one person on two days of a month is one Umami session (i2; `DECISIONS.md` entry 34
already sums daily figures for that reason). The design removes both.

## Why it works

Paths are relative to `umami/` at tag v3.5.0.

- Session id: `uuid(sourceId, ip, userAgent, sessionSalt, distinctId)`
  (`src/lib/collection-session.ts:111`), and `uuid` appends the hash of `APP_SECRET`
  (`src/lib/crypto.ts:57-63`). No gateway or instance identity enters it, so two instances
  with one `APP_SECRET` derive the same id from the same request. This is case 1.
- The caller's value: `payload.salt`, a string of at most 100 characters
  (`src/app/api/send/request-schema.ts:101`), read at `src/app/api/send/route.ts:53` and
  passed on at `route.ts:115`. It is used only when `ENABLE_CLIENT_SALT` is set:
  `sessionSalt = ENABLE_CLIENT_SALT && salt ? hash(baseSalt, salt) : baseSalt`
  (`src/lib/collection-session.ts:107-109`). Documentation:
  https://docs.umami.is/docs/environment-variables ("Without this variable, client salts are
  ignored"). https://docs.umami.is/docs/api/sending-stats does not list `salt`, `timestamp`,
  `ip`, `userAgent`, `browser`, `os` or `device`; they are known from the source only.
- Umami's own rotation is not replaced. `baseSalt` is `getSalt(SALT_ROTATION, createdAt)`:
  monthly when unset, or daily, weekly, monthly, or a fixed string
  (`src/lib/crypto.ts:88-102`), computed from the event's timestamp. The caller's value is
  hashed together with it. The daily rotation in case 2c comes from the gateway's salt alone.
- Visit id: `uuid(sessionId, hash(start of the event's hour))`
  (`src/lib/collection-session.ts:110-113`), so alternating gateways within one clock hour
  give one visit.
- Statistics: `count(distinct session_id)` and `count(distinct visit_id)` over the range
  (`src/queries/sql/getWebsiteStats.ts:47-48`).

## What did not work

- **The value as `salt` against Umami as it ships.** Without `ENABLE_CLIENT_SALT` the field is
  ignored (`collection-session.ts:109`); with the placeholder address and a fixed User-Agent
  every visitor of a site becomes one session. Case c1: two visitors reported as 1.
- **A forwarder with an ordinary client User-Agent.** Umami runs `isbot` on the User-Agent of
  the request (`src/lib/detect.ts:137`, `src/app/api/send/route.ts:97`) and answers 200
  `{"beep":"boop"}` without storing anything. Probed by hand on 33103, not part of `run.mjs`:
  `node` (the default of Node's `fetch`), `usage-signals-forwarder`,
  `usage-signals-forwarder/1` and `Mozilla/5.0` were all discarded;
  `Mozilla/5.0 (usage-signals forwarder)` was stored. The design gateway treats an answer
  without `sessionId` as a failure for that reason. `DISABLE_BOT_CHECK` would switch the
  check off (`route.ts:97`); not tested here.
- **Replacing Umami's identity inputs with the value.** Not possible without a patch: the
  address and User-Agent stay in the hash (`collection-session.ts:111`). It is not needed,
  as long as both are constant and equal at both locations.
- **A local placeholder address.** Not tested here; `src/lib/detect.ts:91` returns no
  location for a local or invalid address before it reads the country header. `192.0.2.1`
  (RFC 5737) with `cf-ipcountry: AR` stored country AR.

## Not covered

- Two Umami instances with different `APP_SECRET`, `SALT_ROTATION` or time zone. From the
  source each one changes the session id (`crypto.ts:63`, `crypto.ts:88-102`; `startOfMonth`
  uses the process time zone), which would count every visitor once per location. Both
  containers here ran with identical settings in UTC.
- How the two locations agree on the salt, its storage and deletion, and how a degraded day
  is detected and flagged. The check supplies the salts through an environment variable.
- A visitor whose page views fall in two clock hours (two visits by Umami's rule) and a day
  that spans Umami's monthly salt boundary in a non-UTC time zone.
- The spool, batch forwarding (`/api/batch`), replay hours later, and one batch per country.
- A visitor whose address or User-Agent changes between requests, and IPv6.
- The hash used for the per-visitor value is this check's choice; the document names its
  inputs, not the function.
- ClickHouse. The stack is PostgreSQL only.
- Deviation from the brief: two extra Umami ports, 33203 (location B) and 33303 (control).
