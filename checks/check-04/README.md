# Check 04: provisioning Umami tenants through its API

Round one (2026-11-19) is below. Round two (2026-11-24) is the last section: it rewords the claim,
tests re-runs, interrupted runs and removal, and closes or states the two limits.

**Verdict: passes with a stated correction to the design.** Teams, service users, memberships and
team websites are provisioned with an admin session and no database access. An API key is not: in
Umami 3.5.0 a user can create and delete only its own keys, from its own login.

The check, verbatim: "Umami teams, service users and keys can be provisioned through an admin
session, without touching its database."

Reproduce: `node run.mjs` from this folder (about 35 seconds with the images already pulled; needs
Docker and Node 22 or later). It starts its own stack (compose project `us-check-04`, PostgreSQL on
55104, Umami on 33104, the images pinned in `console/docker-compose.yml`), runs 373 rows, prints
the table and the verdict, removes the stack, and exits non-zero if any row differs. The full
table of the last run is in `results.md`.

Umami source references are to the submodule `umami/` at tag v3.5.0 (commit `d3c62a8`).

## Summary of both rounds

No as worded. In Umami 3.5.0 only a key's own user can create it. `createApiKey` has one caller,
which takes the owner from the caller's session.

Yes as reworded. A worker can provision a tenant's team, service user, membership, website and
read key through Umami's HTTP API alone, without touching its database. It can later remove all
of them the same way. All 653 rows are as expected, and the experiment catches 10 of 10 negative
controls.

- The worker signs in once as the new service user with a random password and creates the key. It
  then replaces the password with a random value it does not keep. The key survives.
- A second run creates no duplicate, and the next run completes a run stopped after any of the 11
  steps.
- Removal deletes the user first and then the team. It reads back before it reports success: no
  user, no other team member, and the key answers 401.
- The reviewer found that names with upper-case letters broke both. Umami lower-cases usernames
  and the worker compared names as written, so a removal reported "completed" and left a working key. The
  worker now normalises the name before any call. The tests cover mixed case, padding, accents
  and a Turkish dotted I.
- Umami offers no way to turn off the team join code. The worker rotates it to 50 random
  characters and discards it.
- A view-only key could publish its own tenant's totals through a share link. Binding the service
  user to a team board closes it. This relies on `POST /api/users` accepting an `id`, which Umami
  does not document.
- The isolation test ran 185 cross-tenant rows on 106 of 119 read routes and found no leak.

Not tested: two workers at once. Umami does not require unique team names.

## Corrected sentence for the document (line 429)

> Umami teams, service users, team memberships and websites can be provisioned through an admin
> session, without touching its database. API keys cannot: Umami lets a user create and revoke
> only its own keys. The provisioning worker therefore signs in once as the service user it has
> just created, creates the key, and discards that password and session.

Three other lines need a matching edit:

| Line | Now | Should say | Why |
|---|---|---|---|
| 145 | "a service user that holds the team's view-only role" | "a service user whose global role is `view-only` and whose team role is `team-view-only`" | Both roles are needed. With global role `user` the same key creates its own websites and teams (rows 343-344 of `results.md`). |
| 153 | "Removal revokes ingest tokens and keys" | add: "by deleting the service user, which deletes its keys; deleting the team alone leaves the user and a working key" | Rows in group 4. |
| 156 | "It alone holds the Umami admin credential, which Umami requires to create users." | add: "and to reset a service user's password, the only way to rotate or revoke a key without storing that password" | Group 3. |

Line 34 says keys exist "since v3.4.0". Not established here: the submodule is a shallow clone at
v3.5.0, so the version that introduced them cannot be read from it. They exist at v3.5.0.

## 1. Provisioning steps

All calls are HTTP against Umami. `Bearer` is the admin login token unless stated.

