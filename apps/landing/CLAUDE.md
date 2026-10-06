# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`landing` is the internal Cloudflare Worker behind the **franciscosolis.cl** landing
page. It is not exposed to the public internet directly: the root gateway Worker
(`apps/api` in the `api.franciscosolis.cl` monorepo) reaches it through a Cloudflare
**service binding** and proxies `/landing/*` to it. It lives at `apps/landing` inside
that monorepo.

It does two things: fetching live GitHub stats (commits, stars, profile) for the `Im-Fran`
account via the GitHub REST/GraphQL APIs, and serving Chilean economic indicators (observed
US dollar, UF, UTM) from the Banco Central de Chile API. Both are exposed as JSON.

## Stack

- Cloudflare Workers, Hono, hono-openapi, valibot, axios (GitHub) and `fetch` (Banco Central
  de Chile), Wrangler, TypeScript.
- Dependency versions come from the parent workspace's pnpm `catalog` (see the parent
  monorepo's `pnpm-workspace.yaml`) — use `catalog:` in `package.json`, don't hardcode.
- `pnpm` install/deps are managed from the **monorepo root**, not from inside this dir.

## Commands (run from this directory, `apps/landing/`)

- `pnpm run dev` → `wrangler dev --ip 0.0.0.0 --port 8788 --inspector-port 9230`
- `pnpm run deploy` → `wrangler deploy --minify`
- `pnpm run cf-typegen` → `wrangler types --env-interface CloudflareBindings` — run after
  editing `wrangler.jsonc` so `Hono<{ Bindings: Env }>` (`src/env.ts`) stays in sync.

No separate `build` script — Wrangler bundles as part of `dev`/`deploy`.

## Environment

- `.dev.vars` (gitignored, copy from `.dev.vars.example`) holds `GH_TOKEN`, the GitHub
  token used to call the REST/GraphQL APIs for the `Im-Fran` account's stats, and
  `BCCH_API_TOKEN`, the Banco Central de Chile API token behind `/indicators`. Never
  commit real tokens. Both are set per environment in production (`wrangler secret put`,
  plus `--env dev` for the development Worker).

## Source layout

- `src/index.ts` — Hono app: CORS/charset middleware, `onError`, health check (`GET /`).
- `src/stats/index.ts` — mounts the stats sub-routes.
- `src/stats/github/` — one file per GitHub stats concern: `commits.ts`, `profile.ts`,
  `stars.ts`, `pull-requests.ts`, `headers.ts` (shared auth headers), `index.ts` (route
  list at `/stats/github`).
- `src/indicators/` — the economic indicators: `registry.ts` (the three series and their
  frequencies), `bcentral.ts` (the Banco Central de Chile client), `dates.ts` (Santiago-day
  date helpers), `index.ts` (`GET /indicators` and `GET /indicators/:indicator`).
- `src/env.ts` — `Env` type declaring bindings/secrets (`GH_TOKEN`, `BCCH_API_TOKEN`).

## Architecture notes (non-obvious)

- **Every route is described with `describeRoute` + a valibot schema**, and the OpenAPI
  document at `/openapi.json` is generated from those schemas via `hono-openapi` — there
  is no hand-written spec. When adding/changing a route, update the schema, not a
  separate spec file, or the two will drift.
- **This spec gets consumed remotely**: the root `api` Worker fetches this Worker's
  `/openapi.json` over the `LANDING` service binding and merges it under the `/landing/*`
  prefix in its own combined spec (`mergeRemoteSpecs` in `apps/api/src/openapi.ts`).
  Breaking changes to route shapes here ripple into that merged doc.
- **Star counting paginates GraphQL**: `getGitHubStars` walks every repo the user owns
  via the GitHub GraphQL API and sums `stargazers.totalCount` — it's not a single REST
  call, keep pagination handling if you touch this.
- **JSON charset middleware**: a shared middleware appends `; charset=UTF-8` to
  `application/json` responses because Hono's `c.json()` doesn't set one by default —
  don't remove it, it prevents non-ASCII responses being mangled by Latin-1-defaulting
  clients.
- **Error shape**: `onError` normalizes both `HTTPException` and unexpected errors into
  `{ code, error }` with the matching HTTP status — keep new error paths consistent.
- **Economic indicators are a registry** (`src/indicators/registry.ts`): an indicator is a
  public key (`dollar`, `uf`, `utm`), a Banco Central de Chile series id and a frequency, and
  the frequency decides the lookback for the latest value, the default history window and the
  longest range a request may ask for (366 days daily, 3660 monthly — the bank's series go back
  to the 1970s, and nothing should pull all of it per page view). Adding one is a registry
  entry plus its key in the `/indicators` response schema.
- **The Banco Central de Chile API fails in-band**: a bad token or series answers HTTP 200
  with a non-zero `Codigo`, and a day without a value (a weekend in the dollar) is listed as
  `"NaN"` with status `"ND"`. `bcentral.ts` turns the first into a 502 and drops the second,
  so a caller only ever sees real numbers. The token travels in the query string, so it never
  goes into an error message and the request URL is never logged.
- **"Today" is a day in Santiago, and the latest value's range ends on it**: the UF is published
  weeks ahead, so the latest UF without an upper bound would be a future value. The history
  route deliberately lets `to` go past today, which is how a caller asks for upcoming UF values. Late in the evening
  in Chile the UTC date is already tomorrow, which is why `dates.ts` formats with
  `America/Santiago` rather than slicing an ISO timestamp.
- **The indicator client uses `fetch`, not axios**, because it passes `cf.cacheTtl` so the edge
  reuses an upstream answer for an hour; tests stub it with `vi.stubGlobal('fetch', …)`
  (`test/helpers/bcentral.ts`). The `/indicators` responses also carry
  `Cache-Control: public, max-age=1800`; errors carry none.
- **No public route in production**: this Worker only needs to be deployed under the
  exact name `landing` (see `wrangler.jsonc`, `name: "landing"`) for the parent `api`
  Worker's `LANDING` service binding to resolve; it doesn't need a custom domain.
