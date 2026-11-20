# Usage Signals proof of concept

A working prototype of the tenant and operator experience of Usage Signals, a shared web and
API analytics service for projects built on Stellar. It exists to try the riskiest assumptions
and to record a demo. It is not the product.

## Layout

| Path | What it is | Deployed as |
| --- | --- | --- |
| `console/` | Our code: the ingest gateway, the pinned tracker file and the local stack | Vercel project 1 |
| `umami/` | Umami, unmodified, as a git submodule pinned to the commit of tag `v3.5.0` | Vercel project 2 |

Both projects use one PostgreSQL database. Umami keeps its tables in the `public` schema and
ours live in the `usage_signals` schema.

## Start here

- `console/README.md`: run the stack locally and run the checks.
- `DECISIONS.md`: every technical choice, the source it follows and the alternative rejected.

After cloning, fetch Umami with `git submodule update --init`.

## What differs from the intended architecture

Umami is a separate Vercel deployment closed with Vercel Authentication, not a private
network service. There is no OpenTelemetry Collector, no disk spool and a single location. `DECISIONS.md` lists these gaps.

## Licence

Apache-2.0. The tracker file under `console/public/s/` is Umami's and is MIT licensed.
