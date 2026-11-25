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

Round two (below) now covers the first item, the detection half of the second, and the
notation of IPv6 addresses in the fifth.

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

## Round two (2026-11-24)

Round one named the conditions under which the visitor is counted once. Round two asks
whether a broken condition is detected, and removes one condition (the notation of an
address). Everything ran on one machine. Nothing here was run across two locations.

### Reproduce

```sh
node round-two.mjs              # about 3 minutes with the images pulled
node round-two.mjs --controls   # every negative control in turn, about 25 minutes
```

`round-two.mjs` starts compose project `us-check-03-r2` from `compose.round-two.yml` (same
pinned images, no fixed host ports), starts gateway processes on free loopback ports, prints
the table, the probe findings and the verdicts, and removes the stack. Exit code 0 when every
figure matches, 1 when one differs, 2 when the run broke. `run.mjs` (round one) is unchanged.

`gateway-design.mjs` is shared with round one and changed in round two. `run.mjs` itself was
not run in round two, because it publishes fixed ports under project `us-check-03`. Round
one was run again from a copy after the last change to the gateway: exit code 0, 11 of 11
cases matched. The copy is made like this, from this folder,
with six free ports in `$1` to `$6` and a scratch directory in `$S`:

```sh
sed -e "s/55103/$1/; s/33103/$2/; s/33203/$3/; s/33303/$4/" \
    -e "s/^name: us-check-03$/name: us-check-03-r2/" compose.yml > $S/compose.yml
sed -e "s|const HERE = import.meta.dirname;|const HERE = '$PWD';|" \
    -e "s|path.join(HERE, 'compose.yml')|'$S/compose.yml'|" \
    -e "s/'us-check-03'/'us-check-03-r2'/" \
    -e "s/55103/$1/g; s/33103/$2/g; s/33203/$3/g; s/33303/$4/g; s/43103/$5/g; s/43203/$6/g" \
    run.mjs > $S/run.mjs
node $S/run.mjs
```

### What changed in the code

- `address.mjs`: one text form per IP address. `gateway-design.mjs` applies it before it
  computes the per-visitor value, and refuses a page view whose address is not an IP address.
- `gateway-design.mjs`: a route `POST /api/probe`. The caller is the synthetic visitor. The
  route reads the caller's address and User-Agent from the request with the function a page
  view uses, computes the per-visitor value and forwards to Umami with the functions a page
  view uses, and answers with the session and visit Umami derived. It differs from a page
  view in three ways: the UTC day and the website come from the body, the check for refused
  fields is skipped, and no `Origin` header is read. Those three are not covered by the probe.
  The placeholder address, the forwarder User-Agent and the name of the address header can
  be set from the environment, so that the check can make one location differ.
- `probe.mjs`: the probe, as a module and as a command with exit code 0 or 1.
  `node probe.mjs umami <probe-website-id> <umami-a> <umami-b>` and
  `node probe.mjs gateways <probe-website-id> <gateway-a> <gateway-b> [day ...]`.
  It prints no setting and no secret. It compares the identities Umami returns.

### A. Configuration drift between the two Umami instances

**Verdict: Yes, with one stated condition.** The probe passes when the instances match and
reports a difference in each of the four settings. The condition: it must run at every
deploy and at least once a day, because a time-zone difference that begins later in the
year is visible only one period ahead (case A6).

The probe posts the same four synthetic events to `/api/send` of each instance, on a website
kept for the probe: now, one day ahead, seven days ahead, and the 15th of next month. In
cases A1 to A5 the probe's clock is fixed at 2026-11-24 12:00 UTC, so the figures do not
depend on the day of the run; `probe.mjs` from the command line uses the real clock. It
compares the `sessionId` and `visitId` in the answers. It then posts one more event with a
second `salt` to each instance and requires a different session, which shows that
`ENABLE_CLIENT_SALT` is in effect and not merely equal.

| Case | Location B differs in | Probe | One visitor through A and B |
|---|---|---|---|
| A1 | nothing | pass; command line: exit code 0 | 1 visitor |
| A2 | `APP_SECRET` | drift at 4 of 4 instants; command line: exit code 1 | 2 visitors |
| A3 | `ENABLE_CLIENT_SALT` unset | drift at 4 of 4, and "location B ignores the per-visitor value" | 2 visitors |
| A4 | `SALT_ROTATION=daily` (A: monthly) | drift at 3 of 4 | 2 visitors |
| A5 | `TZ=Asia/Tokyo` (A: UTC) | drift at 4 of 4 | 2 visitors |
| A6 | `TZ=Europe/London` (A: UTC) | pass with the clock at 2027-01-10; drift at 1 of 4 with the clock at 2027-03-10 | not sent |

Two things the numbers show:

- A4 agrees at one instant, 1 December (seven days after the fixed clock), where the start
  of the day is the start of the month. With the real clock the figure is 3 of 4 only when
  one of the four instants falls on the first of a month, and 4 of 4 otherwise. A probe with
  a single instant can miss a rotation difference. The negative control
  `umami-probe-first-of-month-only` confirms it.
