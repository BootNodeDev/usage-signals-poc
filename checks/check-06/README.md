# Check 6: rebuild Umami v3.5.0 with a bumped Next.js

Run on 2026-11-19, macOS arm64, Docker 29.9.2.

**Verdict: passes, with one correction to the design.** Umami v3.5.0 rebuilt with Next.js
16.4.6 in place of 16.4.2 from a dependency override and a regenerated lockfile alone, with no
change to Umami's source, and the console suite passes 112 of 112 against the rebuilt image,
the same count as on the upstream image. Clone to verdict took about six minutes. The
correction: for a release less than a day old the build recipe carries one more piece, a
release-age exemption that pnpm writes itself.

> The check: "Umami v3.5.0 rebuilds with a bumped Next.js and passes the contract tests the
> same day."

## Reproduce

```sh
./run.sh                    # clone, override, build, test, verdict; about 6 minutes
IMAGE='ghcr.io/umami-software/umami:3.5.0@sha256:b64f40400d77bcadd39cf5c62a1e368c99524ca442024f96e1133355a19a5dbc' ./run.sh   # control
./fresh-release-probe.sh    # the same-day question; about 3 minutes, see below
```

Needs Docker with 6 GB free in its disk, and `console/node_modules` installed. `run.sh` exits
non-zero unless the image builds, runs the Next.js version of `override.yaml`, and the suite
reports 112 passing and none failing. It works in a `mktemp -d` directory and prints its path.

## Corrections for the architecture document

The check sentence holds as written. Three statements around it need a change.

1. **The build recipe (line 46 and the pin table, line 125).** Proposed text: "Our delta is the
   build recipe: a dependency override for Next.js, and for React when a fix exists, in
   `pnpm-workspace.yaml` with its regenerated lockfile and, for a release less than a day old,
   the release-age exemption that pnpm writes next to it; a pinned country database in place
   of the default download; and our own tracker build configuration."
2. **React.** Umami v3.5.0 already resolves the newest React, 19.3.1, and no advisory is open
   against it. A React bump could not be tested because none exists. The override lines for
   `react` and `react-dom` in this check move nothing.
3. **The risk row (line 315).** True as written: v3.5.0 pins 16.4.2 and the release of 3
   November 2026 is 16.4.5. Worth adding that this release fixes seven moderate advisories
   (CVSS 6.0 to 6.9), below the 24-hour threshold of line 230 (CVSS 7.0), and that Umami's
   source uses none of the affected features. Upstream `master` still pinned 16.4.2 on
   2026-11-19, sixteen days later.

## Versions

| Package | Pinned in v3.5.0 | Resolved in v3.5.0 | Newest patch on 2026-11-19 | Used here |
|---|---|---|---|---|
| `next` | `16.4.2` (`umami/package.json:115`) | 16.4.2 | 16.4.6 (2026-11-09) | 16.4.6 |
| `react` | `^19.3.1` (`package.json:125`) | 19.3.1 | 19.3.1 (2026-10-14) | 19.3.1 |
| `react-dom` | `^19.3.1` (`package.json:126`) | 19.3.1 | 19.3.1 (2026-10-14) | 19.3.1 |

Package manager: pnpm 12.3.4 (`package.json:14`, `Dockerfile:2`), on `node:22.23.4-alpine`
(`Dockerfile:1`). Sources: https://registry.npmjs.org/next, https://registry.npmjs.org/react,
https://registry.npmjs.org/react-dom.