| Step | Route and body | Response | Implemented at |
|---|---|---|---|
| Admin session | `POST /api/auth/login` `{username, password}` | 200 `{token, user}` | `src/app/api/auth/login/route.ts:16-84` |
| Create team | `POST /api/teams` `{name}` | 200 `[team, teamUser]`; the caller becomes `team-owner`; the team gets a join code `accessCode` | `src/app/api/teams/route.ts:32-95`, `src/queries/prisma/team.ts:144-164` |
| Create service user | `POST /api/users` `{username, password, role: "view-only"}` | 200 `{id, username, role, createdAt}` | `src/app/api/users/route.ts:11-45`; admin only, `src/permissions/user.ts:3-5` |
| Add to team | `POST /api/teams/:teamId/users` `{userId, role: "team-view-only"}` | 200 team-user row | `src/app/api/teams/[teamId]/users/route.ts:54-83` |
| Create team website | `POST /api/websites` `{name, domain, teamId}` | 200 website with `teamId` set and `userId` null | `src/app/api/websites/route.ts:31-97` |
| Or move an existing one | `POST /api/websites/:id/transfer` `{teamId}` | 200 website with the new `teamId` | `src/app/api/websites/[websiteId]/transfer/route.ts:36-46` |
| Sign in as the service user | `POST /api/auth/login` with the password just set | 200 `{token}` | same as the admin login |
| Create the key | `POST /api/me/api-keys` `{name}`, `Bearer` = service user token | 200 `{id, name, keyPrefix, createdAt, key}`; the key is returned once | `src/app/api/me/api-keys/route.ts:22-49` |
| Use the key | any read with `Authorization: Bearer umami_...` | 200 | `src/lib/auth.ts:36-73`, `:78-80` |

Why the key step cannot use the admin session:

- The only key routes are under `/api/me/api-keys`, and both use `auth.user.id` as the owner
  (`src/app/api/me/api-keys/route.ts:41`, `[keyId]/route.ts:19`, `src/queries/prisma/apiKey.ts:41-47`).
- Measured: `POST /api/users/:id/api-keys` as admin answers 404 (no such route); admin on
  `POST /api/me/api-keys` gets a key owned by `admin`; admin deleting the service user's key
  answers 404 (rows 20-25).
- A key cannot manage keys either: `/api/me/api-keys`, `/api/me/password`, `/api/auth`, `/api/users`,
  `/api/admin` and `/api/2fa` are closed to key authentication (`src/lib/api-key.ts:11-18`).

Roles (`src/lib/constants.ts:180-240`): `view-only` and `team-view-only` both carry an empty
permission list. A `team-view-only` member can read the team's websites, because reading only needs
a membership row (`src/permissions/website.ts:40-44`); every write needs a permission the role does
not have (`src/permissions/website.ts:151-213`, `src/permissions/team.ts:46-126`). Accepted team
roles on the route are `team-member`, `team-view-only`, `team-manager` (`src/lib/schema.ts:165`).

## 2. Isolation probes

Umami answers **401**, not 403, when a known caller lacks permission (`src/lib/response.ts:20-32`).
It validates the query before it checks access (`src/lib/request.ts:33-70`), so a malformed probe
would answer 400 on both sides. Every read probe is therefore run four ways with the same query:
A on A and B on B must be 200, A on B and B on A must be 401.

| Group | What | Caller | Rows | Expected | Result |
|---|---|---|---|---|---|
| 2a | 61 read routes under `/api/websites/:id` (website, stats, metrics, pageviews, sessions, session data, events, event data, funnels, goals, journeys, retention, attribution, breakdown, UTM, revenue, performance, errors, heatmaps, replays, export, segments, annotations, share-link list), realtime, 4 session-detail routes | own key | 127 | 200 | all pass |
| 2b | the same routes across the boundary, both directions; realtime; a session id of B asked through B's website (401) and through A's website (404 or an empty list) | other tenant's key | 132 | 401 or no data of B | all pass |
| 2c | website and team lists show only A; own team's join code is withheld; team B, its members and websites, the three admin lists, user B, own key list | A key | 15 | only A, or 401 | all pass |
| 2d | create, rename, reset, transfer and delete a website (own and B's); create an annotation, segment or share link (own and B's, body first accepted from the admin); create, rename and delete a team; raise own role; add self to team B; create or delete a key; change password; create a user; make self admin; delete user B; join with a wrong code (404); no credential (401) | A key | 37 | 401 | all pass |
| 2e | two planted leaks, see below | control key | 8 | leak happens | all pass |
| 2f | `GET /api/websites/:id/recorder` with no credential | nobody | 2 | 200, settings only | pass |

