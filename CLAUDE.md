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
| Package manager | pnpm (`console/pnpm-lock.yaml`) | The READMEs run the scripts with `npm run` |
| Linting | None configured | |
| Naming | camelCase functions and variables, UPPER_SNAKE_CASE constants, kebab-case file names | Tests are `test/<name>.test.mjs`; scripts are `.mjs` |

## Code Style

- **Semicolons:** yes
- **Quotes:** single
- **Print width:** no formatter enforces one
- **Trailing commas:** in multi-line literals in the Node code (`lib/`, `scripts/`, `test/`)
- **Indent:** spaces, width 2
- **Import ordering:** Node built-ins with the `node:` prefix, then packages, then relative imports
- **Browser scripts** in `console/public/` (`data.js`, `app.js`, `charts.js`, `landing.js`): plain scripts with `var` and `function` inside an IIFE with `'use strict'`, loaded by `<script>` tags; no bundler

## Working Rules

- Pages read data only through `window.LData` in `console/public/data.js`. In that file, `currentProjectSlug()` is the only code that reads the address. Tests enforce both.
- Keep sample data out of `console/public/`. A test fails on the old sample strings, a link to a `.html` file, a hardcoded UUID, or a mention of Umami outside `index.html`.
- The tenant console and the operator console never link to each other (`test/routes.test.mjs`).
- Treat `console/lib/tracker.generated.js` and `console/public/s/` (tracker and `manifest.json`) as generated. Regenerate them with `npm run pin-tracker`.
- Keep Umami unmodified. Fetch it with `git submodule update --init`.
- Qualify every SQL statement with its schema: ours is `usage_signals`, Umami's is `public`.
- Record each technical choice in `DECISIONS.md`, with its source and the alternative rejected.
- Local values live in `console/local.env`. Overrides go in `console/.env.local`, which git ignores.

## Architecture

See [`architecture.md`](architecture.md) for project structure, data flow, and key abstractions.

## Testing

- **Framework:** `node:test` (`describe` and `it`) with `node:assert/strict`
- **Run tests:** in `console/`, start the stack with `npm run up` (needs Docker), then run `npm test` in a second terminal. Test files run one at a time (`--test-concurrency=1`).
- **What to test:** each endpoint against the running stack: gateway refusals and address truncation, the read endpoints and their small counts, routes, and the seed profiles
- **Architecture checks:** each `checks/*/run.mjs` starts its own isolated stack. Results are in `checks/README.md`.

## Commit Standards

Use [Conventional Commits](https://www.conventionalcommits.org/):

**Format:** `type(scope): subject`

- **Scope** is optional: `feat: add login` and `feat(auth): add login` are both valid
- **Scopes in use:** `console`, `checks`, `umami`
- **Subject** uses imperative mood, lowercase after the colon, no trailing period
- **Body** (optional): separated by a blank line, explains *what* and *why*

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

- In `console/`: `npm run up`, then `npm test` in a second terminal (needs Docker)
- There is no lint step and no separate build. On Vercel the build command is the seed, `node scripts/seed.mjs`.

## References

- [`DECISIONS.md`](DECISIONS.md): every technical choice, its source and the alternative rejected
- [`checks/README.md`](checks/README.md): the six architecture checks and their results
- [`console/README.md`](console/README.md): local stack, layout and configuration
- [Umami documentation](https://docs.umami.is/docs)
- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Neon documentation](https://neon.com/docs)
- [SCF request for proposals: Web and API Analytics for Stellar Ecosystem Projects](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#web-and-api-analytics-for-stellar-ecosystem-projects)
