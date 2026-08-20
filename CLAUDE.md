# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

Single pnpm monorepo for the public REST API behind **franciscosolis.cl**. It wires
together four Cloudflare Workers, all living directly in this repo:

- `apps/api` — public gateway Worker, deployed to `api.franciscosolis.cl`.
- `apps/landing` — internal Worker with the landing page's GitHub stats, only reachable
  from `apps/api` via a Cloudflare service binding, never public directly.
- `apps/auth` — internal Worker with centralized authentication: a full OAuth 2.0 + OpenID
  Connect provider (authorization code + PKCE, rotatable client secrets, magic link and Google
  providers, D1-backed users/roles/permissions), also reachable only through `apps/api`, at
  `/auth/*`.
- `apps/cms` — internal Worker with the CMS behind the landing page (content collections,
  legal pages, outgoing email), reachable through `apps/api` at `/cms/*`. Public reads of
  published content, editorial writes gated to `@franciscosolis.cl` accounts.

Alongside them, `packages/` holds the shared code the Workers import:

- `packages/emails` (`@franciscosolis/emails`) — every email body in the monorepo, written as
  react-email components. Imported by `apps/auth` and `apps/cms`; no Worker builds mail markup
  itself.

Each app and package keeps its own `CLAUDE.md` and `README.md`. When working on the actual
implementation of a Worker, read/edit inside `apps/api`, `apps/landing`, `apps/auth` or
`apps/cms` — the root repo only owns workspace-wide wiring (pnpm workspace/catalog, root
scripts).

## Stack

- pnpm workspaces (`pnpm@11.17.0`, see `packageManager` in `package.json`), packages
  glob'd from `apps/*` and `packages/*` (`pnpm-workspace.yaml`).
- Every Worker uses Hono + hono-openapi + valibot + axios + Wrangler, all pinned via a
  shared pnpm `catalog` in `pnpm-workspace.yaml` — do not add per-app version pins for
  those deps, add/bump them in the catalog instead. `apps/auth` and `apps/cms` additionally
  use drizzle-orm/drizzle-kit, and react + react-email through `@franciscosolis/emails`, all
  catalogued too.
- Cloudflare Workers runtime (`nodejs_compat`), no separate build step; Wrangler bundles
  on `dev`/`deploy`.
- Vitest running inside `workerd` via `@cloudflare/vitest-pool-workers`, also catalogued.

## Commands (run from repo root)

- `pnpm install` — installs for the whole workspace.
- `pnpm run dev` — runs `dev` in every workspace app in parallel (`api` on :8787,
  `landing` on :8788, `auth` on :8789, `cms` on :8790).
- `pnpm run test` / `pnpm run test:coverage` — runs every app's suite.
- `pnpm run typecheck` — `tsc --noEmit` over `src/` and `test/` in every app.
- `pnpm run build` — `wrangler deploy --dry-run` in every app. Not an artifact; it is the
  check that each `wrangler.jsonc` is valid and each Worker still bundles.
- `pnpm run deploy` — deploys every workspace app.
- `pnpm run cf-typegen` — regenerates Cloudflare binding types (`CloudflareBindings`) in
  every app after a `wrangler.jsonc` change.

- `pnpm --filter @franciscosolis/emails run preview` — react-email preview server on :8791.

Individual apps can also be run from their own directory (`cd apps/api && pnpm run dev`).

`packages/emails` has no `dev`/`build`/`deploy`/`test` script, so the root `-r` scripts skip it —
it ships TypeScript source that each Worker bundles, and its rendering is covered by the `auth` and
`cms` suites, which run inside `workerd`.

## Testing

Each app owns its suite under `apps/<app>/test/`, split into `unit/` (a module in isolation)
and `functional/` (a request through the Worker via `SELF`). Config lives in each app's
`vitest.config.ts`.

Non-obvious things about this harness, learned the hard way — do not re-derive them:

- The pinned `@cloudflare/vitest-pool-workers` (0.19.x, for Vitest 4) has **no
  `/config` entrypoint and no `defineWorkersConfig`**. Configuration goes through the
  `cloudflareTest()` Vite plugin inside a plain `defineConfig` from `vitest/config`.
- It also exports **no `fetchMock`**. Control outbound HTTP with `vi.mock('axios', …)` or
  `vi.stubGlobal('fetch', …)`. A module mock does reach the Worker behind `SELF`, because
  that Worker shares the test's isolate.
- The `@/*` alias must be restated as a Vite `resolve.alias`; Wrangler reads it from
  tsconfig when bundling, but Vite does not.
- Coverage must use the **istanbul** provider — `workerd` exposes no V8 coverage hooks.
- `apps/auth` and `apps/cms` apply their real `migrations/` directory to each test file's
  isolated D1 instance (`readD1Migrations` in the config, `applyD1Migrations` in
  `test/setup.ts`), so a migration that no longer applies cleanly fails the test run.
- `apps/api` boots the three internal Workers as auxiliary Miniflare Workers
  (`apps/api/test/stubs.ts`), so `LANDING`/`AUTH`/`CMS` are real service bindings in tests.
- `apps/auth` gets a fixed, committed, test-only Ed25519 signing key from its
  `vitest.config.ts`. It signs nothing outside the suite; the production key stays a secret.

## CI

`.github/workflows/ci.yml` runs one job per app (`fail-fast: false`), so every Worker is an
independent check and a break in one does not mask the others. Each job typechecks, runs the
suite with coverage, and does a credential-free `wrangler deploy --dry-run`. An aggregate `ci`
job is the single status branch protection should require. When adding an app, add it to the
`matrix.app` list.