Planted leaks (they show the probes can fail, and pin two settings):

- A service user created with global role `user` instead of `view-only`, with the same
  `team-view-only` membership, creates its own website and its own team (200, 200).
- Any authenticated caller who learns a team's join code joins it as `team-member`, a writing role,
  and then reads its statistics (`src/app/api/teams/join/route.ts:20-37`). The code is returned
  only to the admin, owners and managers (`src/app/api/teams/[teamId]/route.ts:26-32`), so the
  worker must not store or log the `accessCode` it receives when it creates a team.

Public by design: `/api/websites/:id/recorder` skips authentication because the tracker fetches it
(`src/app/api/websites/[websiteId]/recorder/route.ts:14`). It returns session-replay settings, here
`{"enabled":false}`, and no statistics. Share links are public by design too; the design should
never create one (`shareId` on website create, `src/app/api/websites/route.ts:82-91`).

## 3. Revocation

| Action | Effect | When |
|---|---|---|
| Service user deletes the key (`DELETE /api/me/api-keys/:id` with its login token) | key answers 401 | next request, 7 to 13 ms after the delete returned; every request looks the hash up in the database (`src/lib/auth.ts:44`) |
| Admin sets a new password (`POST /api/users/:id` `{password}`) | old login token answers 401 (`src/lib/auth.ts:102-106`); **the API key keeps working** | next request |
| Admin removes the user from the team (`DELETE /api/teams/:teamId/users/:userId`) | key still identifies the user on `/api/me`, reads answer 401 | next request |
| Admin deletes the user (`DELETE /api/users/:id`) | key and token answer 401; the `api_key` rows are gone (`onDelete: Cascade`, `prisma/schema.prisma:49`) | next request |

Rotation with the admin credential alone, as run: admin sets a random password on the service
user, signs in as it, creates the new key, deletes the old one, discards password and token.
No service user password is ever stored.

## 4. Removal of a tenant

| Action | Rows left for tenant B (read from the database) |
|---|---|
| before | website 1, events 3, sessions 1, event data 1, shares 1, team 1, team users 2, user 1, keys 1 |
| `DELETE /api/websites/:id`, then `DELETE /api/teams/:id` | user 1, keys 1, everything else 0; **the key still authenticates** |
| `DELETE /api/users/:id` | 0 in every table |

Outside Umami Cloud these are hard deletes (`src/queries/prisma/website.ts:292-339`,
`src/queries/prisma/team.ts:180-266`, `src/queries/prisma/user.ts:121`). Deleting the team deletes
its websites itself (`team.ts:184-191`). The admin stays `team-owner` of every team it creates,
which is the second team-user row.

## 5. Self-hosted build

Every step works in the open-source build at v3.5.0. API keys are a self-hosted feature and are
switched off when `CLOUD_MODE` is set (`src/lib/api-key.ts:60-62`); no setting is needed to enable
them. The documentation says the same and recommends keys over login tokens:
https://docs.umami.is/docs/api/authentication ("API keys are long-lived credentials ... They don't
expire and can be revoked individually").

The nearest alternative, not needed: the service user's login token. Without Redis it carries no
expiry (`src/app/api/auth/login/route.ts:67`, `src/lib/jwt.ts:4-6`) and is revoked only by changing
the password or deleting the user; it can also create keys and change the password, which a key
cannot. With Redis it lasts 30 days from last use (`src/lib/constants.ts:19`,
`src/lib/auth.ts:119-125`). The key is the better credential for the console.

