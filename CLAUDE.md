<!-- starter-kit: v2026.09 -->

# Agent Configuration

<!-- This is your project's agent configuration. Claude Code reads this file
     as CLAUDE.md. Other agents (Cursor, Windsurf, etc.) read AGENTS.md, which
     points here. Customize each section for your stack. -->

---

## Stack & Conventions

<!-- Replace with your project's specifics. The table format makes it easy
     to scan and reminds you to be explicit about each category. -->

| Category | Technology | Notes |
|----------|-----------|-------|
| Language | TypeScript (strict mode) | |
| Framework | Next.js / React | |
| Package manager | pnpm | |
| Linting | ESLint + Prettier | Run `pnpm lint` before committing |
| Naming | camelCase vars/functions, PascalCase components/types, kebab-case files | |

## Code Style

<!-- Agents will guess formatting rules if you don't spell them out.
     Be explicit about the decisions your linter/formatter enforces. -->

- **Semicolons:** yes/no <!-- pick one -->
- **Quotes:** single/double <!-- pick one -->
- **Print width:** 80/100/120 <!-- pick one -->
- **Trailing commas:** all/es5/none <!-- pick one -->
- **Indent:** spaces/tabs, width 2/4 <!-- pick one -->
- **Import ordering:** <!-- describe the grouping order or reference the plugin -->

## Working Rules

<!-- Project-specific operational constraints the agent must respect.
     These are the "always/never" rules that aren't captured by linting. -->

- Use **pnpm** only (never npm or yarn)
- Treat generated files as **read-only** <!-- e.g., config/generated-config.json -->
- Path alias: `@/*` maps to `src/` (tsconfig `paths`)

## Architecture

<!-- See architecture.md for the full system overview: project structure,
     key abstractions, data flow, and domain-specific details. Keep this
     section as a quick pointer -- not a duplicate. -->

See [`architecture.md`](architecture.md) for project structure, data flow, and key abstractions.

## Testing

<!-- Define what to test, how to test it, and what not to bother with -->

- **Framework:** Vitest + React Testing Library
- **Run tests:** `pnpm test`
- **What to test:** Business logic, API integrations, component behavior
- **What not to test:** Styling, third-party library internals, trivial getters/setters
- **Coverage:** Aim for meaningful coverage, not a number. Cover the paths that matter.

## Commit Standards

Use [Conventional Commits](https://www.conventionalcommits.org/):

**Format:** `type(scope): subject`

- **Scope** is optional: `feat: add login` and `feat(auth): add login` are both valid
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

<!-- Commands the agent (and developers) should run before declaring work done. -->

- `pnpm lint`
- `pnpm test`
- `pnpm build` (when feasible for runtime-impacting changes)

## References

<!-- Links to external documentation the agent should consult when working
     on this project. Keeps the agent grounded in current APIs rather than
     stale training data. -->

- [Project docs](https://example.com) <!-- replace URL and description -->
- [API reference](https://example.com) <!-- replace URL and description -->