- The time zone matters through its UTC offset at the start of the month (or day, or week),
  not through its name. Umami hashes `startOfMonth(event).toUTCString()`
  (`src/lib/crypto.ts:88-102`), so Tokyo differs at every instant (A5), and London differs
  from UTC only for months that start in summer time (A6). In A6 the probe run on 10 March
  finds the difference that starts on 1 April.

Correction to round one: its "Not covered" list speaks of "a day that spans Umami's monthly
salt boundary in a non-UTC time zone" as the open case. Round two shows the effect is not
limited to the boundary: with different offsets every visitor is split on every day (A5,
mid-month).

### B. Drift between the two gateways

**Verdict: Yes, with one stated condition.** The gateway probe agrees when both gateways
match, and does not agree when the daily salt, the placeholder address, the forwarder
User-Agent or the header the client address is read from differs. The condition: the probe
reaches each gateway through the same front (proxy or platform) as visitors do. Here that
front is `serve.mjs` on loopback for both.

The probe calls `POST /api/probe` on each gateway as one synthetic visitor: it states its
address (`2001:DB8:0:0:0:0:0:1%probe`, not in canonical form on purpose) the way the check's
visitors do, and sends a fixed User-Agent.

| Case | Gateway B differs in | Probe for that day | Visitors |
|---|---|---|---|
| B1 | nothing (two days) | agree, agree; command line: exit code 0 | - |
| B2 | daily salt | disagree | one visitor through A and B: 2 |
| B3 | placeholder address (`198.51.100.1`) | disagree | one visitor through A and B: 2 |
| B4 | forwarder User-Agent | disagree | one visitor through A and B: 2 |
| B5 | forwarder User-Agent `usage-signals-forwarder/1`, which Umami treats as a bot | no answer from B: `{"beep":"boop"}` | gateway B answers 503; 1 visitor |
| B6 | reads the client address from `x-real-ip`, which holds a proxy's address | no answer from B: "the client address is not an IP address" | one visitor through A and B: 2. Two visitors through B: 1 |

Correction to the first version of this section: the probe then used a visitor fixed inside
the gateway and did not read the request, so it agreed in the situation of B6. The negative
control `probe-skips-address-reading` restores that behaviour and is caught.

In B6 the probe gets no answer, because it sends no `x-real-ip`. A probe request that
carried that header with another value would get "disagree"; not run.

The probe does not say which setting differs. A difference between the Umami instances
also shows as "disagree", so the Umami probe (A) runs first.

### C. IPv6 notation

**Verdict: Yes.** One address is one visitor in every notation tested. Two addresses are two
visitors. Page views alternated between gateway A and gateway B.

| Case | Addresses sent | Umami reported |
|---|---|---|
| C1 | `2001:db8::1`, `2001:0db8:0000:0000:0000:0000:0000:0001`, `2001:DB8::1`, `2001:db8:0:0:0:0:0:1`, `2001:db8::1%eth0`, `2001:0DB8:0:0::1` | 6 page views, 1 visitor, 1 visit |
| C2 | `203.0.113.7`, `::ffff:203.0.113.7`, `::FFFF:CB00:7107`, `0:0:0:0:0:ffff:cb00:7107` | 4 page views, 1 visitor, 1 visit |
| C3 | `2001:db8::1` and `2001:db8::2`, each in two notations | 4 page views, 2 visitors, 2 visits |
| C4 | `2001:db8::1`, `[2001:db8::1]`, `[2001:DB8::1]:443`, `[2001:db8:0:0:0:0:0:1%eth0]:8080` | 4 page views, 1 visitor, 1 visit |
| C5 | `203.0.113.7`, `203.0.113.7:54321`, `[::ffff:203.0.113.7]:80` | 3 page views, 1 visitor, 1 visit |
| C6 | `not-an-address` | HTTP 503, nothing stored |
| C7 | `203.000.113.007` | HTTP 503, nothing stored |

Accepted and normalised: IPv4 in dotted decimal; IPv6 in any RFC 4291 text form, upper or
lower case; either one in brackets; a port after brackets or after an IPv4 address; a zone;
IPv4-mapped IPv6, which becomes the IPv4 address.

Refused, and the page view is not recorded (HTTP 503, logged without the address): text
that is not an IP address, and IPv4 with a leading zero in a part. `010` is 8 to some
parsers and 10 to others, and either reading could merge two visitors.

Not told apart: an IPv6 address followed by a port without brackets (`2001:db8::1:443`) is a
valid IPv6 address and is taken as one. IPv4 embedded in other IPv6 ranges (NAT64, 6to4) is
left as IPv6.