## 6. Nothing written to Umami's tables by us

`run.mjs` reaches the database only through `readDb`, which opens every connection with
`default_transaction_read_only=on`. It is used for `SELECT`s and for one `CREATE TABLE` that
PostgreSQL must refuse (row 27). What Umami stored: user role `view-only`, team role
`team-view-only`, website owned by the team with no user, key kept as a 128-character hash plus a
14-character prefix (row 26).

## Not covered

- 13 read routes that need the id of a stored object (one annotation, error issue, event,
  funnel, goal, replay or segment). The tenants here have none. They use the same website guard.
  *Corrected in round two: these routes are now probed; see "F" below.*
- Boards, links and pixels, the dashboard pages, and the `/mcp` endpoint, which accepts keys.
  Their create routes use the same two guards as websites (`src/app/api/links/route.ts:49-51`,
  `pixels/route.ts:46-48`, `boards/route.ts:62-64`); not run.
  *Corrected in round two: the three create routes were run and refuse a view-only key, but
  `POST /api/dashboard` creates a personal board with no role check, and that board can be
  shared; see "E" below.*
- Umami with Redis, where login sessions are stored and expire. Keys do not use Redis.
- Two-factor policy. If an admin turns on required 2FA, a new service user's login is limited to
  2FA setup (`src/app/api/auth/login/route.ts:54-60`) and could not create its key. Not run.
- The admin still has Umami's seeded default password in this stack; Umami reports
  `passwordChangeRequired` and does not enforce it on the API.
- Behaviour on Vercel and Neon. This ran on the Docker image only.
- Whether keys date from v3.4.0 (see above).

## Round two (2026-11-24)

**Verdict: yes for the reworded claim, with two stated conditions (D and E).**

The claim as first worded: "Umami teams, service users and keys can be provisioned through an
admin session, without touching its database." It cannot be an unconditional yes. In Umami 3.5.0
no route lets an admin create a key for another user. Round two re-checked this in the source and
over HTTP (group A0 below). The key is created by the service user's own session.

The reworded claim, which round two tests:

> A tenant's team, service user, membership, website and read key can be provisioned, and later
> fully removed, through Umami's HTTP API alone, without touching its database.

Reproduce, from this folder (Docker, Node 22 or later, the `umami/` submodule checked out):

```
node round-two.mjs     # one run: 653 rows, table, verdict per item; 1 to 3 minutes
node controls.mjs      # the 10 negative controls, one full run each
```

`round-two.mjs` starts its own stack (compose project `us-check-04-r2`, `docker-compose.r2.yml`,
the same pinned images, no fixed host port), runs, prints the table and a verdict per item,
removes the stack, and exits non-zero if any row differs. The table of the last run is in
`results-round-two.md`. The worker under test is `worker.mjs`. It uses HTTP only and keeps nothing
between runs. The script reads the database on a read-only connection, as in round one.

| Item | Claim | Verdict | Rows |
|---|---|---|---|
| A | Provisioning end to end through the API, key included; the service user's password is never stored | Yes | 34 |
| B | A second run creates no duplicate; a run stopped after any of the 11 steps is completed by the next run. Tested for 12 lower-case ASCII slugs (second run on 1, interrupted runs on 11), and the second-run part also for 4 slugs with upper case, surrounding spaces or non-ASCII letters. Interrupted runs were tested with lower-case ASCII slugs only | Yes | 93 |
| C | Removal deletes website, team, membership, user and key, reads back, and reports success only if the user is gone and the key answers 401. Tested for 25 lower-case ASCII slugs and the same 4 other slugs; interrupted removal for lower-case ASCII slugs only | Yes | 76 |
| D | A key holder cannot join another team with a join code | Yes, with one stated condition | 22 |
| E | A view-only service user cannot create a share link | Yes, with one stated condition | 28 |
| F | No cross-tenant read on any read route | Yes | 400 |

### What the worker does

Provisioning, 11 steps, each one finds before it creates:

| Step | Call | Credential |
|---|---|---|
| `team` | `GET /api/admin/teams?search=`, else `POST /api/teams` | admin |
| `join-code` | `POST /api/teams/:id` `{accessCode: 50 random characters}`, on every run, value not kept | admin |
| `reserve-id` | `GET /api/teams/:id/boards`, else `POST /api/boards` `{type: "mixed", teamId}` | admin |
| `user` | `GET /api/admin/users?search=`, else `POST /api/users` `{id: the board's id, role: "view-only", password: random}` | admin |
| `membership` | `GET /api/teams/:id/users`, else `POST /api/teams/:id/users` `{role: "team-view-only"}` | admin |
| `website` | `GET /api/teams/:id/websites?search=`, else `POST /api/websites` `{teamId}` | admin |
| `password` | `POST /api/users/:id` `{password: random}` | admin |
| `sign-in` | `POST /api/auth/login` with that password | none |
| `key` | `GET /api/me/api-keys`; keep the key the caller holds if it is listed, else `POST /api/me/api-keys` | service user session |
| `prune-keys` | `DELETE /api/me/api-keys/:id` for every other key | service user session |
| `discard-password` | `POST /api/users/:id` `{password: random}`, value not kept | admin |

Removal, 2 steps: `DELETE /api/users/:id`, then `DELETE /api/teams/:id`. Each looks the object up
by name first, because Umami answers 500 when asked to delete a user or team that is gone. After
the user step the worker reads back: no user of that name, no member of the team besides its
owner, and the key the caller passed answers 401. After the team step: no team of that name. If
any of these fails, removal throws and does not report success.

Names. The worker trims and lower-cases the slug before any call, and refuses a slug that is
empty or longer than 50 characters. Team name, username (`svc-<slug>`) and website name are
all that one spelling. The hostname is trimmed and lower-cased too.

### A. Provisioning and the password. Yes.

- No admin key route (A0, 11 rows). In the source, `apiKey.create(` appears in one file
  (`src/queries/prisma/apiKey.ts:10`), `createApiKey(` is called from one route
  (`src/app/api/me/api-keys/route.ts:39`), and that route sets the owner from the caller's session
  (`:41`). The script reads the source and fails if any of the three changes. Over HTTP, three
  guessed admin routes answer 404. The admin on `POST /api/me/api-keys` with `userId` of user A in
  the body gets a key owned by `admin`. The admin cannot delete user A's key (404).
- The password. It is generated at random and used for one sign-in. After the key exists the
  admin replaces it with a second random value that is never used. After the run, the first
  password is refused (401), the session it produced is refused (401,
  `src/lib/auth.ts:102-106`), and the key works (200). The key survives both password changes.
- The worker never stores the password. A new worker, given only the slug and hostname, replaced
  A's key: new key 200, first key 401, still one key in the database.
- Password sign-in cannot be switched off for one user. The admin cannot set an empty or null
  password (400, 400; the schema requires 8 characters,
  `src/app/api/users/[userId]/route.ts:30`). It is made useless in practice: the password is 32
  random bytes that nobody holds. `DISABLE_LOGIN` hides the login pages only
  (`src/app/login/page.tsx:7`); read in the source, not run.
- A key cannot create a key or change the password (401, 401).

Enforced by a test: every password, session, replaced key and earlier join code the worker held
is tried after each run and must be refused (14 rows, one per run that finished).

### B. Re-run and partial failure. Yes.

- Second run on a complete tenant, given the key the console holds: same team, user and website
  ids, the key kept (same `api_key` row), one of everything.
- 11 runs, each stopped after a different step, each followed by one full run. After every one:
  1 team, 1 user, memberships `team-owner` (the admin) and `team-view-only`, 1 website, 1 board,
  1 key, the user's id held by the board; the key reads its website; nothing the stopped run held
  is accepted.
- A run that stops after `key` loses the key it created. The next run creates another and deletes
  the lost one, which then answers 401.
