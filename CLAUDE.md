# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

Single pnpm monorepo for the public REST API behind **franciscosolis.cl**. It wires
together six Cloudflare Workers, all living directly in this repo:

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
- `apps/pages` — internal Worker with **Standalone App Pages**: one product page per application
  built here, all to the same house standard (a banner, then Overview / Updates / Wiki / Contact
  tabs), reachable through `apps/api` at `/pages/*`. Same public-read, gated-write split as the CMS,
  and edited from the CMS front-end rather than from an application of its own. It is also the one
  Worker here that **takes money**: an application can be paid for or donated to through MercadoPago
  Checkout Pro, and its downloadable builds live in R2 and are served by the Worker against a signed
  per-request ticket rather than from a bucket URL.
- `apps/support` — internal Worker with the **support ticket system** and the help centre behind it,
  reachable through `apps/api` at `/support/*`. A ticket can be opened from the website or by writing
  to `soporte@franciscosolis.cl`, and answered in either place; the help centre is searched both
  lexically (FTS5) and semantically (Workers AI + Vectorize). It is the one Worker here with entry
  points the gateway does not front, and the only one that uses Vectorize.

Alongside them, `packages/` holds the shared code the Workers import:

- `packages/emails` (`@franciscosolis/emails`) — every email body in the monorepo, written as
  react-email components. Imported by `apps/auth`, `apps/cms` and `apps/support`; no Worker builds
  mail markup itself.
- `packages/translate` (`@franciscosolis/translate`) — the one prompt behind every machine
  translation here, and the parsing of the model's answer. Imported by `apps/cms`, `apps/pages` and
  `apps/support`; no Worker writes a translation prompt itself.

Each app and package keeps its own `CLAUDE.md` and `README.md`. When working on the actual
implementation of a Worker, read/edit inside `apps/api`, `apps/landing`, `apps/auth`, `apps/cms`,
`apps/pages` or `apps/support` — the root repo only owns workspace-wide wiring (pnpm
workspace/catalog, root scripts).

## Stack

- pnpm workspaces (`pnpm@11.17.0`, see `packageManager` in `package.json`), packages
  glob'd from `apps/*` and `packages/*` (`pnpm-workspace.yaml`).
- Every Worker uses Hono + hono-openapi + valibot + Wrangler, all pinned via a
  shared pnpm `catalog` in `pnpm-workspace.yaml` — do not add per-app version pins for
  those deps, add/bump them in the catalog instead. `apps/auth`, `apps/cms`, `apps/pages` and
  `apps/support` additionally use drizzle-orm/drizzle-kit; `apps/auth`, `apps/cms` and `apps/support`
  also pull react + react-email through `@franciscosolis/emails`, all catalogued too. `apps/cms`,
  `apps/pages` and `apps/support` use **Workers AI** through `@franciscosolis/translate`;
  `apps/support` is the only one with `postal-mime`, and the only one using Vectorize. `apps/pages`
  talks to MercadoPago over plain `fetch` rather than through an SDK — three functions in
  `src/lib/mercadopago.ts` against a dependency that assumes Node.
- Cloudflare Workers runtime (`nodejs_compat`), no separate build step; Wrangler bundles
  on `dev`/`deploy`.
- Vitest running inside `workerd` via `@cloudflare/vitest-pool-workers`, also catalogued.

## Commands (run from repo root)

- `pnpm install` — installs for the whole workspace.
- `pnpm run dev` — runs `dev` in every workspace app in parallel (`api` on :8787,
  `landing` on :8788, `auth` on :8789, `cms` on :8790, `pages` on :8792, `support` on :8793).
- `pnpm run test` / `pnpm run test:coverage` — runs every app's suite.
- `pnpm run typecheck` — `tsc --noEmit` over `src/` and `test/` in every app.
- `pnpm run build` — `wrangler deploy --dry-run` in every app. Not an artifact; it is the
  check that each `wrangler.jsonc` is valid and each Worker still bundles.
