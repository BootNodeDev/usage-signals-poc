# Architecture checks

The architecture document lists eight checks that the proof of concept has to pass. All eight
have now been run as local experiments. Round one (2026-11-19) ran six of them. Round two
(2026-11-24 and 25) ran the other two, and went back over the first five to turn each condition
into a test or to state exactly what cannot be claimed.

Each folder holds a script that starts its own isolated stack, runs the experiment, prints the
evidence and the verdict, and removes the stack. Each folder's README has the detail, the numbers
and the sentence the architecture document should carry.

Independent reviewers who had not written the experiments re-ran them, changed one condition at a
time to confirm that each script fails when it should, and added cases the authors had not
included. What they found is listed under each check.

## Results

| # | Claim | Result |
|---|---|---|
| 1 | Forwarding gives the same seven metrics as direct ingestion | Yes, with three conditions |
| 2 | No part of the IP is written to disk | Yes, in the experiment's gateway model |
| 3 | One visitor through two gateways is counted once | Yes, on one machine |
| 4 | Provisioning through an admin session, without touching the database | No as worded; yes as reworded |
| 5 | The collector pipeline runs end to end, path rules as collector statements | Yes, with stated limits |
| 6 | Umami rebuilds with a bumped Next.js and passes the contract tests | Yes |
| 7 | Browsers and OTLP exporters fall back to the second address | No as worded |
| 8 | The passive Wallets Kit capture works with a real wallet | Yes, with one condition |

**1. Forwarding through Umami's batch route with gateway-supplied country, browser, OS, device,
timestamp and salt gives the same seven metrics as direct ingestion.**

Yes, with three conditions. 29 of 29 facts hold and 14 of 14 negative controls are caught.

- Round one found that a visit crossing a clock hour was split in two. That is removed when the
  forwarder carries the cache token Umami returns: forwarded and direct ingestion then give the
  same metrics and the same visit groups. Condition one: the spool record needs one new field
  that is the same for every event of a page load, which is a change to what the tracker sends.
- Condition two: the forwarder keeps its page-load memory across a restart. The experiment
  persists it to a file and restarts the forwarder mid-run.
- Condition three: the visit does not cross 00:00 UTC. There the daily salt changes, and one
  visit counts as direct 2 visitors and 3 visits against forwarded 4 and 4. This follows from the
  design's daily salt.
- The deployment conditions of round one (`ENABLE_CLIENT_SALT=1`, a forwarder User-Agent that
  Umami's bot check accepts, Umami's own labels, a valid non-private placeholder address, one
  batch per country) are now checked by `probe.mjs`, which reads back from Umami. It caught all
  seven violating deployments, including the silent drop. It reports only the first violation
  when one hides the others.
- Duplicates are not prevented: Umami has no idempotency key, and a resent event is stored again.
  They can be removed. The experiment detects the surplus with a count of forwarded against
  stored events, deletes the affected sessions through Umami's API and replays them from the
  spool; the result equals the clean run. This needs PostgreSQL, the spool still holding those
  records, and the list of resent batches.

Run: `cd check-01-02 && node round2.mjs`. Controls: `node controls.mjs`.

**2. The country reaches Umami by header (placeholder address in the proxy header, no ip in the
payload, one batch per country), so that no part of the IP is written to disk.**

Yes, for the experiment's gateway model, its forwarder and Umami. Eight addresses in 47 written
forms were found in none of: the spool files, the gateway log, the forwarder's requests, a dump of
the database, the raw database files, and the container logs with every SQL statement logged. The
reviewer searched 60 further forms and found none. Round one could not check the gateway side
because there was no spool; round two adds a minimal one. The gateway of the deployed prototype
has no spool and was not scanned.

Run: `cd check-01-02 && node round2.mjs`.

**3. One visitor sent through two gateways on one day is counted once.**

Yes, on one machine with two gateway processes and two Umami instances on one database. 22 of 22
cases match and 11 of 11 negative controls are caught.

- Round one's conditions (identical `APP_SECRET`, `ENABLE_CLIENT_SALT`, `SALT_ROTATION` and time
  zone on both Umami instances; the same daily salt, placeholder address and forwarder User-Agent
  on both gateways) are now detected by a probe that sends one synthetic visitor through each
  side and compares. It must run at every deploy and at least daily, because a daylight-saving
  difference shows only one period ahead, and it must enter through the same front as visitors.