This corrects the round-one result quoted in `checks/README.md` ("one IPv6 address written
two ways counts twice"): with the normalisation it counts once. The zone is dropped, so one
link-local address on two interfaces is one visitor; such addresses do not reach a public
gateway.

What normalisation cannot fix: a dual-stack visitor who reaches one location over IPv6 and
the other over IPv4 has two different addresses and is two visitors. Not tested; it follows
from the inputs of the per-visitor value.

### D. Salt disagreement

**Verdict: Yes for detection. The flag itself is not built.**

The gateway probe was run for three days: one with a shared salt, one where each gateway
holds its own, one for which gateway B has no salt.

| Case | What | Result |
|---|---|---|
| D1 | probe per day | shared salt: agree. Own salts: disagree. Salt missing at B: no answer from B ("no daily salt for UTC day ...") |
| D2 | ten visitors on the day with a shared salt: four only at A (two page views each), three only at B, three at both | 17 page views, 10 visitors, 10 visits |
| D3 | the same ten visitors on the day with own salts | 17 page views, 13 visitors, 13 visits |

On a degraded day Umami reports the visitors seen at A plus the visitors seen at B (7 + 6).
Each visitor who used both locations is counted twice; page views are not affected. The true
figure lies between half the reported one and the reported one, and cannot be recovered from
Umami. Where the "degraded" flag is stored and how the dashboard shows it is not part of this
check.

### Negative controls

Each is a mutation that must make `round-two.mjs` exit 1. Run with `--controls`.

| Control | Claim | Cases that changed | Caught |
|---|---|---|---|
| `umami-b-secret-differs`: the "matching" location B starts with another `APP_SECRET` | A | A1 | yes |
| `umami-drift-not-applied`: the drifted settings are not applied | A | A2 to A6 | yes |
| `umami-probe-without-salt`: the probe sends no `salt` | A | A3 (probe passes) | yes |
| `umami-probe-first-of-month-only`: the probe uses one instant, the first of a month | A | A2 to A6; A4 passes the probe | yes |
| `umami-probe-without-lookahead`: the probe uses only the current instant | A | A2 to A6; A6 passes the probe on 2027-03-10 | yes |
| `gateway-b-salt-differs`: gateway B holds another salt on a "shared" day | B | B1 | yes |
| `gateway-drift-not-applied`: the drifted gateway settings are not applied | B | B2 to B6 | yes |
| `probe-skips-address-reading`: the probe route uses a fixed visitor and ignores the request | B | B6 (probe agrees) | yes |
| `no-address-normalisation`: the gateway hashes the address as written | C | C1 to C7 | yes |
| `address-truncated-to-prefix`: the gateway keeps only the first two groups | C | C3 | yes |
| `salts-agree-on-split-day`: both gateways hold the same salt on the split day | D | D1, D3 | yes |

11 of 11 caught, each run with exit code 1. With a one-instant probe (fourth and fifth rows)
the other A cases also change, because their rows expect a difference at 4 instants; the
table of such a run prints "1 of 4" where one instant was compared.

### Conditions now covered by a test

- Umami: equal `APP_SECRET`, `ENABLE_CLIENT_SALT` in effect at both, equal `SALT_ROTATION`,
  equal UTC offset at the start of the rotation period. Detected by `probe.mjs umami`.
- Gateways: equal daily salt for a given day, a salt present for that day, equal placeholder
  address, equal forwarder User-Agent, a User-Agent Umami's bot check accepts, the same
  header for the client address, the same normalisation. Detected by `probe.mjs gateways`.
- Address notation: no longer a condition. The gateway normalises.

"Covered" means the probe exists and the check shows it detects each difference. Nothing in
the prototype runs the probe at deploy or at start; that wiring is not built.

### E. What this experiment cannot establish

It ran on one machine, one clock, one Docker network and one local PostgreSQL.

- **Clock skew.** Each gateway picks the salt by its own UTC day. Near midnight, two
  locations whose clocks differ use different salts for the same moment. Here both gateways
  share one clock and the event time is injected by the test.
- **Network partition.** The salts reach the gateways through an environment variable. How
  a location decides that it "cannot agree", and whether both reach the same decision, is not
  tested. The probe must reach both locations; "no answer" does not tell a partition from a
  fault.
- **The front of each gateway.** Both gateways sit behind the same stand-in (`serve.mjs`).
  Two real locations with different proxies can deliver the client address differently; the
  probe detects that only if it enters through those proxies.
- **DNS and routing.** The test alternates one visitor between the gateways on purpose. How
  often a real visitor changes location within a day, and so how large the over-count on a
  degraded day is, is unknown. The same holds for a visitor who reaches the locations over
  different address families.
- **The shared database over a real link.** Events were sent one after another. Two
  locations inserting the same session at the same moment over a WAN was not tested; the
  source uses `on conflict (session_id) do nothing` (`src/queries/sql/sessions/createSession.ts`).
- **The probe in production.** Its route is open on loopback here. Authentication, the
  schedule, the alert and the storage of the degraded flag are not built. Probe events are
  written to the probe website on every run.
- **Other differences between two real hosts**, such as Node or time-zone data versions. The
  probe compares outcomes, so it would report them if they change an identity, but none was
  produced here.
- Still open from round one: the spool, `/api/batch`, replay, a visit across two clock hours,
  ClickHouse.
