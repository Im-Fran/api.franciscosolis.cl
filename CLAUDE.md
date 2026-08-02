# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

Single pnpm monorepo for the public REST API behind **franciscosolis.cl**. It wires
together two Cloudflare Workers, both living directly in this repo:

- `apps/api` — public gateway Worker, deployed to `api.franciscosolis.cl`.
- `apps/landing` — internal Worker with the landing page's GitHub stats, only reachable
  from `apps/api` via a Cloudflare service binding, never public directly.

Each app keeps its own `CLAUDE.md` and `README.md`. When working on the actual
implementation of a Worker, read/edit inside `apps/api` or `apps/landing` — the root repo
only owns workspace-wide wiring (pnpm workspace/catalog, root scripts).

## Stack

- pnpm workspaces (`pnpm@11.17.0`, see `packageManager` in `package.json`), packages
  glob'd from `apps/*` and `packages/*` (`pnpm-workspace.yaml`).
- Both Workers use Hono + hono-openapi + valibot + axios + Wrangler, all pinned via a
  shared pnpm `catalog` in `pnpm-workspace.yaml` — do not add per-app version pins for
  those deps, add/bump them in the catalog instead.
- Cloudflare Workers runtime (`nodejs_compat`), no separate build step; Wrangler bundles
  on `dev`/`deploy`.

## Commands (run from repo root)

- `pnpm install` — installs for the whole workspace.
- `pnpm run dev` — runs `dev` in every workspace app in parallel (`api` on :8787,
  `landing` on :8788).
- `pnpm run deploy` — deploys every workspace app.
- `pnpm run cf-typegen` — regenerates Cloudflare binding types (`CloudflareBindings`) in
  every app after a `wrangler.jsonc` change.

Individual apps can also be run from their own directory (`cd apps/api && pnpm run dev`).

## Architecture notes (non-obvious)

- **Service binding, not HTTP**: `apps/api` talks to `apps/landing` through a Cloudflare
  service binding (`LANDING` in `apps/api/wrangler.jsonc`), not a public HTTP call. This
  only resolves when both Workers are deployed under the exact names configured
  (`landing` Worker name must match the `service` field of the binding).
- **Merged OpenAPI**: `apps/api`'s `/openapi.json` is not just its own spec — it fetches
  each internal module's `/openapi.json` over its service binding and merges paths/
  components under a prefix (e.g. `/landing/*`). An unreachable module is silently
  skipped rather than breaking the whole document. See `apps/api/src/openapi.ts`.
- This repo uses `dev` as its default/main branch — never target `main`/`master`.
- `apps/landing/.dev.vars` holds the `GH_TOKEN` secret for local dev and must never be
  committed (already gitignored).