- A limit, recorded as a row: a run that stops after `sign-in` leaves a session that is accepted
  until the next run replaces the password. Nobody holds it; it lived in the stopped process.

Not tested: two workers provisioning the same tenant at the same time. Team names are not unique
in Umami, so two concurrent runs could each create a team. The worker refuses to continue if it
finds two teams with one name. Lookups read the first 100 substring matches.

### C. Removal. Yes.

- Order: user first, then team. After the first call alone the key answers 401 on `/api/me` and
  on a read. Left at that point: the team, its website, the board, the admin's ownership row.
- Run again: nothing left. For tenant B, read from the database: events 3 to 0, sessions 1 to 0,
  event data 1 to 0, reports 2 to 0, segments 1 to 0, annotations 1 to 0, memberships 2 to 0,
  boards 1 to 0. A third run does nothing and does not fail.
- The other order, measured: with the team deleted first the key still authenticates (200) until
  the user is deleted.
- Removal stopped after its last step, then run again: nothing left.
- 11 half-made tenants (provisioning stopped after each step, never completed), each removed:
  nothing left, no key accepted.
- At the end the database holds the `admin` user and no team, membership, website, event, board,
  share or key.

### Slugs and names (defect found in review, fixed the same day)

The first version of the worker sent the slug as given and compared names exactly. A reviewer
found that with slug `Tenant-Mixed` the second run failed and removal reported success while
the user and a working key remained. Reproduced with the old logic (mutations
`exact-name-match,remove-no-readback` together): 33 rows failed, among them a second run
answering 400 "User already exists" and a key answering 200 after a "completed" removal.

What Umami 3.5.0 does with a name. The stored spellings are rows of the reproduction run; the
51-character team name, the refused domains and the search were measured once with a scratch
probe that is not part of `round-two.mjs`; the 100-character limit is read in the source only:

| Name | Stored as | Source |
|---|---|---|
| Username | lower-cased with JavaScript `toLowerCase`, not trimmed: `svc-Tenant-Mixed` becomes `svc-tenant-mixed`, `svc-  Padded-Slug  ` keeps its spaces, `svc-İstanbul` becomes `svc-i̇stanbul` (two code points). Login and the duplicate check lower-case too | `src/app/api/users/route.ts:39`, `src/queries/prisma/user.ts:60-62` |
| Team name | exactly as given: case and spaces kept, not unique, at most 50 characters (51 answers 400) | `src/app/api/teams/route.ts:33-36` |
| Website name | trimmed, case kept, at most 100 characters | `src/app/api/websites/request-schema.ts:30` |
| Website domain | trimmed, then checked against a pattern: `Tenant-Mixed.example`, a padded and a non-ASCII domain all answered 400 | `request-schema.ts:31` |
| Search (`?search=`) | case-insensitive substring. A search for `svc-İstanbul` did not find `svc-i̇stanbul`; a search for the stored spelling did | `src/lib/prisma.ts:838-853` |

So the same defect existed for team names in the other direction: Umami keeps their case, the
username loses it, and two spellings of one slug gave two teams and one user. The website
lookup was by domain and was not affected, but a mixed-case hostname was refused by Umami.

After the fix, for the slugs `Tenant-Mixed`, `"  Padded-Slug  "`, `ténant-É` and `İstanbul`
(32 rows in B, 16 in C): the stored team name, username and website name are the one trimmed,
lower-case spelling; a second run and a third run with the slug in upper case find the same
ids and keep the key; removal leaves nothing, the key answers 401, and a second removal has
nothing to do.

Read-back (6 rows): a tenant's user was renamed by hand so that the name lookup cannot find it.
Removal answered "removal incomplete: the team still has a member that is not its owner" and
the key was still accepted. After that user was deleted by id, removal completed and the key
answered 401.

Not tested: interrupted provisioning or removal with these four slugs; slugs with quotes or
control characters; a tenant created by the first version under a mixed-case team name, which
the fixed worker would not find; removal with no key passed when both the user and the team
have been renamed.

### D. Join code. Yes, with one stated condition.

