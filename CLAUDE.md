<!-- starter-kit: v2026.09 -->

# Agent Configuration

Proof of concept of Pulse, a shared web and API analytics service for Stellar ecosystem projects. "Usage Signals" was the working title; it stays only in identifiers such as the repository name, the URLs and the package name. This is not the product: see `README.md` and `DECISIONS.md`.

---

## Stack & Conventions

| Category | Technology | Notes |
|----------|-----------|-------|
| Language | JavaScript, ES modules (`"type": "module"`) | No TypeScript, no build step |
| Runtime | Node.js 24 or newer (`engines.node`) | Vercel resolves it to its default, 26.x |
| Framework | None | One Vercel function (`console/api/index.js`) and static pages in `console/public/` |
| Database | PostgreSQL 18 through `pg` 8.23.1 | Neon on Vercel, Docker locally |
| Analytics engine | Umami 3.5.0, unmodified | Git submodule `umami/`, deployed as its own Vercel project |
| Package manager | pnpm 12.20.0 (`packageManager` in `console/package.json`, `console/pnpm-lock.yaml`) | The READMEs and `CONTRIBUTING.md` run the scripts with `npm run` |
| Linting | Biome 2.6.8 (`console/biome.json`) | `npm run lint` and `npm run lint:fix`; the pre-commit hook and CI run it too |
| Naming | camelCase functions and variables, UPPER_SNAKE_CASE constants, kebab-case file names | Tests are `test/<name>.test.mjs`; scripts are `.mjs` |

## Code Style

- **Formatter:** Biome formats every file it covers; run `npm run lint:fix` rather than formatting by hand
- **Semicolons:** no. The scripts inside the HTML pages keep theirs: Biome lints them but does not format them
- **Quotes:** single
- **Print width:** 100
- **Trailing commas:** in multi-line literals, calls and parameters
- **Indent:** spaces, width 2
- **Import ordering:** Node built-ins with the `node:` prefix, then packages, then relative imports (Biome sorts them)
- **Browser scripts** in `console/public/` (`data.js`, `app.js`, `charts.js`, `landing.js`, and the script in each page): ES modules loaded by `<script type="module">`, with `var` and `function` at the top level and no wrapper function. `data.js`, `app.js` and `charts.js` each set one global (`window.LData`, `window.App`, `window.Charts`); no bundler

## Working Rules

- Pages read data only through `window.LData` in `console/public/data.js`. In that file, `currentProjectSlug()` is the only code that reads the address. `test/routes.test.mjs` enforces the second.
- Keep sample data out of `console/public/`. A test fails on the old sample strings, a link to a `.html` file, a hardcoded UUID, or a mention of Umami outside `index.html`.
- The tenant console and the operator console never link to each other, and the public view links to neither (`test/routes.test.mjs`).
- The public view reads only `GET /api/public/projects`, which sends each active project's name, page views and visitors and no other project detail (decision 57 in `DECISIONS.md`).
- Treat `console/lib/tracker.generated.js` and `console/public/s/` (tracker and `manifest.json`) as generated. Regenerate them with `npm run pin-tracker`.
- Keep Umami unmodified. Fetch it with `git submodule update --init`.
- Qualify every SQL statement with its schema: ours is `usage_signals`, Umami's is `public`.
- Record each technical choice in `DECISIONS.md`, with its source and the alternative rejected.
- Local values live in `console/local.env`. Overrides go in `console/.env.local`, which git ignores.

## Architecture

See [`architecture.md`](architecture.md) for project structure, data flow, and key abstractions.

## Testing

- **Framework:** `node:test` (`describe` and `it`) with `node:assert/strict`
- **Run tests:** in `console/`, start the stack with `npm run up` (needs Docker), then run `npm test` in a second terminal. Test files run one at a time (`--test-concurrency=1`). CI (`.github/workflows/ci.yml`) runs them on every pull request and on every push to `main`.
- **What to test:** each endpoint against the running stack: gateway refusals and address truncation, the read endpoints and their small counts, routes, and the seed profiles
- **Architecture checks:** each check's run script (`run.mjs`, or `run.sh` in check 6) starts its own isolated stack. Results are in `checks/README.md`.

## Commit Standards

Use [Conventional Commits](https://www.conventionalcommits.org/):

**Format:** `type(scope): subject`

- **Scope** is optional: `feat: add login` and `feat(auth): add login` are both valid
- **Scopes in use:** `console`, `checks`, `umami`
- **Subject** uses imperative mood, lowercase after the colon, no trailing period
- **Body** (optional): separated by a blank line, explains *what* and *why*
- **Enforced** by commitlint (`console/commitlint.config.js`) in the `commit-msg` hook, and in CI on each pull request's commits and title

**Prefixes:**

| Prefix | Purpose |
|--------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `chore` | Maintenance, dependencies, config |
| `docs` | Documentation only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `style` | Formatting, whitespace, semicolons |
| `ci` | CI/CD pipeline changes |
| `perf` | Performance improvement |
| `build` | Build system or external dependencies |
| `revert` | Reverts a previous commit |
| `wip` | Work in progress (avoid on main) |
| `release` | Release-related changes |

## PR Workflow

- Every PR must reference an issue (`Closes #`)

  > No related issue? Use `No related issue.` as the first line of the Summary section.

- Mirror the issue's acceptance criteria in the PR
- Self-review your diff before requesting peer review
- Keep PRs small and focused -- one issue, one PR
- PR titles use the same conventional commit format (`feat: add user dashboard`)
- Use `/sdlc:create-pr` to create PRs -- it reads the template and fills every section automatically

## Label Conventions

GitHub form dropdowns (like the Priority field in issue templates) only work through the web UI. When issues are created via `gh` CLI or REST API, dropdown values become unstructured body text -- not queryable, not consistent. **Labels are the API-reliable mechanism for structured metadata.**

**Priority** (bugs, features, and epics):

| Label | Description |
|-------|-------------|
| `priority: critical` | Blocking work, system down, or security issue |
| `priority: high` | Must be addressed in current sprint |
| `priority: medium` | Should be addressed soon |
| `priority: low` | Nice to have, can wait |

Labels are queryable: `gh issue list --label "priority: high"`.

The `/sdlc:create-issue` skill applies these labels automatically when creating issues via CLI. Bug, feature, and epic templates include a Priority dropdown for web UI users, but labels are the source of truth for programmatic workflows.

## Guardrails

- Do not commit secrets, API keys, or credentials
- Do not modify CI/CD pipelines without team review
- Do not skip tests or linting to make a build pass
- When in doubt, ask -- don't assume

## Change Strategy

- Prefer small, focused diffs over broad refactors
- Preserve existing UX unless the task explicitly changes it
- Avoid introducing new patterns when a project pattern already exists
- Update docs only when behavior or workflow changes

## Validation Checklist

- In `console/`: `npm run lint`
- In `console/`: `npm run up`, then `npm test` in a second terminal (needs Docker)
- There is no separate build. On Vercel the build command is the seed, `node scripts/seed.mjs`.

## References

- [`DECISIONS.md`](DECISIONS.md): every technical choice, its source and the alternative rejected
- [`checks/README.md`](checks/README.md): the architecture checks and their results, one row per check linking its folder
- [`console/README.md`](console/README.md): what the console is and how to run it
- [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, local stack, scripts and tests
- [Umami documentation](https://docs.umami.is/docs)
- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Neon documentation](https://neon.com/docs)
- [SCF request for proposals: Web and API Analytics for Stellar Ecosystem Projects](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#web-and-api-analytics-for-stellar-ecosystem-projects)