## Versioning

Every app carries its own `version` in `apps/<app>/package.json`, following MAJOR.MINOR.PATCH.
That string identifies the bundle Wrangler deploys, so an app that changed on a branch must never
ship under the same version as the branch it forked from.

`.claude/hooks/version-bump.mjs` automates this, wired up in `.claude/settings.json`:

- `bump` runs after every file edit and bumps each app that changed since `origin/dev`.
- `commit` runs before `git commit` and stages the bumped `package.json` files so the bump travels
  in that commit.
- `verify` runs before a pull request is opened and blocks it, listing any app that changed without
  a bump.

The level comes from the branch's Conventional Commit subjects for that app — `feat!:` or
`BREAKING CHANGE` → major, `feat:` → minor, anything else → patch. `CLAUDE_VERSION_BUMP` overrides
it. All modes are idempotent: once a branch carries a bump for an app, later edits only ever *raise*
the level (patch → minor when a `feat:` lands), never bump again and never downgrade. An app with no
`package.json` at the base ref is left alone — a new app's version is deliberate.

Run it by hand with `node .claude/hooks/version-bump.mjs bump`.

## Architecture notes (non-obvious)

- **Service binding, not HTTP**: `apps/api` talks to the internal Workers through Cloudflare
  service bindings (`LANDING` and `AUTH` in `apps/api/wrangler.jsonc`), not public HTTP
  calls. These only resolve when each Worker is deployed under the exact name configured
  (the Worker's `name` must match the `service` field of the binding).
- **Merged OpenAPI**: `apps/api`'s `/openapi.json` is not just its own spec — it fetches
  each internal module's `/openapi.json` over its service binding and merges paths/
  components under a prefix (e.g. `/landing/*`). An unreachable module is silently
  skipped rather than breaking the whole document. See `apps/api/src/openapi.ts`.
- **Two stateful Workers**: `apps/auth` owns the `franciscosolis_auth` D1 database and
  `apps/cms` owns `franciscosolis_cms`; both use Drizzle and Wrangler-applied migrations.
  `auth` issues EdDSA-signed JWTs that any other Worker can verify offline against
  `https://api.franciscosolis.cl/auth/.well-known/jwks.json` — never add a service binding
  back into `auth` just to validate a token. It is also an OpenID Connect provider, so an
  off-the-shelf relying party (Cloudflare Access included) can be pointed at
  `/auth/.well-known/openid-configuration` and needs nothing written for it. `apps/cms` is the reference for how to consume
  them (`src/lib/jwks.ts`).
- **The CMS content model is a registry, not a table per type**: every collection lives in
  one `content_entries` table discriminated by `collection`, with collection-specific fields
  validated by `apps/cms/src/lib/collections.ts`. Adding a collection is a registry entry,
  not a migration.
- **Email bodies are react-email components, in one shared package**: neither Worker builds
  mail markup any more. `@franciscosolis/emails` renders `{ subject, html, text }` and the
  Worker only hands that to its `EMAIL` binding. Three consequences worth knowing before
  touching either: rendering is asynchronous; both Workers alias `prettier/standalone`
  and `prettier/plugins/html` out of their bundle (in `wrangler.jsonc` *and* in
  `vitest.config.ts`) because `@react-email/render` imports ~1.5 MB of formatter statically
  for an option neither uses; and the layout is deliberately light-first — a dark email body
  is what mail clients' colour rewriting breaks worst, and the palette, the `bgcolor`
  attributes and the missing `<style>` block are all defending against a specific client.
  See `packages/emails/CLAUDE.md` before changing any of them.
- **The email layout reaches back into `apps/api`**: `EmailLayout` renders the brand lockup
  from `https://api.franciscosolis.cl/brand/lockup.png`, which `apps/api/src/brand.ts` serves.
  An email cannot carry a logo any other way — Gmail blocks `data:` URIs and strips inline
  SVG — and the gateway owns the only public hostname in the repo. Renaming that path breaks
  the logo in every inbox already delivered, so `theme.logo.src` and the route move together.
- **Nothing in this repo renders HTML.** `api.franciscosolis.cl` is a backend end to end: every
  Worker answers JSON, a redirect or a binary asset (`apps/api/src/brand.ts`), and nothing else.
  The one place that used to break the rule was `apps/auth`'s built-in sign-in screen; it is gone,
  and `GET /oauth/authorize` now redirects to the sign-in front-end at
  `https://franciscosolis.cl/apps/auth` instead. Email bodies are the only markup here, and they
  are rendered by `packages/emails` for a mail client, not served to a browser.
- **The gateway's CORS allows write verbs because of auth**: `apps/api` used to allow `GET`
  only; sign-in, token exchange and the admin API need `POST`/`PATCH`/`DELETE`. The origin
  allowlist was not touched and must stay locked down — but `/auth/*` is now excluded from it
  entirely (`ownsCors` in `apps/api/src/services.ts`), because `apps/auth` signs in applications
  on domains the gateway cannot enumerate and answers CORS from its own list of registered
  clients instead.
- This repo uses `dev` as its default/main branch — never target `main`/`master`.
- `apps/landing/.dev.vars` holds the `GH_TOKEN` secret for local dev, and
  `apps/auth/.dev.vars` holds `JWT_PRIVATE_KEY` and the Google OAuth client. Neither must
  ever be committed (both already gitignored). `apps/cms` has no secrets at all — its
  `.dev.vars` only repoints `AUTH_JWKS_URL`/`AUTH_ISSUER` at a local auth Worker.