- One IPv6 address written in several notations now counts once. Bracketed addresses, a port and
  a zone are normalised. Non-addresses and IPv4 with leading zeros are refused.
- On a day when the two locations use different salts, ten visitors of whom three use both
  locations count as 13. The disagreement is detectable; the flag the design describes is not
  built.
- A different time zone splits every visitor on every day, not only at the month boundary as
  round one said.

Not established without two real locations: clock skew, a network partition, DNS, and a visitor
reaching one location over IPv6 and the other over IPv4.

Run: `cd check-03 && node round-two.mjs`. Controls: `node round-two.mjs --controls`.

**4. Umami teams, service users and keys can be provisioned through an admin session, without
touching its database.**

No as worded. In Umami 3.5.0 a key can be created only by its own user: `createApiKey` has one
caller, which takes the owner from the caller's session.

Yes as reworded: a tenant's team, service user, membership, website and read key can be
provisioned, and later fully removed, through Umami's HTTP API alone, without touching its
database. 653 rows, 0 not as expected, and 10 of 10 negative controls are caught.

- The worker signs in once as the new service user with a random password, creates the key, then
  replaces the password with a random value it does not keep. The key survives.
- A second run creates no duplicate, and a run stopped after any of the 11 steps is completed by
  the next run.
- Removal deletes the user first and then the team, and reads back before it reports success: no
  user, no other team member, and the key answers 401.
- The reviewer found that names with upper-case letters broke both: Umami lower-cases usernames
  and the worker matched exactly, so a removal reported "completed" and left a working key. The
  worker now normalises the name before any call. Tested with mixed case, padding, accents and a
  Turkish dotted I.
- The team join code cannot be disabled. The worker rotates it to 50 random characters and
  discards it.
- A view-only key could publish its own tenant's totals through a share link. Binding the service
  user to a team board closes it; this relies on `POST /api/users` accepting an `id`, which is
  not documented.
- Isolation: 185 cross-tenant rows on 106 of 119 read routes, no leak.

Not tested: two workers at once (team names are not unique in Umami).

Run: `cd check-04 && node round-two.mjs`. Controls: `node controls.mjs`.

**5. The collector pipeline runs end to end as configured, and the path rules run as collector
statements.**

Yes, with stated limits. 184 of 184 assertions and 165 of 165 vectors on a collector built with
the Collector Builder; 14 of 14 mutations are caught.

- The Builder manifest of round one produced a binary that did not start. One line fixes it. On
  the contrib image the same run gives 183 of 184 and exits 1, by design.
- The writer now removes duplicates. Each point is keyed on its own identity (tenant, service,
  instance, attributes, start and end time) and the key is written in the same transaction as the
  counts. Exact under a collector redelivery, an exporter retry and two writers receiving the
  same batch at the same moment. Not removed: one point written twice inside one block of one
  request, which the edge merges before the writer sees it.
- A key kept for the document's 2 days is not enough: a redelivery 4 days later is counted twice,
  and the disk queue holds 7 days. 8 days, with points older than 8 days refused, holds.
- The sentence that a Stellar secret key "is always redacted" cannot be kept. What can be
  guaranteed: every stored path segment is at most 36 printable ASCII characters, enforced at the
  edge and again in the writer. On 2,708 route templates of six public APIs the bound changes 9
  (0.33%). It cannot stop a secret split across segments or one of 36 characters or fewer.
- Of 21 refusal paths, 3 answer 200 and are recorded nowhere: a token without a tenant claim, a
  tenant claim that is not a UUID, and an exponential histogram.

Run: `cd check-05 && npm ci --ignore-scripts && node run.mjs`. Controls: `node mutations.mjs`.

**6. Umami v3.5.0 rebuilds with a bumped Next.js and passes the contract tests the same day.**

Yes. Not revisited in round two. Rebuilt with Next.js 16.4.6 in place of 16.4.2 through a
dependency override and a regenerated lockfile, with no change to Umami's source, in about six
minutes on a laptop. About a third of the console tests exercise Umami, and only its API, not its
dashboard. A release less than 24 hours old also needs pnpm's release-age exemption.

Run: `check-06/run.sh`.

**7. Browsers and OTLP exporters fall back to the second address when one ingest location is
dead.**

No as worded. Whether a client reaches the second address depends on how the first one fails and
on whether the client already holds a connection to it. Measured for Chromium, the OpenTelemetry
SDKs for Node.js, Python and Go, and the Collector's `otlphttp` exporter, 50 repetitions each.