Condition: the worker replaces the code at provisioning and does not keep the new value.

The code cannot be switched off through the API. `null` is refused (400). More than 50 characters
is refused (400). An empty string is accepted for one team (200) and then works as a code: a key
joined with `""` (200). A second team cannot be emptied (500; the column is unique,
`prisma/schema.prisma:235`). So the code is rotated, not disabled
(`src/app/api/teams/[teamId]/route.ts:38-55`).

Control, on a team the worker did not provision: a view-only key that belongs to no team joined
with the code as created, got the role `team-member`, read the team's website and renamed it. The
global role `view-only` does not stop this (`src/app/api/teams/join/route.ts:20-37`).

On a provisioned tenant: every code the team had before the last rotation is refused (404). The
current code is 50 random characters. The tenant's own key is not shown it on `/api/teams/:id`,
`/api/teams` or `/api/me/teams`, and cannot change it (401).

What stays open, recorded as a row: the route still exists. A caller with any valid Umami
credential who also knows a team's current code joins that team as `team-member`. The code can be
read by the admin credential (`GET /api/teams/:id`, `GET /api/admin/teams`) and by anyone who can
read Umami's database. Both already read every tenant. No tenant, and no holder of one tenant's
key, can read another team's code.

### E. Share link. Yes, with one stated condition.

Condition: before the service user is created, the worker creates a board owned by the tenant's
team and creates the user with that board's id.

The route round one's reviewer reported, measured on a control user without that step: a
`view-only`, `team-view-only` key saved a personal dashboard that shows the team's website
(`POST /api/dashboard`, no role check, `src/app/api/dashboard/route.ts:23-66`), created a share
link for it (`POST /api/boards/:userId/shares`; the owner of a personal board may always edit it,
`src/permissions/board.ts:206-208`), and the link read the website's totals with no credential
(200, 2 page views). The link did not read visitor rows (401, `src/permissions/share.ts:92-94`).
It kept working after the key was deleted. The admin can list and delete it. Deleting the user
deletes it. `POST /api/share` with the user's own id does the same.

No role or setting prevents this. What does: Umami keeps a personal dashboard in a board whose id
is the user's id, and `POST /api/users` accepts an `id` (`src/app/api/users/route.ts:13`). With a
team board already holding that id, the service user is refused on all 12 routes tried (401):
read or save the dashboard, share that board, both generic share routes, the website share
route, create a personal or team board, rename or delete the reserved board, create a link,
create a pixel. The database held 0 share links after the attempts. The key still read its
website.

This rests on behaviour Umami does not document: the user route accepts an id and does not check
it against boards. An upgrade can change it. The test fails if it does.

### F. Isolation matrix. Yes.

Umami 3.5.0 has 119 routes with a GET handler. The script reads that list from the source. 106
are probed and 13 are listed in `matrix.mjs` with the reason they are not. A route that is in
neither list fails the run.

