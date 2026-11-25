# Architecture Overview

<!-- Keep this document up to date as the system evolves. It captures structural
     knowledge that helps both humans onboarding and agents building context at
     session start. Focus on the "shape" of the system — not usage instructions
     (that's CLAUDE.md) or API docs (that's code comments). -->

## Tech Stack

<!-- List the primary technologies with versions. Keep it scannable. -->

| Category | Technology | Notes |
|----------|-----------|-------|
| Framework | | |
| Language | | |
| Data fetching | | |
| UI primitives | | |
| Styling | | |
| Testing | | |
| Runtime | | |

## Project Structure

<!-- Directory tree showing where things live and what each directory owns.
     Only include directories that carry architectural meaning — skip node_modules,
     build output, etc. -->

<!-- Replace with the actual project directory tree. Annotate each directory
     with a short description of what it owns. Example:

     src/
       app/                  Entry points and routing
       components/           Reusable UI components
       lib/                  Shared utilities
       services/             External API integrations
     tests/                  Test suites
-->

## Key Abstractions

<!-- Document the main abstractions the codebase relies on: adapter layers,
     service classes, hook patterns, etc. Focus on the class/module hierarchy
     and the rules for using them. -->

### Data Access Layer

<!-- How does the app talk to external systems (APIs, blockchain, databases)?
     What's the abstraction boundary? What should components never call directly?
     Skip this section if not applicable. -->

## Routes

<!-- Map URL paths to the modules/components that render them.
     Skip this section if not applicable. -->

| Route | Module | Description |
|-------|--------|-------------|
| `/` | | |

## Data Flow

<!-- How does data move through the system? From external source → data layer →
     state management → UI. Include caching strategy if relevant. -->

## Environment Variables

<!-- List the key environment variables grouped by public/server. Don't include
     actual values — just the variable names and their purpose.
     Skip this section if not applicable. -->

| Variable | Purpose |
|----------|---------|
| | |

## Scripts

<!-- List the commands developers and agents need to know. -->

| Command | Purpose |
|---------|---------|
| `dev` | |
| `build` | |
| `test` | |
| `lint` | |

---

## Domain-Specific Sections (Examples)

<!-- Not every project needs these. Pick the ones that apply to your stack and
     domain, adapt them, or use them as inspiration for your own sections. -->

### Number / Precision Handling

<!-- If the project deals with financial data, big numbers, or precision-sensitive
     math, document the conventions here: which library, what precision, how
     conversions work. Skip this section if not applicable. -->

### Other Sections You Might Consider

- **Provider / Context Hierarchy** — nesting order of React context providers
- **Hook Patterns** — consistent caching, invalidation, or data-fetching conventions
- **Auth / Session Management** — login flows, token handling, role-based access
- **Error Handling Patterns** — error boundaries, retry strategies, user-facing messages
- **API Versioning** — how the API evolves without breaking clients
- **Smart Contract Architecture** — contract relationships, upgrade patterns, deployment flow