The security release the document refers to is **16.4.5**, published 2026-11-03
(https://github.com/vercel/next.js/releases/tag/v16.4.5). Its notes list seven advisories, all
moderate, all fixed in 16.4.5:

| Advisory | CVSS 4.0 | Subject | Affected 16.x |
|---|---|---|---|
| GHSA-mfr8-8qww-v76h | 6.3 | `use cache` called through `unstable_cache()` | 16.3.0 to 16.4.4 |
| GHSA-vc7v-qv4w-wrv8 | 6.3 | nested `use cache`, root params | 16.2.0 to 16.4.4 |
| GHSA-vvgp-ww4w-46vf | 6.3 | Cache Components fallback shells | 16.4.0 to 16.4.4 |
| GHSA-rhh4-g77r-r9qj | 6.3 | `use cache` with binary arguments | 16.0.0 to 16.4.4 |
| GHSA-pc58-hwjq-p385 | 6.3 | self-hosted apps forwarding fetched responses | 16.0.0 to 16.4.4 |
| GHSA-7qx7-33qx-rqx2 | 6.9 | SVG rejection bypass in image optimization | 16.0.0 to 16.4.4 |
| GHSA-f3mh-rxg3-f5g2 | 6.0 | HttpOnly cookie exposure on Edge runtime routes | 16.0.0 to 16.4.4 |

Source: `https://api.github.com/repos/vercel/next.js/security-advisories`, each at
`https://github.com/vercel/next.js/security/advisories/<id>`. The GitHub advisory database
lists two of them against `next@16.4.2` and none against 16.4.5 or 16.4.6
(`https://api.github.com/advisories?ecosystem=npm&affects=next@16.4.2`).

16.4.6 (https://github.com/vercel/next.js/releases/tag/v16.4.6) is a bug-fix backport on top of
16.4.5. It is the newest patch in the same major and minor, so it is the target. No major or
minor jump is needed. 16.4.5, the smallest version with the fixes, resolves to the same
lockfile shape but was not built.

In Umami's source at the tag: no `use cache`, no `unstable_cache`, no Edge runtime route, no
`next/image` (searched under `umami/src`). GHSA-pc58-hwjq-p385 was not assessed.

## The override

pnpm reads `overrides` from `pnpm-workspace.yaml` (https://pnpm.io/settings, section
`overrides`: "instruct pnpm to override any dependency in the dependency graph"). Umami already
keeps an `overrides` block there (`umami/pnpm-workspace.yaml:19`). `run.sh` inserts the three
lines of `override.yaml` at the top of that block:

```yaml
overrides:
  next: 16.4.6
  react: 19.3.1
  react-dom: 19.3.1
```

and regenerates the lockfile with `pnpm install --lockfile-only`, run with pnpm 12.3.4 inside
`node:22.23.4-alpine`. `git status` in the build tree then shows two modified files and nothing
else: `pnpm-workspace.yaml` (+3 lines) and `pnpm-lock.yaml` (150 lines added, 152 removed). `package.json`
is not touched: the override wins over its exact `16.4.2`.

Lockfile, packages that moved:

- `next` 16.4.2 to 16.4.6, with `@next/env` and the eight `@next/swc-*` platform packages.
- `zod` 4.6.5 dropped: the one subtree that used it (`ai` and `@ai-sdk/*` under `next-intl`'s
  tooling) now shares the 4.6.7 already in the lockfile. Nobody asked for this move.
- `react`, `react-dom`: same version. Their two entries change the specifier from `^19.3.1` to
  `19.3.1` and rewrite the React peer ranges recorded for third-party packages. An override
  for `next` alone gives the same resolved versions with 126 diff lines in place of 302.

The regenerated lockfile was identical in three runs (SHA-256 `3f54478f...522f5`).

## Build

Umami's own `Dockerfile`, unchanged, no build arguments: `docker build --no-cache`.

| | Rebuilt | Upstream |
|---|---|---|
| Reference | `usage-signals/umami:3.5.0-next16.4.6` | `ghcr.io/umami-software/umami:3.5.0@sha256:b64f4040...` |
| Image id | `sha256:6e2d9d2b7827d7e9140b408612998ee3840d8c80f1486ae5845a28f76e260339` | `sha256:a2cb9c4a...` |
| Size | 927,227,752 bytes | 915,258,315 bytes |
| Architecture | arm64 | arm64 |

The rebuilt image is local and was not pushed, so it has no registry digest. Four builds all
succeeded; none failed, so no neighbouring version had to be tried.

Proof that the bump is real, each checked by `run.sh` or by hand:

- `/app/node_modules/next/package.json` in the image: 16.4.6 (upstream: 16.4.2).
- The build log and the running container's log both print `▲ Next.js 16.4.6`.
- 433 compiled files under `.next` name 16.4.6 and none names 16.4.2 (upstream: the reverse).
- `/login` and `/` answer 200 with Umami's pages; `/api/heartbeat` and `/script.js` answer 200.

## Tests

`run.sh` starts `compose.yml` (the stack of `console/docker-compose.yml` under project
`us-check-06`, with the image under test), then seeds, starts `dev.mjs` and runs `npm test`
inside one `node:24.22.1-alpine` container on the stack's network. Only `DATABASE_URL`,
`DATABASE_URL_UNPOOLED`, `UMAMI_URL`, `UMAMI_NOGEO_URL` and `COMPOSE_PROJECT_NAME` are
overridden; the rest comes from `console/local.env`.

| Image | Tests | Pass | Fail |
|---|---|---|---|
| Upstream 3.5.0 (control, same harness) | 112 | 112 | 0 |
| Rebuilt with Next.js 16.4.6 | 112 | 112 | 0 |

No failure to explain on either image.

Why a container and not ports 43106 and 43206 on the host: with the local server on those
ports the control run gave 111 of 112. `serves the pinned tracker with the integrity value the
demo page declares` (`console/test/gateway.test.mjs:422`) fetches the demo page, which is only
served for the registered host `localhost:4301` (`console/scripts/fixtures.mjs`). That failure
does not involve Umami and is the same on any image. Inside the container the server uses 4300
and 4301 without touching the host, and the suite's fixed ports 4310 to 4321 cannot collide
with another run.

`COMPOSE_PROJECT_NAME` is needed because one test runs `docker compose -f
console/docker-compose.yml exec postgres pg_dump` (`gateway.test.mjs:439`). The variable takes
precedence over the `name:` in that file
(https://docs.docker.com/compose/how-tos/project-name/), so the command reads this check's
database. Verified: under that variable `docker compose -f console/docker-compose.yml ps` lists
the `us-check-06` containers.

## Timings

`run.sh` on this laptop: two full runs, and one that stopped after the build when Docker's
disk was full:

| Step | Seconds |
|---|---|
| Clone the tag | 1 |
| Resolve: override and lockfile | 28 to 38 |
| Install and build: `docker build --no-cache` | 222 to 291 (a fourth build alone: 197) |
| Stack up, seed, suite | 67 to 76 (the suite itself: 14) |
| **Total** | **322 to 367** |

Inside the build: frozen install 51 s, the runner's own install 45 to 50 s, `pnpm build:docker`
99 to 130 s. Other work was running on the machine during two of the builds.

## The same day

The newest stable Next.js was ten days old, so no real same-day release could be built.
`fresh-release-probe.sh` uses the newest canary (`16.5.0-canary.55`, 14 hours old) as a
stand-in and runs Umami's install step only:

1. `pnpm install --lockfile-only` with the override succeeds, and pnpm **adds ten entries to
   `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` on its own** (`next` and the nine
   `@next/*` packages at that exact version).
2. `pnpm install --frozen-lockfile` with the regenerated lockfile and only the override line:
   refused, `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.
3. The same install with `pnpm-workspace.yaml` as pnpm left it: succeeds.

pnpm's `minimumReleaseAge` defaults to 1440 minutes and is checked on locked versions too
(https://pnpm.io/settings, sections `minimumReleaseAge`, `minimumReleaseAgeExclude`,
`minimumReleaseAgeStrict`). So a same-day bump works, provided the whole of
`pnpm-workspace.yaml` is committed with the lockfile and the reviewer accepts the exemption
lines. Two consequences for the design:

- The exemption switches off, for those packages, the guard against a compromised fresh
  release. That is the trade the 24-hour commitment makes; it should be a reviewed line.
- With `minimumReleaseAge` set explicitly anywhere (workspace, global config, environment),
  pnpm is strict by default and, by its documentation, fails or prompts in step 1 instead of
  writing the exemption. Not tested here.

What has to be automated for this to be routine:

- A job that, on an advisory, rewrites the one version in the override, regenerates the
  lockfile in the pinned Node and pnpm, and opens a change showing the lockfile package moves.
- An image build in CI that pushes by digest and signs (the document's own requirement).
- The suite runnable against a given image. Today it assumes the shared stack: fixed ports
  4310 to 4321, the demo site on `localhost:4301`, and the path of `console/docker-compose.yml`.
  `compose.yml` and the runner container in `run.sh` work around all three without editing it.
- Disk hygiene. Each uncached build leaves about 4 GB of layers and cache. This check filled
  Docker's disk once (PostgreSQL then failed to start with "No space left on device").

## Not reproducible

- **Country database.** `umami/scripts/build-geo.js:31` downloads
  `GeoLite2-City.tar.gz` from the `master` branch of `GitSquared/node-geolite2-redist` with no
  checksum. SHA-256 of the file in the upstream image: `9db04e8a...927b`; in every image built
  today: `060a8699...a33c`. The document's replacement of this step was not done here.
- **Runner stage dependencies.** `Dockerfile:78-81` runs `pnpm add npm-run-all dotenv chalk
  semver prisma@7.10.0 ...` with no lockfile. Today: npm-run-all 4.1.5, dotenv 18.0.10, chalk
  6.0.1, semver 7.8.5, the same as in the upstream image; their dependencies float.
- **Base image and tools.** `node:22.23.4-alpine` by tag (`Dockerfile:1`; today
  `sha256:0e175475...8202`), `apk add` without versions (`Dockerfile:11`, `:65`), `npm install
  -g pnpm@12.3.4` without an integrity check (`Dockerfile:18`, `:29`, `:66`).
- **Image bytes.** Four builds from the same inputs gave four image ids.
- **Lockfile regeneration** can move packages nobody named (`zod` above).

## Not covered

- A real Next.js patch release under a day old, built and tested. The install path is shown
  with a canary; the build and suite ran on a ten-day-old release.
- A React bump, a fix that needs a minor or major jump, and a bump that fails to build.
- Umami's dashboard under the new framework, beyond two pages answering 200. The suite calls
  Umami's API (ingestion, login, websites, statistics); roughly 40 of the 112 tests reach a
  running Umami, the rest test the console alone. Umami's own unit and Playwright suites were
  not run. The "isolation tests" the document names do not exist in this repository.
- linux/amd64, CI, signing, an SBOM scan of the result, rollout and rollback.
- Umami deployed on Vercel, as in the proof of concept's production: this check builds the
  container image only.