| Probed | Routes | Expected |
|---|---|---|
| Website routes without a second id (round one's list) | 61 | own 200, other tenant 401 |
| Website routes with the id of a stored object: session (4), event, annotation, segment, funnel (2), goal (2) | 11 | own 200, other tenant 401; B's object id through A's website returns no B data |
| Website routes with an id and no stored object: error issue (4), replay (2) | 6 | own passes the guard (404, or 200), other tenant 401 |
| Other routes with a tenant id: realtime, team, team users, team websites, team boards, team links, team pixels, the reserved board, its share list | 9 | own 200, other tenant 401 |
| Lists: websites, my websites, my teams, teams, boards, links, pixels, website charts | 8 | only the caller's tenant |
| Closed to a tenant key even for its own ids: 4 admin routes, 3 user routes, team member detail, key list, 2FA status, dashboard | 11 | 401 |

185 cross-tenant rows, 0 leaks. 174 own-data rows, all as expected. The recorder route is public
by design and returns settings only.

Not probed, with reasons: `heartbeat`, `scripts/telemetry`, `auth/subscription` and `me` take no
tenant id; `recorder` is public; the two share routes are exercised in E and no share exists for
a provisioned tenant; six link and pixel routes, because tenants have none and a view-only key
cannot create one (E). The boards, links and pixels lists are empty for every tenant, so "only
the caller's tenant" is weak evidence for those three.

### Negative controls

Each mutation removes one safeguard from the worker, or plants one leak. The script must then
exit non-zero with failed rows in the item that safeguard serves. `node controls.mjs` runs all
ten. Result of the run on 2026-11-24, after the fix above:

| mutation | serves | what it does | exit | rows that failed, by item | caught |
|---|---|---|---|---|---|
| keep-password | A | the worker does not replace the password it signed in with | 1 | A: 6, B: 11 | yes |
| no-team-lookup | B | the worker creates the team without looking for an existing one | 1 | A: 4, B: 57, C: 2 | yes |
| keep-old-keys | B | the worker does not delete the keys it replaces | 1 | A: 3, B: 7 | yes |
| exact-name-match | B | the worker sends and matches names as given, not as Umami stores them | 1 | B: 24, C: 16 | yes |
| remove-team-first | C | removal deletes the team before the user | 1 | C: 3 | yes |
| remove-keep-user | C | removal never deletes the service user | 1 | C: 26 | yes |
| remove-no-readback | C | removal reports success without reading back | 1 | C: 1 | yes |
| keep-join-code | D | the worker leaves the join code the team was created with | 1 | A: 4, B: 12, D: 3, C: 11 (run aborted) | yes |
| no-id-reservation | E | the worker creates the service user without reserving its id | 1 | A: 3, B: 16, E: 7, F: 6, C: 4 | yes |
| leak-membership | F | service user A is also made a member of team B before the matrix | 1 | F: 94 | yes |

10 of 10 mutations caught.

A mutation also fails rows outside its own item where a later step depends on it.

### Conditions now enforced by a test

- The service user's global role is `view-only` and its team role `team-view-only` (state row
  after every run).
- The worker's password, session, replaced keys and earlier join codes are refused after a run.
- Exactly one key per service user after any sequence of runs.
- Removal deletes the user first; the key is dead after that one call.
- Names are sent and matched in one trimmed, lower-case spelling (4 slugs).
- Removal does not report success while a team member or a working key remains.
- The join code is rotated at provisioning and the tenant's key is never shown it.
- The service user's id is held by a team board; the 12 share and board routes refuse it.
- Every GET route in Umami's source is probed or listed.

### Corrections to round one

- "13 read routes that need the id of a stored object ... not covered": 11 of the 17 such routes
  are now probed with stored objects and 6 with the guard only. Round one's count of 13 left out
  the four session routes it had probed.
- "Boards, links and pixels ... create routes use the same two guards as websites": true for
  `POST /api/boards`, `/api/links` and `/api/pixels` (401, run in E). Not true for the personal
  dashboard: `POST /api/dashboard` creates a board for any signed-in caller. See E.
- Section 2d reported a share link refused for a view-only key. That holds for the website
  route. A share link through the personal dashboard was possible. See E.
- Line 153 of the document should give the order: delete the service user, then the team.

### Not tested in round two

- Round one's 37 write probes were not re-run against the new configuration, apart from the
  share, board, link, pixel and join routes in D and E.
- `run.mjs` was changed in one place: its route list moved to `read-routes.mjs`, which both
  scripts import. The list is byte-identical. `run.mjs` was not re-run, because it binds fixed
  host ports.
- Concurrent workers; more than 100 name matches in a lookup.
- Umami with Redis, two-factor policy, `DISABLE_LOGIN`, the `/mcp` endpoint (off unless
  `MCP_ENABLED=1`, `src/app/mcp/route.ts:44`).
- A crash inside Umami during one of its own delete calls.
- The hosted deployment. This ran on the Docker image on one machine.
- Brute force of a 50-character join code or a 32-byte password. Umami's rate limits were not
  examined.
