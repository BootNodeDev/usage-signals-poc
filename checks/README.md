# Architecture checks

The architecture document lists eight checks that the proof of concept has to pass. Six were
run on 2026-11-19 as local experiments, five against unmodified Umami 3.5.0 and one against an
unmodified OpenTelemetry Collector, and then re-examined by independent reviewers who tried to
refute them. Each folder holds a script that starts its
own isolated stack, runs the experiment, prints the evidence and the verdict, and removes the
stack.

None of the six needs a change to Umami's source or custom collector code. All six need a
sentence of the document corrected; the wording is in each folder's README.

## Results

**1. Forwarding through Umami's batch route with gateway-supplied country, browser, OS, device,
timestamp and salt gives the same seven metrics as direct ingestion.**

Yes, with conditions. Umami must run with `ENABLE_CLIENT_SALT=1`, the forwarder's User-Agent
must be one Umami's bot check accepts, and the gateway must send Umami's own browser, OS and
device labels. The reviewer confirmed equality on 296 events from 40 visitors in 10 countries.
Two limits: a visit that crosses a clock hour is split in two, because the forwarded path does
not carry the tracker's cache token, and a batch delivered twice doubles page views.
Run: `node check-01-02/run.mjs`.

**2. The country reaches Umami by header (placeholder address in the proxy header, no ip in the
payload, one batch per country), so that no part of the IP is written to disk.**

Yes, for Umami's database and logs; the prototype has no spool to check. The placeholder must
be a valid non-private address, and `192.0.2.1` is recommended. One batch per country is
required, because Umami applies the header to every item of a batch.
Run: `node check-01-02/run.mjs`.

**3. One visitor sent through two gateways on one day is counted once.**

Yes, on one machine with two gateway processes and two Umami instances on one database. Both
Umami instances need identical `APP_SECRET`, `ENABLE_CLIENT_SALT`, `SALT_ROTATION` and time
zone; the reviewer changed each one and each split the visitor in two. Both gateways need the
same daily salt, placeholder address and forwarder User-Agent, and must see the same text form
of an address: one IPv6 address written two ways counts twice.
Run: `node check-03/run.mjs`.

**4. Umami teams, service users and keys can be provisioned through an admin session, without
touching its database.**

Mostly. Teams, service users, memberships and websites work through the admin session. Keys do
not: Umami lets a user create only its own, so the worker signs in once as the new service user.
Removing a tenant must also delete that user, or its key keeps working. The reviewer confirmed
isolation on 61 read routes. Two limits: a team's join code lets any key into that team, and a
view-only key can publish its own tenant's totals through a share link.
Run: `node check-04/run.mjs`.

**5. The collector pipeline runs end to end as configured, and the path rules run as collector
statements.**

Yes, after one round of fixes. The edge pipeline runs on upstream collector components with no
custom Go code, checked on the unmodified contrib image and not on a Builder build. The first
review refuted the experiment: by repeating an attribute key, one tenant could write as another,
and one tenant could stall ingestion for all. Both were fixed and a second review confirmed
that tenant attribution, the metric filter, the discarding of traces and logs, the attribute
allowlist and the disk queue hold. Counts were exact for 6,000 simulated and 280 real requests.
Two limits: the test writer does not deduplicate, so a redelivered batch is counted again, and
the path rules cover a fixed list of identifier shapes, so a secret seed that is truncated,
split or encoded can still be stored.
Run: `cd check-05 && npm ci --ignore-scripts && node run.mjs`.

**6. Umami v3.5.0 rebuilds with a bumped Next.js and passes the contract tests the same day.**

Yes. Rebuilt with Next.js 16.4.6 in place of 16.4.2 through a dependency override and a
regenerated lockfile, with no change to Umami's source, in about six minutes on a laptop. The
console suite passes 112 of 112, the same as against the upstream image. About a third of those
tests exercise Umami, and only its API, not its dashboard. A release less than 24 hours old
also needs pnpm's release-age exemption.
Run: `check-06/run.sh`.

**7. Browsers and OTLP exporters fall back to the second address when one ingest location is
dead.**

Not tested. The prototype has one ingest location.

**8. The passive Wallets Kit capture works in a browser with a real wallet.**

Not tested.

## Findings beyond the checks

- Umami answers 200 and reports items as processed while its bot check discards them, so a
  forwarder whose User-Agent matches that check loses every event without an error.
- Behind a forwarder, Umami's own bot check sees only the forwarder's User-Agent and filters
  nothing.
- A per-visitor value sent as `salt` is not stored; sent as `id` it is written to the database.
- Deleting a tenant's website and team leaves its service user and a working key.
- A Vercel-hosted Umami carries no GeoLite2 file, so a payload `ip` makes it answer 500.
- Umami's image build is not reproducible: the country database is downloaded without a
  checksum, and the base image and tools are referenced by tag.

## How the results were reviewed

Two reviewers who had not written the experiments re-ran them, changed one condition at a time
to confirm that each script fails when it should (18 mutations, all caught), added cases the
authors had not included, and checked each source citation against Umami at v3.5.0. For checks
1, 2, 3, 4 and 6 no claim was refuted, and every short statement was reworded to say what was
tested and no more. Check 5 was refuted on its first review, corrected, and confirmed on a
second review limited to the points raised.

## Limits

Everything here ran on the Docker image on one machine, not on the hosted deployment and not
across two locations. The fields the forwarder relies on (`timestamp`, `salt`, `browser`, `os`,
`device`) are in Umami's source and not in its documentation, so an upgrade can change them.
