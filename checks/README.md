# Architecture checks

The architecture document lists eight checks that the proof of concept has to pass. Five were
run on 2026-11-19 as local experiments against unmodified Umami 3.5.0. Each folder holds a
script that starts its own isolated stack, runs the experiment, prints the evidence and the
verdict, and removes the stack.

None of the five needs a change to Umami's source. All five need a sentence of the document
corrected; the exact wording is in each folder's README.

| Check | Verdict | What the document has to add | Run |
| --- | --- | --- | --- |
| 1. Forwarding through the batch route with gateway-supplied fields gives the same seven metrics as direct ingestion | Passes with a correction | Umami must run with `ENABLE_CLIENT_SALT=1`, and the forwarder's User-Agent must be one that Umami's bot check accepts | `node check-01-02/run.mjs` |
| 2. The country reaches Umami by header, with a placeholder address and no `ip` in the payload | Passes with one precision | The placeholder must be a documentation-range address such as `192.0.2.1`; a private or loopback address loses the country | `node check-01-02/run.mjs` |
| 3. One visitor sent through two gateways on one day is counted once | Passes with a correction | Same setting as check 1, and the two Umami instances must share `APP_SECRET`, salt settings and time zone | `node check-03/run.mjs` |
| 4. Umami teams, service users and keys are provisioned through an admin session | Passes with a correction | A key can only be created by its own user: the worker signs in once as the new service user. The user needs the global `view-only` role as well, and removing a tenant must delete the user | `node check-04/run.mjs` |
| 6. Umami 3.5.0 rebuilds with a bumped Next.js and passes the contract tests the same day | Passes with a correction | The override lives in `pnpm-workspace.yaml`, and a release less than a day old also needs pnpm's release-age exemption committed | `check-06/run.sh` |

Not run: check 5 (the OpenTelemetry Collector pipeline), check 7 (fallback to a second ingest
address) and check 8 (passive Stellar Wallets Kit capture).

## Findings beyond the checks

- Umami answers 200 and reports items as processed while its bot check discards them, so a
  forwarder whose User-Agent matches that check loses every event without an error.
- Behind a forwarder, Umami's own bot check sees only the forwarder's User-Agent and filters
  nothing.
- A per-visitor value sent as `salt` is not stored; sent as `id` it is written to the database.
- Deleting a tenant's website and team leaves its service user and a working key.
- A team's access code lets any authenticated caller join it with a writing role, so it must be
  treated as a secret.
- Umami's image build is not reproducible: the country database is downloaded without a
  checksum, and the base image and tools are referenced by tag.

## Limits

Everything here ran on the Docker image on one machine, not on the hosted deployment. The
fields the forwarder relies on (`timestamp`, `salt`, `browser`, `os`, `device`) are in Umami's
source and not in its documentation, so an upgrade can change them.
