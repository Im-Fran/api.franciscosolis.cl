# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

Root pnpm monorepo for the public REST API behind **franciscosolis.cl**. It doesn't
contain business logic itself — it wires together two Cloudflare Workers:

- `apps/api` (git submodule) — public gateway Worker, deployed to `api.franciscosolis.cl`.
- `apps/landing` (git submodule) — internal Worker with the landing page's GitHub stats,
  only reachable from `apps/api` via a Cloudflare service binding, never public directly.

Each submodule is its own git repo with its own `CLAUDE.md`, `README.md`, and history.
When working on the actual implementation of a Worker, read/edit inside `apps/api` or
`apps/landing` — this root repo only owns workspace wiring (pnpm workspace/catalog, root
scripts, submodule pointers).

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
- **Submodules use HTTPS, not SSH**, in `.gitmodules`, so Cloudflare's build environment
  can clone them without extra credentials. Do not switch these back to SSH URLs.
- All three repos (root + both submodules) use `dev` as their default/main branch — never
  target `main`/`master`.

## Working with submodules

- Changes to `apps/api` or `apps/landing` source must be committed inside those
  submodules first (their own git repo), then the root repo's submodule pointer is
  updated separately if needed.
- `apps/landing/.dev.vars` holds the `GH_TOKEN` secret for local dev and must never be
  committed (already gitignored).
