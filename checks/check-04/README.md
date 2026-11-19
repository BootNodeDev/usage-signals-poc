# Check 04: provisioning Umami tenants through its API

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
- Boards, links and pixels, the dashboard pages, and the `/mcp` endpoint, which accepts keys.
  Their create routes use the same two guards as websites (`src/app/api/links/route.ts:49-51`,
  `pixels/route.ts:46-48`, `boards/route.ts:62-64`); not run.
- Umami with Redis, where login sessions are stored and expire. Keys do not use Redis.
- Two-factor policy. If an admin turns on required 2FA, a new service user's login is limited to
  2FA setup (`src/app/api/auth/login/route.ts:54-60`) and could not create its key. Not run.
- The admin still has Umami's seeded default password in this stack; Umami reports
  `passwordChangeRequired` and does not enforce it on the API.
- Behaviour on Vercel and Neon. This ran on the Docker image only.
- Whether keys date from v3.4.0 (see above).