- `pnpm run deploy` — deploys every workspace app.
- `pnpm run build:dev` / `deploy:dev` / `db:migrate:remote:dev` / `db:migrate:list:dev` /
  `db:migrate:local:dev` — the same against the **development stack** (see *Environments*). Every
  one of them is `--env dev` underneath.
- `node scripts/check-environments.mjs` — asserts each app's `env.dev` still mirrors its
  production config. CI runs it as the `environments` job.
- `pnpm run cf-typegen` — regenerates Cloudflare binding types (`CloudflareBindings`) in
  every app after a `wrangler.jsonc` change.
- `pnpm run db:migrate:list` / `db:migrate:remote` / `db:migrate:local` — D1 migrations across
  every app that owns a database (`auth`, `cms`, `pages`, `support`). Production runs happen in CI
  (see *Deploys and migrations*); these are for local work and for repairing a database that has
  drifted.

- `pnpm --filter @franciscosolis/emails run preview` — react-email preview server on :8791.

Individual apps can also be run from their own directory (`cd apps/api && pnpm run dev`).

Neither `packages/emails` nor `packages/translate` has a `dev`/`build`/`deploy`/`test` script, so
the root `-r` scripts skip both — they ship TypeScript source that each Worker bundles, and their
behaviour is covered by the consuming suites, which run inside `workerd`: email rendering by `auth`
and `cms`, the translation prompt by `apps/cms/test/unit/translate.test.ts`.

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
- `apps/auth`, `apps/cms`, `apps/pages` and `apps/support` apply their real `migrations/` directory
  to each test file's isolated D1 instance (`readD1Migrations` in the config, `applyD1Migrations` in
  `test/setup.ts`), so a migration that no longer applies cleanly fails the test run.
- `apps/api` boots the internal Workers as auxiliary Miniflare Workers
  (`apps/api/test/stubs.ts`), so `LANDING`/`AUTH`/`CMS`/`PAGES`/`SUPPORT` are real service bindings
  in tests.
- **`apps/cms`, `apps/pages` and `apps/support` run against a named `test` environment in their own
  `wrangler.jsonc`**, and that is not stylistic. The pool answers an `ai` or `vectorize` binding by
  opening a *remote proxy session* against the real Cloudflare account, which needs a
  `CLOUDFLARE_API_TOKEN` CI does not have and bills real neurons for a unit test. Each named
  environment restates everything except those bindings, and each suite supplies them by assignment
  from its own `test/helpers/ai.ts`, with loud defaults so a path that reaches the real service
  unexpectedly says so instead of returning `undefined`. In `apps/support`, Miniflare also cannot
  dispatch an email event, so that Worker's `email()` handler is called directly rather than through
  `SELF`.
- `apps/auth` gets a fixed, committed, test-only Ed25519 signing key from its
  `vitest.config.ts`. It signs nothing outside the suite; the production key stays a secret.

## CI

`.github/workflows/ci.yml` runs one job per app (`fail-fast: false`), so every Worker is an
independent check and a break in one does not mask the others. Each job typechecks, runs the
suite with coverage, and does a credential-free `wrangler deploy --dry-run`. Each job also does a second dry-run against `--env dev`, because a named environment is a second
config that nothing else would ever load. Alongside them an `environments` job runs
`scripts/check-environments.mjs`. An aggregate `ci` job is the single status branch protection
should require. When adding an app, add it to the `matrix.app` list.

## Environments

Two full stacks, sharing nothing but the code: production (`api`, `landing`, `auth`, `cms`,
`pages`, `support`) and development (the same six with a `-dev` suffix, fronted by
`api-dev.franciscosolis.cl` and paired with `dev.franciscosolis.cl` in the front-end repository).
Each stateful Worker has its own `_dev` database, each bucket its own `-dev` copy, and `apps/auth`
its own signing key — so a dev token is structurally unusable in production and a test payment
cannot reach a real build.

The suffix is not typed anywhere. Each app declares a named Wrangler environment called `dev`, and
Wrangler appends the environment name to the Worker name.

Four things about this are worth not re-deriving:

- **A named environment inherits no bindings and no vars**, so every one of them is written twice
  per `wrangler.jsonc`. That is the documented cost, and `scripts/check-environments.mjs` is what
  keeps the two halves from drifting: same bindings, same var keys, different resources, no
  production host left in a dev var. Adding a var for production and not for dev fails CI.
  The converse also bites: `alias` *is* inherited and Wrangler refuses it inside an environment, so
  restating it buys a warning on every deploy and nothing else. The same check now fails on that.
- **`routes` is inherited**, which is the sharpest edge in the whole arrangement: an app with a
  production route and no override under `env.dev` deploys its development Worker onto the
  production hostname. `apps/api` overrides it, the front-end repository overrides it, and the
  check above fails anything that does not.
- **Service bindings resolve by Worker name**, so `env.dev` in `apps/api` names `landing-dev`,
  `auth-dev` and so on. Leaving one as `landing` would wire the development gateway into a
  production module without any error to say so — which is the single failure this environment
  exists to make impossible. The same bindings also **dictate the deploy order**, because one is
  resolved at deploy time against a Worker that must already exist: `auth` first, then the modules
  that bind it (`cms`, `pages`, `support`), then `api`. Out of order, a first deploy fails with
  "Service binding 'AUTH' references Worker 'auth-dev' which was not found".
- **Secrets are per environment.** `wrangler secret put --env dev` is a different store, and that
  is deliberate rather than a chore: `apps/pages` takes a MercadoPago *test* credential on dev, and
  `apps/auth` a signing key of its own.

`.github/workflows/deploy-dev.yml` deploys the stack on a push to `dev`, in four stages that follow
the binding graph above: migrations, `auth-dev`, the four remaining modules in parallel, then
`api-dev`. Unlike production (below), the migrations there are strictly ordered before the deploy.
Its token needs `Workers R2 Storage:Edit` on top of `D1:Edit` and `Workers Scripts:Edit` — `auth`
and `pages` each bind a bucket, and a deploy that cannot read one fails with an authentication
error rather than anything that mentions R2 permissions.

Three pieces of setup live outside this repository and are listed in the README: the per-environment
secrets, the `franciscosolis-support-help-dev` Vectorize index, and the OAuth client applications,
which are rows in the *dev* auth database and therefore do not exist until they are registered
(`pnpm run applications -- … --dev --remote`). One piece is deliberately missing: nothing delivers
mail to `apps/support`'s dev inbox addresses, so the development Worker sends and never receives
until an Email Routing rule is added. Pointing it at the production inbox instead would make a reply
to a test email open a real ticket.

Today `dev` is the default branch and a push to it releases *both* stacks. When the `prd` branch
arrives, production moves behind it as a dashboard change and nothing here moves with it —
`deploy-dev.yml` already watches `dev` and only `dev`.

## Deploys and migrations

The **production** Workers are deployed by **Cloudflare's Git integration**, not from this repo —
that is what the "Workers Builds" checks on a PR are. Nothing here configures it, and no workflow
should duplicate it. The development stack is the half that *can* live in git, and does:
`.github/workflows/deploy-dev.yml` owns it, because that integration runs a plain `wrangler deploy`
with no way to pass `--env dev`.

What that integration does not do is touch D1, so `.github/workflows/migrate.yml` owns that:
it applies pending migrations for the stateful Workers (`auth`, `cms`, `pages`, `support`) on a push to `dev`
that touches `apps/*/migrations/**`, one job per database, plus a bare `workflow_dispatch` for a
manual run. It needs the `CLOUDFLARE_API_TOKEN` (D1:Edit) and `CLOUDFLARE_ACCOUNT_ID` repository
secrets. Adding another stateful app means adding it to that matrix. The dispatch deliberately takes no
"which database" input: applying is idempotent, so picking one buys nothing, and selecting per app
would mean building the matrix dynamically — the `matrix` context is not available in a job-level
`if`, which is the shape that silently selects no jobs at all.

Three things about it are worth not re-deriving:

- **Wrangler is what makes it safe to automate.** In a non-interactive shell it skips its
  confirmation prompt but still captures a backup first, and a migration that errors is rolled back
  with the previous one left applied — so a failed run is re-runnable rather than a half-migrated
  database.
- **The migration and the deploy race**, because Cloudflare starts its build from the same push.
  That is tolerable only because of how these Workers fail on a schema that is behind: Drizzle emits
  an explicit column list, SQLite reads a double-quoted unknown column as a *string literal* rather
  than erroring, and the JSON parsers here (`parseJson`, `parseTranslations`) fall back on the
  garbage — so a public read degrades to the pre-migration shape instead of 500-ing. A write does
  error, because that fallback does not apply to a column list or a `SET` clause. Net effect: the
  editorial API is down for the length of the migration, the public site is not.
- **Strict ordering is available and deliberately not used**: pointing Cloudflare's *build command*
  at `pnpm run db:migrate:remote` would sequence it before that Worker's deploy, but it is dashboard
  configuration this repo cannot hold or review. The workflow is the version that lives in git.

`pnpm run db:migrate:remote` / `db:migrate:list` / `db:migrate:local` at the root fan out to every
app that declares them, which is exactly `auth`, `cms`, `pages` and `support` — `pnpm run -r` skips
the rest, and runs them sequentially rather than in parallel, which is what migrations want.

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
  service bindings (`LANDING`, `AUTH`, `CMS`, `PAGES` and `SUPPORT` in `apps/api/wrangler.jsonc`),
  not public HTTP calls. These only resolve when each Worker is deployed under the exact name configured
  (the Worker's `name` must match the `service` field of the binding).
- **Merged OpenAPI**: `apps/api`'s `/openapi.json` is not just its own spec — it fetches
  each internal module's `/openapi.json` over its service binding and merges paths/
  components under a prefix (e.g. `/landing/*`). An unreachable module is silently
  skipped rather than breaking the whole document. See `apps/api/src/openapi.ts`.
- **Four stateful Workers**: `apps/auth` owns the `franciscosolis_auth` D1 database, `apps/cms`
  owns `franciscosolis_cms`, `apps/pages` owns `franciscosolis_pages` and `apps/support` owns
  `franciscosolis_support`; all four use Drizzle and Wrangler-applied migrations.
  `auth` issues EdDSA-signed JWTs that any other Worker can verify offline against
  `https://api.franciscosolis.cl/auth/.well-known/jwks.json` — never add a service binding
  back into `auth` just to validate a token. It is also an OpenID Connect provider, so an
  off-the-shelf relying party (Cloudflare Access included) can be pointed at
  `/auth/.well-known/openid-configuration` and needs nothing written for it. `apps/cms` is the reference for how to consume
  them (`src/lib/jwks.ts`).
- **A standalone app page is a registry of tabs, not a per-page layout** (`apps/pages/src/lib/tabs.ts`):
  an application picks a subset of Overview / Updates / Wiki / Contact, in an order, and nothing else
  about its shape is configurable. That is the whole point of the Worker — the moment a page can
  describe its own layout, the set of pages stops being a house standard. `apps/pages` is also the
  one Worker here whose schema uses foreign keys: a release note or a wiki page only means anything
  as part of one application — with the payment and download tables as the deliberate exception, since
  a financial record has to outlive the page it was made for. It has **no client application of its
  own** — its editor is a section of the CMS front-end, so `PAGES_ALLOWED_AUDIENCES` names the CMS's
  client id and there is nothing extra to register in the auth database. It does carry a second
  audience list (`PAGES_ACCOUNT_AUDIENCES`, the website's client id), the way `apps/support` does, for
  somebody buying rather than editing.
- **Money is `apps/pages`' business and nothing else's** (`apps/pages/src/lib/pricing.ts`). Three
  pricing modes, `free` / `donation` / `paid`, and no tiers, regions or subscriptions — the same
  house-standard reasoning as the tab registry. Four things about it are worth not re-deriving, and
  `apps/pages/CLAUDE.md` has the rest: a download is a **Worker route** because a presigned R2 URL
  cannot be asked whether the holder paid; the five-second cooldown for a non-payer is `nbf` on a
  signed ticket rather than a timer on the page; the MercadoPago webhook verifies a signature and then
  **reads the resource back from the provider**, because the notification body is not evidence; and an
  approved payment *is* the entitlement, so a refund is one status change rather than two writes that
  have to agree. It reads *both* generations of the provider's notifications — the classic `payment`
  topic and the orders API's `order` topic, plus `topic_chargebacks_wh` for disputes — keyed on the
  payment id so the same money arriving down two channels is applied once. Buying requires signing in first — that is what ties a payment to an SSO account, and
  it is also why no service binding back into `auth` was needed to create one.
- **The CMS content model is a registry, not a table per type**: every collection lives in
  one `content_entries` table discriminated by `collection`, with collection-specific fields
  validated by `apps/cms/src/lib/collections.ts`. Adding a collection is a registry entry,
  not a migration.
- **A translation is drafted by Workers AI and written by a person.** All three translating Workers
  expose `POST /admin/translate`, which takes one field's text and one target locale and answers with
  a draft — and **writes nothing**. The draft is saved, edited or discarded through the ordinary
  PATCH that saves every other override. Four things follow and every one of them is the reason it is
  shaped this way: a model outage cannot corrupt a record, because the route touches no table;
  nothing machine-translated is published without somebody having read it, because publishing is a
  separate request a human makes; there is no "translated by AI" flag to keep in sync, because by the
  time the text is stored it is simply what the editor wrote; and a failed, timed-out or unreadable
  answer is a `200` with `translation: null`, so an outage costs a button that did nothing. The
  prompt is `packages/translate`; the meter, the hourly per-editor limit and the gate are each
  Worker's own. See `packages/translate/CLAUDE.md`.
- **The CMS is bilingual by override, not by row**: the row holds the default locale (`en`) and
  a `translations` column holds `{"es":{"title":"…"}}` for the rest. Public reads take `?locale`
  and resolve it server-side, so the website reads plain `title`/`body` fields and gets a `locale`
  telling it which language actually came back. Only prose is translated — slugs, ordering, dates
  and the `data` blob are the same fact in every language. See `apps/cms/src/lib/locales.ts`.
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
- **`apps/auth` owns an R2 bucket too, and moderation is what the bucket is for**: uploaded avatars
  go into `AVATARS` (`franciscosolis-avatars`) with no public access of their own, and
  `GET /auth/avatars/:id` serves one only once an administrator has approved its row in
  `avatar_uploads`. Approving writes the URL onto `users.picture`, which is why `PATCH /me` refuses
  a `picture` field outright — a free-form URL there would make the review step optional. See
  `apps/auth/CLAUDE.md`.
- **Nothing in this repo renders HTML.** `api.franciscosolis.cl` is a backend end to end: every
  Worker answers JSON, a redirect or a binary asset (`apps/api/src/brand.ts`), and nothing else.
  The one place that used to break the rule was `apps/auth`'s built-in sign-in screen; it is gone,
  and `GET /oauth/authorize` now redirects to the sign-in front-end at
  `https://franciscosolis.cl/apps/auth` instead. Email bodies are the only markup here, and they
  are rendered by `packages/emails` for a mail client, not served to a browser.
- **`apps/auth` keeps a browser session, and it is the one cookie in this monorepo**: a completed
  sign-in leaves an `__Secure-auth-session` cookie scoped to `/auth` on `api.franciscosolis.cl`, so
  the next application asks the user to authorize rather than to sign in again. Nothing here
  configures it — the gateway already forwards the whole Request to `auth`, cookie included, and
  hands its response back untouched — but that is why the forwarding policy for `auth`
  (`SERVICE_MODULES` in `apps/api/src/services.ts`) must keep forwarding the Request as it stands
  rather than rebuilding a header list, the way `landing` does. See `apps/auth/CLAUDE.md` for why
  the cookie is `SameSite=Lax` and why CORS there still never allows credentials. Because that
  cookie makes the *second* application an "Authorize" rather than a sign-in — no credential, no
  email — `apps/auth` emails the account holder a notice of every access it grants, sign-in and
  authorization alike (`apps/auth/src/services/notifications.ts`).
- **The gateway's CORS allows write verbs because of auth**: `apps/api` used to allow `GET`
  only; sign-in, token exchange and the admin API need `POST`/`PATCH`/`DELETE`. The origin
  allowlist must stay locked down — but `/auth/*` is excluded from it entirely (`ownsCors` in
  `apps/api/src/services.ts`), because `apps/auth` signs in applications on domains the gateway
  cannot enumerate and answers CORS from its own list of registered clients instead.
- **Cloudflare preview deployments are matched by pattern, on both sides of that split**: a Worker
  deployed from a branch or a version answers at `<alias>-<worker>.franciscosolis.workers.dev`, a
  hostname that does not exist until the deployment does. The gateway allows subdomains of
  `franciscosolis.workers.dev` (`apps/api/src/cors.ts`), and `apps/auth` accepts a
  `https://*.example.com` entry in a client's `allowed_origins` (`apps/auth/src/lib/origins.ts`).
  Both match on a dot boundary — `evilfranciscosolis.workers.dev` is a hostname anyone can take —
  and neither loosens redirect URIs, which stay byte-for-byte exact.
- **`apps/support` is the one Worker here with entry points the gateway does not front.** `fetch` is
  proxied at `/support/*` like every other internal Worker, but `email` is dispatched straight to the
  script by Cloudflare Email Routing and `scheduled` by a cron trigger — neither passes through
  `apps/api`, and neither can. That is the single documented exception to the service-binding rule
  above, and it is why the `workers_dev`/routing configuration there must not be "tidied up" on the
  strength of it: doing so silently removes the inbound half of the product while every test still
  passes. The Email Routing rules themselves are dashboard configuration this repo cannot hold, in
  exactly the way Workers Builds is.
- **`apps/support` is also the first Worker here that enforces a permission.** `apps/cms` and
  `apps/pages` deliberately stop at the email-domain gate and never read `permissions` off a token.
  A support system cannot: tickets are *assignable to people*, and that is meaningless without a
  defined set of people. `apps/auth` resolves roles per client application, so `support:agent` plus a
  client application of its own is the mechanism that produces one — which is why `apps/support` does
  **not** reuse the CMS's audience the way `apps/pages` does. It also carries two audience lists, one
  for the console and a wider one for somebody reading their own ticket; merging them would leave the
  domain and permission checks as the only thing keeping a website token out of `/admin`.
- **Ticket content is the only unauthenticated free text this monorepo stores**, and the schema has
  no column for HTML anywhere near it. Not having the column is what makes it structurally impossible
  for a later change to render it — the same rule `packages/emails/CLAUDE.md` states for
  `ContentEmail`'s `dangerouslySetInnerHTML`. Inbound mail is converted to text at ingest by
  `apps/support/src/lib/mime.ts`, and the quoted trail is trimmed there.
- This repo uses `dev` as its default/main branch — never target `main`/`master`.
- `apps/landing/.dev.vars` holds the `GH_TOKEN` secret for local dev, and
  `apps/auth/.dev.vars` holds `JWT_PRIVATE_KEY` and the Google OAuth client. Neither must
  ever be committed (both already gitignored). `apps/cms` has no secrets at all — its `.dev.vars` only
  repoints `AUTH_JWKS_URL`/`AUTH_ISSUER` at a local auth Worker — and `apps/support` has none either:
  the link that lets somebody read their own ticket without an account is a per-ticket random secret
  stored as a hash on the row, not a key held by the Worker. `apps/pages` used to be in that group and
  no longer is: it holds `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` and
  `DOWNLOAD_SIGNING_KEY`. Use a MercadoPago *test* credential locally — a preference created with one
  answers a `sandbox_init_point`, which is what the Worker hands the browser, so nothing charges a real
  card.