On a new connection, with the dead address returned first by DNS:

| Failure of the first address | Result |
|---|---|
| Refuses connections | All reach the second in milliseconds |
| Answers nothing | Chromium and Node.js in about 0.3 s; Python after its exporter timeout (10 s by default); Go and the Collector after 15 to 17 s |
| Accepts the connection, never answers | None reaches the second |

On a connection that was already open when the location failed:

| Client | Location goes silent | Location resets the connection |
|---|---|---|
| Chromium | request lost | delivered |
| Node.js SDK | lost while the connection is fresh; delivered after 20 s idle | delivered |
| Python SDK | lost after 10 s | delivered |
| Go SDK | delivered, 31 to 37 s late | lost, no retry |
| Collector | delivered, 50 s late | delivered, 5 to 7 s late |

The next send, 60 seconds later, is delivered by every client. No client rotates between
addresses: with both alive, all traffic goes to the first one DNS returns. A page closed while
the request is in flight behaves like an open page.

Not covered: the DNS provider removing the dead address, TTL and resolver caching, IPv6, HTTPS,
and other browsers.

Run: `cd check-07 && node run.mjs` (about 30 minutes).

**8. The passive Wallets Kit capture works in a browser with a real wallet.**

Yes, with one condition. 13 of 13 cases in Chromium with Stellar Wallets Kit 2.8.0.

- A script loaded outside the tenant's code records modal opened, wallet option clicked and modal
  closed. When the kit's structure changes, or there is no kit, it records nothing and throws
  nothing.
- With the real wallet extension loaded, the kit lists it as installed, the option is clicked,
  the wallet's window is closed and the three events arrive in order. The condition: approval by
  a real account was run only against a stand-in for the extension, since creating an account
  means holding a seed phrase. The folder's README has the two-minute manual steps.
- The reviewer found that, sent through the product's tracker, each event carried the page title
  and the full URL, so an address in either was sent. The capture now rebuilds its events through
  the tracker's `beforeSend` hook with no title, referrer, query or fragment and with the path
  scrubbed. The assertions run on what the collecting server received.
- The Freighter wallet was renamed Varial on 2026-10-29. Kit 2.8.0 lists it as "Varial" and
  earlier 2.x releases as "Freighter", so the fixed wallet list needs both.

Not run: Firefox, Safari, earlier kit versions. Page views sent by the same tracker still carry
the title and the full URL; scrubbing them is the wrapper's job, and the wrapper is not built.

Run: `cd check-08 && npm ci --ignore-scripts && node run.mjs`.

## Sentences of the architecture document these results change

- "A visit is one visitor's activity within one clock hour, which is Umami's own rule": Umami
  cuts at the hour only when the tracker's cache token is not resent.
- "Umami's own check stays enabled behind the gateway": behind a forwarder it sees only the
  forwarder and filters no visitor.
- "provisioned through an admin session": keys cannot be; see check 4 for the wording that holds.
- "a point-level key kept for 2 days": 8 days, with older points refused.
- The Stellar secret key "is always redacted": replace with the 36-character bound of check 5.
- "Browsers and OTLP exporters fall back to the second address when one ingest location is dead":
  see check 7. A location that fails should close its port, and the health check should test a
  full request; this is a recommendation drawn from the results, not something measured.
- Wallet funnel events "never carry an address": true only if the capture strips title and URL
  through the tracker's hook, as in check 8.

## Findings beyond the checks

- Umami answers 200 and reports items as processed while its bot check discards them, so a
  forwarder whose User-Agent matches that check loses every event without an error.
- A per-visitor value sent as `salt` is not stored; sent as `id` it is written to the database.
- A Vercel-hosted Umami carries no GeoLite2 file, so a payload `ip` makes it answer 500.
- Umami's image build is not reproducible: the country database is downloaded without a
  checksum, and the base image and tools are referenced by tag.
- A token request to Umami stores one session row and no event.
- Umami lower-cases usernames, stores team names as given and does not require them to be unique.

## Limits

Everything here ran in Docker on one machine, not on the hosted deployment and not across two
locations. The fields the forwarder relies on (`timestamp`, `salt`, `browser`, `os`, `device`) and
the cache token are in Umami's source and not in its documentation, so an upgrade can change
them. The corrections made after the round-two review were re-run by their authors; two of them
(checks 1 and 2, and check 8) were also re-run once more separately, the others were not.
