# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`api` is the public gateway Worker for the `api.franciscosolis.cl` monorepo, deployed on
the `api.franciscosolis.cl` domain. It has no business logic of its own beyond a status
endpoint — it forwards requests to internal Workers over Cloudflare service bindings and
merges their OpenAPI specs into one combined document. It lives at `apps/api` inside the
`api.franciscosolis.cl` monorepo.

Currently the only internal component wired up is `landing` (the sibling `apps/landing`
Worker in the parent monorepo).

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + `@valibot/to-json-schema` for the OpenAPI
  doc, valibot for schemas, Wrangler 4, TypeScript strict (ESNext).
- Dependency versions come from the parent workspace's pnpm `catalog` — don't hardcode
  versions in this app's `package.json`, use `catalog:`.
- `pnpm` install/deps are managed from the **monorepo root**, not from inside this dir.

## Commands (run from this directory, `apps/api/`)

- `pnpm dev` → `wrangler dev --ip 0.0.0.0 --port 8787 --inspector-port 9229`
- `pnpm deploy` → `wrangler deploy --minify`
- `pnpm cf-typegen` → `wrangler types --env-interface CloudflareBindings` — run this after
  editing `wrangler.jsonc` bindings so `Hono<{ Bindings: Env }>` in `src/env.ts` stays in
  sync.

There is no separate `build` script — Wrangler bundles as part of `dev`/`deploy`.

## Source layout

- `src/index.ts` — Hono app: CORS, charset middleware, `onError`, status route (`GET /`),
  the `/landing/*` proxy, and the `/openapi.json` route.
- `src/openapi.ts` — `mergeRemoteSpecs`: fetches each internal module's `/openapi.json`
  over its service binding and merges it under a route prefix.
- `src/env.ts` — `Env` type declaring the Cloudflare bindings (`LANDING` service binding).

## Architecture notes (non-obvious)

- **Proxy pattern**: `ALL /landing/*` forwards the request to the `LANDING` binding's
  `Fetcher`, stripping the `/landing` prefix before forwarding. Follow this exact pattern
  (strip prefix, forward via binding `.fetch()`) when adding a new proxied module.
- **OpenAPI merge is best-effort**: if an internal module's `/openapi.json` fetch fails,
  `mergeRemoteSpecs` skips it silently instead of throwing — the combined spec should
  never 500 just because one internal Worker is down.
- **CORS is locked down**: only `GET` from `localhost:5173`, `*.franciscosolis.workers.dev`,
  and `*.franciscosolis.cl`; any other origin falls back to the `https://franciscosolis.cl`
  response. Don't loosen this without being asked.
- **JSON charset middleware**: Hono's `c.json()` doesn't set a charset by default, which
  can mangle non-ASCII responses on clients that assume Latin-1. A shared middleware
  appends `; charset=UTF-8` to `application/json` responses — see the `ponytail` comment
  in `src/index.ts` for why this exists. Don't remove it.
- **Error shape**: `app.onError` normalizes both `HTTPException` and unexpected errors
  into `{ code, error }` with the matching HTTP status — keep new error paths consistent
  with this shape.
- **Adding a new internal module** (see README for full steps): add the service binding
  in `wrangler.jsonc`, declare it in `src/env.ts`, add an `app.all('/<module>/*', ...)`
  proxy route mirroring `/landing/*`, then register it in the `modules` list (`GET /`)
  and in `mergeRemoteSpecs` (`GET /openapi.json`).
- **No `.env` files here** — all infra config lives in `wrangler.jsonc` (bindings,
  custom domain, observability) and is resolved by Cloudflare at deploy time.
- The `LANDING` binding only resolves in production if a Worker literally named `landing`
  is deployed in the same Cloudflare account.
