# Architecture checks

The architecture document lists eight checks that the proof of concept has to pass. All eight ran
as local experiments: six in round one (2026-11-19) and the other two in round two (2026-11-24
and 25). Round two also went back over the first five, to turn each condition into a test or to
state what the results do not show.

Each folder holds a script that starts its own isolated stack, runs the experiment, prints the
evidence and the verdict, and removes the stack. The folder's README has the detail, the numbers,
how to run it, and the sentence the architecture document should carry.

Reviewers who had not written the experiments re-ran them. They changed one condition at a time
to confirm that each script fails when it should, and added cases the authors had missed.

## Results

| # | Claim | Result | Detail |
|---|---|---|---|
| 1 | Forwarding gives the same seven metrics as direct ingestion | Yes, with three conditions | [check-01-02](check-01-02/README.md) |
| 2 | No part of the IP reaches the disk | Yes, in the experiment's gateway model | [check-01-02](check-01-02/README.md) |
| 3 | Two gateways count one visitor once | Yes, on one machine | [check-03](check-03/README.md) |
| 4 | Provisioning through an administrator session, without touching the database | No as worded; yes as reworded | [check-04](check-04/README.md) |
| 5 | The collector pipeline runs end to end, path rules as collector statements | Yes, with stated limits | [check-05](check-05/README.md) |
| 6 | Umami rebuilds with a bumped Next.js and passes the contract tests | Yes | [check-06](check-06/README.md) |
| 7 | Browsers and OTLP exporters fall back to the second address | No as worded | [check-07](check-07/README.md) |
| 8 | The passive Wallets Kit capture works with a real wallet | Yes, with one condition | [check-08](check-08/README.md) |

## Sentences of the architecture document these results change

- "A visit is one visitor's activity within one clock hour, which is Umami's own rule." Umami cuts
  at the hour only when the tracker does not resend its cache token.
- "Umami's own check stays enabled behind the gateway." Behind a forwarder, the check sees only
  the forwarder and filters no visitor.
- "provisioned through an admin session." Only a key's own user can create it. Check 4 has the
  wording that holds.
- "a point-level key kept for 2 days." Keep it 8 days and refuse older points.
- The Stellar secret key "is always redacted". Replace this with the 36-character limit of check 5.
- "Browsers and OTLP exporters fall back to the second address when one ingest location is dead."
  Check 7 shows that this depends on how the location fails. A location that fails should close its port, and the health
  check should test a full request. This advice follows from the results; check 7 did not
  measure it.
- Wallet funnel events "never carry an address". This holds only if the capture strips the title
  and the URL through the tracker's hook, as in check 8.

## Findings beyond the checks

- Umami answers 200 and reports items as processed while its bot check discards them. A forwarder
  whose User-Agent matches that check loses every event without an error.
- Umami does not store a per-visitor value sent as `salt`, but writes one sent as `id` to the
  database.
- A Vercel-hosted Umami carries no GeoLite2 file, so a payload `ip` makes it answer 500.
- Umami's image build is not reproducible. It downloads the country database without a checksum,
  and refers to the base image and tools by tag.
- A token request to Umami stores one session row and no event.
- Umami lower-cases usernames, stores team names as given and does not require them to be unique.

## Limits

Everything here ran on one machine (checks 1 to 7 in Docker), not on the hosted deployment and not across two
locations.

The forwarder relies on fields that Umami's source has but its documentation does not:
`timestamp`, `salt`, `browser`, `os`, `device` and the cache token. An upgrade can change them.

Their authors re-ran the corrections made after the round-two review. Two of them, for checks 1
and 2 and for check 8, also ran once more in a separate pass; the others did not.
