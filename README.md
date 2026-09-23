<div align="center">

# 🔌 api.franciscosolis.cl

**Public REST API for franciscosolis.cl, built as a pnpm monorepo of Cloudflare Workers.**

[![CI](https://github.com/Im-Fran/api.franciscosolis.cl/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/Im-Fran/api.franciscosolis.cl/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Im-Fran/api.franciscosolis.cl)](LICENSE)

</div>

---

## 📖 Overview

This repository holds the backend that powers **franciscosolis.cl**: a public-facing API
worker (`apps/api`) that fronts a set of internal Cloudflare Workers — the landing site's
own API (`apps/landing`), the centralized authentication service (`apps/auth`), the
content management service (`apps/cms`), the marketplace (`apps/marketplace`), the support desk
(`apps/support`) and the notification centre (`apps/notifications`). The
workers talk to each other directly through Cloudflare **service bindings** — no HTTP
round-trip over the public internet — and the root API transparently proxies and merges the
OpenAPI specs of every internal module it exposes. The one exception is how the other Workers tell
`apps/notifications` that something happened: they publish onto a **Cloudflare Queue**, for the
reason spelled out under *Features* below.

Every worker is built with **Hono** on the edge, validates input/output with **valibot**,
and auto-generates an OpenAPI 3 document via `hono-openapi`. The `api` worker's `/openapi.json`
is not just its own spec: it fetches each internal module's spec over its service binding and
merges the paths/components under a prefix (e.g. `/landing/*`), so consumers get one combined
API description without the internal modules needing to be public.

Shared code lives under `packages/`. There are two packages:
[`@franciscosolis/emails`](packages/emails/README.md), which holds every email body in the
monorepo as **react-email** components, so `auth`, `cms` and `support` render mail from the same
templates instead of assembling HTML each on their own; and
[`@franciscosolis/translate`](packages/translate/README.md), which holds the one prompt behind every
machine translation here, so `cms`, `marketplace` and `support` ask Workers AI the same thing in the same
words.

The workspace is managed with **pnpm workspaces**, sharing dependency versions through a
pnpm `catalog` so every worker stays on the same Hono/valibot/wrangler versions.

---

## ✨ Features

- **Single public entrypoint, multiple internal Workers** — `apps/api` proxies `/landing/*`,
  `/auth/*`, `/cms/*`, `/marketplace/*`, `/support/*` and `/notifications/*` to the `landing`, `auth`,
  `cms`, `marketplace`, `support` and `notifications` Workers via Cloudflare service bindings
  (`LANDING`, `AUTH`, `CMS`, `MARKETPLACE`, `SUPPORT`, `NOTIFICATIONS`), keeping internal services off
  the public internet. `support` is the one exception worth knowing:
  it also answers a Cloudflare Email Routing handler and a cron trigger, neither of which comes
  through the gateway.
- **Centralized authentication** — `apps/auth` implements an OAuth 2.0 authorization code
  flow with PKCE over two providers (magic link by email, Google OAuth 2.0), backed by a D1
  database of users, identities, applications, roles, permissions, invitations and sessions.
  It issues EdDSA-signed JWTs that any service can verify offline against its published JWKS.
- **Content management** — `apps/cms` backs the landing page's content collections (projects,
  experience, skills, certifications, education), its legal pages, and outgoing email sent
  through Cloudflare Email Sending. Published content is readable publicly; editing requires an
  access token from `apps/auth` belonging to an `@franciscosolis.cl` account, verified offline
  against the auth JWKS.
- **A marketplace** — `apps/marketplace` gives every product built here the same page: a banner, the
  tabs it turned on out of Overview, Releases, Wiki, Reviews and Contact, and a sidebar beside the
  overview with the download and purchase counts, the first and last release dates, the category, the
  star rating and the latest version's own date, counts, rating and compatibility list. The tab set is
  a registry rather than a per-page layout field, which is what keeps a dozen pages looking like one
  product family instead of a dozen bespoke sites. The website renders them at
  `franciscosolis.cl/product/<slug>`.

  Releases go out on four **channels** — `nightly`, `beta`, `rc`, `release` — and the channel is part
  of the version key, so `1.4.0` can exist as a release candidate and later as a release. The public
  feed shows the stable line unless asked otherwise, and each release declares its own
  **compatibility**: the operating systems, runtimes and dependencies *that version* needs, because a
  release is exactly where support is added and dropped.

  A product can be **paid for or donated to** through MercadoPago Checkout Pro, tied to an account on
  the franciscosolis.cl SSO: its builds sit in R2 with no public access and are served against a
  signed per-request ticket, so the download itself is what knows whether the person taking it has
  paid — a non-payer of a paying product is always shown the offer and waits five seconds, somebody
  who paid gets the link straight away. A donation product can also reserve its **pre-release lines
  for supporters**, which is the one incentive that does not cost a non-payer the product.

  The people who bought or downloaded something can **review** it: one review each, anchored to the
  version they had, published immediately, answerable once by the owner and flaggable by readers into
  a moderation queue. Publishing a release can **restart the rating** the way the App Store does —
  which deletes nothing, and every earlier review stays readable and says so.

  Around all of that sits a **back office per product**: its sales with gross, returned and net
  totals; sales *recorded by hand* for money taken in cash or by transfer, or a copy given away,
  which entitle exactly as a card payment does; **vouchers** — numbered receipts, issued, re-issued,
  re-sent and voided rather than edited; refunds, with the ten-day *derecho a retracto* reported on
  every sale; and views and downloads counted per product and per release, with a daily series behind
  them. A test payment can never be confused with a real one: `MERCADOPAGO_ENVIRONMENT` decides which
  account takes the money and is stamped on every purchase.
- **Support tickets and a help centre** — `apps/support` takes a request for help from the website
  or from `soporte@franciscosolis.cl`, and the conversation works in both places: replies, internal
  notes only the team sees, labels, assignment and watchers. When the team answers and nobody comes
  back within thirty minutes, one digest email goes out. Behind it sits a bilingual help centre,
  searched lexically with SQLite's FTS5 and semantically with Workers AI embeddings in Vectorize —
  the second of which also drafts an agent's reply out of the published articles.
- **Notifications** — `apps/notifications` is the bell on the website: an in-site list of what
  happened to an account (a sign-in, an authorization, an avatar decision, a reply on a ticket, a
  purchase, a refund, a new release of something bought, an answer to a review), **Web Push** to every
  device that subscribed (VAPID, RFC 8291/8292, with an installable PWA on the website), and email —
  immediately, in a daily or a weekly digest at 09:00 Santiago time, or never, per the account's own
  preferences for each of the `account`, `support` and `marketplace` categories.

  `auth`, `support` and `marketplace` tell it about those events by publishing onto a **Cloudflare
  Queue** (`franciscosolis-notifications`, and `-dev` for the development stack) rather than through a
  service binding. That is not a preference: `notifications` binds `AUTH` to read the JWKS, so a
  binding back from `auth` would be a cycle in which neither Worker's first deploy could resolve the
  other. A queue is not a Worker, so it breaks the cycle — and it brings retries and at-least-once
  delivery with it, so a sign-in never waits on, or fails because of, the notifications Worker.

  Some mail is **always** sent by the Worker that produced it, whatever the preferences say, because
  it is the thing itself rather than news about it: the magic link, invitations, sale receipts, refund
  notices, and every support email (the ticket confirmation, the reply digest, "you were added").
  Those events still land in the bell, and the notifications Worker never emails them, so nobody gets
  the same thing twice. The account-access notice is the one that moved: `auth` no longer emails it
  directly, and only falls back to doing so when the queue refuses the event — a security notice must
  never be lost to an outage.
- **Shared email templates** — every message any of these Workers sends is a react-email component in
  `packages/emails`, rendered to an HTML + plain-text pair at send time. Values are escaped by
  construction, the text alternative is derived from the HTML so the two cannot drift, and the
  whole set is previewable in a browser with `pnpm --filter @franciscosolis/emails run preview`.
  The layout carries the FranciscoSolis identity — gradient rule, horizontal lockup, iris accent
  — on a light palette chosen for how mail clients rewrite colours, not for taste; `apps/api`
  serves the logo at `/brand/lockup.png` because an email cannot embed one.
- **Merged OpenAPI spec** — `mergeRemoteSpecs` (`apps/api/src/openapi.ts`) fetches each
  internal Worker's `/openapi.json` and merges it into the root spec under its route prefix;
  an unreachable module is silently skipped instead of breaking the whole document.
- **Locked-down CORS** — the API only accepts requests from `localhost:5173`,
  `*.franciscosolis.workers.dev`, and `*.franciscosolis.cl` origins, defaulting to
  `https://franciscosolis.cl` otherwise. Methods are limited to the verbs the modules need
  (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`).
- **Correct JSON charset** — a shared middleware appends `; charset=UTF-8` to
  `application/json` responses so non-ASCII text isn't mangled by Latin-1-defaulting clients.
- **Typed error responses** — `onError` normalizes both `HTTPException`s and unexpected
  errors into a consistent `{ code, error }` JSON body.
- **GitHub stats module** — the `landing` Worker exposes `/stats/github`, backed by a
  `GH_TOKEN` secret.
- **Invitation-only sign-up with roles and permissions** — the `auth` Worker refuses unknown
  addresses without a pending invitation, re-reads roles and session state from D1 on every
  authenticated request so revocation is immediate, and rotates refresh tokens with reuse
  detection.
- **Shared dependency versions** — `pnpm-workspace.yaml` pins `hono`, `hono-openapi`,
  `valibot`, `wrangler`, `axios`, `drizzle-orm`, `drizzle-kit`, `react`, `react-dom`,
  `react-email`, `@react-email/render`, `typescript`, `vitest`,
  `@cloudflare/vitest-pool-workers`, `@vitest/coverage-istanbul`, `@hono/standard-validator`
  and `@valibot/to-json-schema` in a single `catalog` consumed by every workspace package.
- **Tested inside the real runtime** — every app has unit and functional suites that execute in
  `workerd` through `@cloudflare/vitest-pool-workers`, against live D1 databases and real service
  bindings rather than Node stand-ins. CI runs each app as its own independent check.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | [Hono](https://hono.dev) + [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| Validation | [valibot](https://valibot.dev) via `@hono/standard-validator` |
| Database | Cloudflare D1 + [Drizzle ORM](https://orm.drizzle.team) (`apps/auth`, `apps/cms`, `apps/marketplace`, `apps/support`, `apps/notifications`) |
| Email | [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) (`apps/auth`, `apps/cms`, `apps/marketplace`, `apps/support`, `apps/notifications`) |
| Events | [Cloudflare Queues](https://developers.cloudflare.com/queues/) — `auth`, `support` and `marketplace` produce, `notifications` consumes |
| Push | Web Push with VAPID (`apps/notifications`) |
| Email templates | [react-email](https://react.email) in the shared `@franciscosolis/emails` package |
| Machine translation | [Workers AI](https://developers.cloudflare.com/workers-ai/) behind the shared `@franciscosolis/translate` package (`apps/cms`, `apps/marketplace`, `apps/support`) |
| HTTP client | axios |
| Language | TypeScript (strict) |
| Package manager | pnpm workspaces (11.17.0) with a shared dependency catalog |
| Testing | [Vitest](https://vitest.dev) running inside `workerd` via `@cloudflare/vitest-pool-workers` |
| CI | GitHub Actions, one independent check per app |
| Deployment | Cloudflare Wrangler, custom domain `api.franciscosolis.cl` |
| Inter-service comms | Cloudflare Workers service bindings, plus one queue for notification events |

---

## 📋 Requirements

- **Node.js** (any version compatible with `wrangler` and `@cloudflare/workers-types`)
- **pnpm** `11.17.0` (declared in `package.json` as `packageManager`)
- A **Cloudflare account** with Workers access for `dev`/`deploy`

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone git@github.com:Im-Fran/api.franciscosolis.cl.git
cd api.franciscosolis.cl
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

Copy the example dev-vars files and fill them in:

```bash
cp apps/landing/.dev.vars.example apps/landing/.dev.vars
cp apps/auth/.dev.vars.example apps/auth/.dev.vars
cp apps/cms/.dev.vars.example apps/cms/.dev.vars
cp apps/marketplace/.dev.vars.example apps/marketplace/.dev.vars
cd apps/auth && pnpm run keys:generate   # prints the JWT_PRIVATE_KEY to paste in
```

`apps/cms` has no secrets of its own — its `.dev.vars` only points `AUTH_JWKS_URL` and `AUTH_ISSUER`
at the local auth Worker. `apps/marketplace` does hold three: a MercadoPago credential (use a **test** one,
so nothing charges a real card), its webhook secret, and the key its download links are signed with.
Its `.dev.vars` also sets `MERCADOPAGO_ENVIRONMENT=sandbox`, and that line is not optional: the
committed config says `live` at the top level, and a test credential's *live* checkout URL is not
where the provider's test cards work.

| Variable | Description | Where |
|----------|-------------|-------|
| `GH_TOKEN` | GitHub API token used by `apps/landing`'s `/stats/github` route | `apps/landing/.dev.vars` |
| `JWT_PRIVATE_KEY` | Ed25519 JWK signing the access tokens issued by `apps/auth` | `apps/auth/.dev.vars` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client used by `apps/auth` | `apps/auth/.dev.vars` |
| `MERCADOPAGO_ACCESS_TOKEN` | MercadoPago credential `apps/marketplace` creates preferences and reads payments with | `apps/marketplace/.dev.vars` |
| `MERCADOPAGO_WEBHOOK_SECRET` | Verifies MercadoPago notifications; without it every one is refused | `apps/marketplace/.dev.vars` |
| `DOWNLOAD_SIGNING_KEY` | HMAC key the download tickets in `apps/marketplace` are signed with | `apps/marketplace/.dev.vars` |

Then create the database tables:

```bash
cd apps/auth && pnpm run db:migrate:local
cd apps/cms && pnpm run db:migrate:local
cd apps/marketplace && pnpm run db:migrate:local
```

The `api` worker has no secrets of its own; it only needs the `LANDING`, `AUTH`, `CMS`, `MARKETPLACE`,
`SUPPORT` and `NOTIFICATIONS` service bindings, which are wired up in `apps/api/wrangler.jsonc`. See
[`apps/auth/README.md`](apps/auth/README.md) for the full authentication setup.

### 4. Run in development

From the repo root, this runs every workspace app's `dev` script in parallel:

```bash
pnpm run dev
```

This starts:
- `api` on `http://localhost:8787` (inspector on port `9229`)
- `landing` on `http://localhost:8788` (inspector on port `9230`)
- `auth` on `http://localhost:8789` (inspector on port `9231`)
- `cms` on `http://localhost:8790` (inspector on port `9232`)
- `support` on `http://localhost:8793` (inspector on port `9234`)
- `marketplace` on `http://localhost:8794` (inspector on port `9235`)
- `notifications` on `http://localhost:8795` (inspector on port `9236`)

The notifications queue is simulated per `wrangler dev` process, and the producers and the consumer
each run their own, so an event published by a local `auth` is not something to count on reaching a
local `notifications`. The consumer is exercised through its own suite instead.

Each app can also be run individually from its own directory, e.g. `cd apps/api && pnpm run dev`.

---

## 🧪 Testing

Every app has its own suite, split into **unit** tests (`test/unit/`, a module in isolation) and
**functional** tests (`test/functional/`, a request travelling through the Worker).

Tests run **inside `workerd`** via [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
not in Node. That matters: D1, service bindings, the Email Sending binding and the Workers globals
are all real under test, so a suite cannot pass against behaviour the production runtime would
reject. Each app's `vitest.config.ts` reuses its own `wrangler.jsonc`, so the test runtime inherits
the same compatibility date and flags as the deployed Worker.

From the repo root:

```bash
pnpm run test           # every app
pnpm run test:coverage  # every app, with an istanbul coverage report
pnpm run typecheck      # tsc over src/ and test/ in every app
pnpm run build          # wrangler deploy --dry-run in every app
```

Or for a single app:

```bash
cd apps/auth
pnpm run test
pnpm run test:watch
pnpm run test:coverage
```

Notes on the setup, per app:

| App | What the harness provides |
|-----|---------------------------|
| `api` | The `landing`, `auth`, `cms`, `marketplace`, `support` and `notifications` Workers are booted as auxiliary Miniflare Workers (`apps/api/test/stubs.ts`), so `LANDING`/`AUTH`/`CMS`/`MARKETPLACE`/`SUPPORT`/`NOTIFICATIONS` are genuine service bindings under test |
| `landing` | A dummy `GH_TOKEN`; every GitHub call is mocked at the `axios` module |
| `auth` | A live D1 database with `migrations/` applied per test file, plus a fixed test-only Ed25519 signing key |
| `cms` | A live D1 database with `migrations/` applied per test file; `AUTH_JWKS_URL` points at an unroutable host so a JWKS fetch that escapes its stub fails loudly |
| `marketplace` | The same as `cms`. Its JWKS-cache tests live in a file of their own, because the cache is per isolate and one warm fetch would make every later stub go unasked |

The three producers (`auth`, `support`, `marketplace`) keep `NOTIFICATIONS_QUEUE` declared under
test — Miniflare simulates a queue producer with no account behind it — and replace it by assignment
wherever a test asserts on what was published (`test/helpers/queue.ts` in each), the same way the
suites replace `EMAIL`.

Because `auth`, `cms`, `marketplace`, `support` and `notifications` apply their real `migrations/` directory to each test file's
isolated database, a migration that stops applying cleanly fails the test run rather than surfacing at
deploy time.

Coverage uses the **istanbul** provider — `workerd` exposes no V8 coverage hooks, so
instrumentation is the only option there. Reports land in `apps/<app>/coverage/` (gitignored).

---

## 🏗 Building for Production

Cloudflare Workers are deployed straight from TypeScript source via Wrangler's own bundler as part
of `deploy`, so there is no artifact to build. `pnpm run build` exists only as a check: it runs
`wrangler deploy --dry-run`, which needs no credentials and fails on an invalid `wrangler.jsonc`,
a missing binding or code that does not bundle for the Workers runtime.

---

## ✅ Continuous Integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request, on pushes to
`dev`, and on demand.

It runs **one job per app**, so `api`, `landing`, `auth`, `cms`, `marketplace`, `support` and `notifications` each report as an
independent check, plus a small `emails` job that typechecks the shared template package. `fail-fast` is disabled: a failure in one app never cancels or hides the others, and the
check that goes red points straight at the Worker that broke. Each job does the same three things
for its own app:

1. **Typecheck** — `tsc --noEmit` over `src/` and `test/` together.
2. **Test** — the full suite inside `workerd`, with a coverage report uploaded as an artifact.
3. **Build** — `wrangler deploy --dry-run`, catching config and bundling breakage the tests cannot see.

A final aggregate job named `ci` turns green only when every one of those jobs did, which gives
branch protection a single status to require instead of a list that has to be edited whenever an
app is added or renamed.

---

## 🌱 Environments

There are two full stacks of these Workers on the account, and they share nothing but the code.

| | Production | Development |
|---|---|---|
| Gateway | `api` → `api.franciscosolis.cl` | `api-dev` → `api-dev.franciscosolis.cl` |
| Modules | `landing`, `auth`, `cms`, `marketplace`, `support`, `notifications` | `landing-dev`, `auth-dev`, `cms-dev`, `marketplace-dev`, `support-dev`, `notifications-dev` |
| Front-end | `franciscosolis` → `franciscosolis.cl` | `franciscosolis-dev` → `dev.franciscosolis.cl` |
| Databases | `franciscosolis_auth`, `_cms`, `_marketplace`, `_support`, `_notifications` | the same five with a `_dev` suffix |
| Buckets | `franciscosolis-avatars`, `franciscosolis-app-releases` | the same two with a `-dev` suffix |
| Queue | `franciscosolis-notifications` | `franciscosolis-notifications-dev` |
| Deployed by | Cloudflare's Git integration (dashboard) | `.github/workflows/deploy-dev.yml` |

The `-dev` suffix is not typed anywhere: each app declares a named Wrangler environment called
`dev`, and Wrangler appends the environment name to the Worker name. `wrangler deploy --env dev`
on `api` produces `api-dev`.

```bash
pnpm run build:dev            # dry-run deploy of every dev Worker — needs no credentials
pnpm run db:migrate:list:dev  # what is pending on the dev databases
pnpm run db:migrate:remote:dev
```

Deploying by hand follows the service bindings, because one is resolved at deploy time against a
Worker that must already exist — `auth` first, then the modules that bind it, then the gateway:

```bash
cd apps/auth    && pnpm run deploy:dev
cd ../landing   && pnpm run deploy:dev
cd ../cms       && pnpm run deploy:dev
cd ../marketplace && pnpm run deploy:dev
cd ../support   && pnpm run deploy:dev
cd ../notifications && pnpm run deploy:dev
cd ../api       && pnpm run deploy:dev
```

The notifications queue does not change that order. `auth`, `support` and `marketplace` produce to
it and `notifications` consumes it, but each half resolves against the *queue*, not against the
other Worker — so a producer deployed before its consumer simply leaves messages waiting. The one
thing it does require is that the queue exists before the first deploy of any of the four (see
below).

`pnpm run deploy:dev` from the root does exist, but `pnpm run -r` gives no useful order for it:
these apps have no workspace dependency on each other, so nothing tells it that `auth` goes first.
It is there for redeploying a stack that already exists, where order no longer matters.

### What a named environment costs, and the check that pays for it

A named Wrangler environment **inherits no bindings and no vars**. Every database, bucket, service
binding and variable is therefore written twice in each `wrangler.jsonc`: once at the top level for
production, once under `env.dev`. That is how Wrangler works, and it is exactly the kind of
duplication that rots — a var added for production breaks nothing until the day somebody tests the
code path on dev.

`scripts/check-environments.mjs` is the guard, and CI runs it as the `environments` job. For every
app it asserts that `env.dev` declares the same bindings and the same vars as the top level, that
every resource it names is a *different* resource, and that no var still points at a production
host. Run it by hand with `node scripts/check-environments.mjs`.

It also covers the sharpest edge here. `routes` is one of the few keys a named environment *does*
inherit, so an app with a production route and no override under `env.dev` would deploy its
development Worker straight onto the production hostname.

### Setting up the development stack

The Workers and their configuration live in this repository; several things do not, and have to be
done once against the account.

**Secrets, per environment.** `wrangler secret put` writes to one environment, so every secret is
set twice. Give `apps/marketplace` a MercadoPago **test** credential on dev — paired with the
`MERCADOPAGO_ENVIRONMENT: sandbox` var already in its `env.dev`, which is the half that actually sends
the browser to the sandbox checkout — and give `apps/auth` a signing key of its own, which is what
keeps a dev token from verifying against the production JWKS.

```bash
cd apps/auth
pnpm exec wrangler secret put JWT_PRIVATE_KEY --env dev
pnpm exec wrangler secret put GOOGLE_CLIENT_ID --env dev
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET --env dev

cd ../landing && pnpm exec wrangler secret put GH_TOKEN --env dev

cd ../marketplace
pnpm exec wrangler secret put MERCADOPAGO_ACCESS_TOKEN --env dev   # a TEST credential
pnpm exec wrangler secret put MERCADOPAGO_WEBHOOK_SECRET --env dev
pnpm exec wrangler secret put DOWNLOAD_SIGNING_KEY --env dev
```

The Google OAuth client also needs `https://api-dev.franciscosolis.cl/auth/callback/google` among
its authorized redirect URIs, and MercadoPago needs its notification URL pointed at
`https://api-dev.franciscosolis.cl/marketplace`.

**The marketplace's D1 databases.** `franciscosolis_marketplace` and `franciscosolis_marketplace_dev`
do not exist until somebody creates them, and their ids go into `apps/marketplace/wrangler.jsonc` —
the ones committed there are placeholders, and nothing deploys until both are real:

```bash
pnpm exec wrangler d1 create franciscosolis_marketplace
pnpm exec wrangler d1 create franciscosolis_marketplace_dev
```

**The notifications queue, database and push keys.** A queue producer or consumer is resolved at
deploy time against a queue that must already exist, so the two queues come first — before the
first deploy of `auth`, `support`, `marketplace` or `notifications`, any of which otherwise fails:

```bash
pnpm exec wrangler queues create franciscosolis-notifications
pnpm exec wrangler queues create franciscosolis-notifications-dev
```

`apps/notifications` owns `franciscosolis_notifications` and `franciscosolis_notifications_dev`,
which likewise do not exist until they are created; their ids go into
`apps/notifications/wrangler.jsonc`, replacing the placeholders committed there:

```bash
pnpm exec wrangler d1 create franciscosolis_notifications
pnpm exec wrangler d1 create franciscosolis_notifications_dev
```

And it signs Web Push with a VAPID keypair per environment, held as one secret: `VAPID_PRIVATE_KEY`,
a P-256 private JWK whose `x`/`y` already carry the public half, which the Worker derives and
publishes at `GET /notifications/` for the website to subscribe with. A browser subscription is
bound to the public key it was created with, so the two environments must never share a pair, and
rotating one invalidates every subscription made against it:

```bash
cd apps/notifications
node scripts/generate-vapid-keys.mjs | pnpm exec wrangler secret put VAPID_PRIVATE_KEY            # production
node scripts/generate-vapid-keys.mjs | pnpm exec wrangler secret put VAPID_PRIVATE_KEY --env dev  # a different pair
```

The `CLOUDFLARE_API_TOKEN` behind `deploy-dev.yml` also needs **Queues:Edit** on top of `D1:Edit`,
`Workers Scripts:Edit` and `Workers R2 Storage:Edit`: it deploys four Workers bound to the queue.

**The Vectorize index.** `apps/support` binds `franciscosolis-support-help-dev`, which does not
exist until it is created — Vectorize has no local emulation and no lazy creation:

```bash
cd apps/support
pnpm exec wrangler vectorize create franciscosolis-support-help-dev --dimensions=1024 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index franciscosolis-support-help-dev --property-name=locale --type=string
```

**Client applications.** An OAuth client is a row in the auth database, and the development stack
has its own, so nothing registered for `franciscosolis.cl` exists on `api-dev`. Register them
against the dev database and give each the `dev.franciscosolis.cl` redirect URI:

```bash
cd apps/auth
pnpm run admin:bootstrap -- --dev --remote
pnpm run applications -- create franciscosolis-web --dev --remote \
  --name "Landing (dev)" --redirect-uri https://dev.franciscosolis.cl/auth/callback
pnpm run applications -- create franciscosolis-cms --dev --remote \
  --name "CMS (dev)" --redirect-uri https://dev.franciscosolis.cl/cms/callback
pnpm run applications -- create franciscosolis-support --dev --remote \
  --name "Support (dev)" --redirect-uri https://dev.franciscosolis.cl/support/callback
pnpm run applications -- create franciscosolis-marketplace --dev --remote \
  --name "Marketplace (dev)" --redirect-uri https://dev.franciscosolis.cl/marketplace/callback
```

`apps/marketplace` also needs a **permission**, not just an application: its editorial half checks
`marketplace:editor` on top of the email domain, so grant it to the editorial accounts in each
environment. Until that exists, `/marketplace/admin/*` answers 401 for everybody — the correct
failure, and an invisible one.

**Inbound email for `apps/support`, which is deliberately left unrouted.** The development Worker
sends mail and receives none: its `SUPPORT_INBOX_ADDRESSES` and `MAIL_REPLY_TO` name
`soporte-dev@franciscosolis.cl`, which nothing delivers to until an Email Routing rule is added in
the dashboard. That is the safe half to be missing — pointing them at `soporte@franciscosolis.cl`
instead would make a reply to a test email open a real ticket in the production system. Add the
rule when inbound mail is what is being tested.

### Moving the data off `apps/pages`

`apps/marketplace` owns a new database rather than a renamed one, so the rows of
`franciscosolis_pages` have to be carried across once. `scripts/migrate-pages-to-marketplace.mjs`
does it, and it is checked in rather than run from somebody's shell history:

```bash
node scripts/migrate-pages-to-marketplace.mjs --dev            # rehearse against the dev pair
node scripts/migrate-pages-to-marketplace.mjs --dev --apply    # do it, on dev — then run it twice
node scripts/migrate-pages-to-marketplace.mjs --apply          # do it, on production
```

It reads with an explicit projection and writes with an explicit column list, because
`wrangler d1 export` emits `INSERT … VALUES` with no column names and the two schemas differ by
design. It refuses to start if the source has a column its mapping does not name, or if the
destination has a `NOT NULL`-without-default column nothing supplies. Every statement is
`INSERT OR IGNORE`, so a re-run after a partial failure resumes. Afterwards it compares row counts,
`SUM(amount)`, `SUM(refunded_amount)`, the purchase status histogram and the highest voucher number
on both sides, and exits non-zero on any disagreement.

**R2 is not touched.** `apps/marketplace` binds the same buckets `apps/pages` bound, so every
`object_key` copies verbatim and not one byte of a 90 MB installer crosses a network.

One thing about the cutover is worth knowing before it happens. MercadoPago bakes
`notification_url` into a Checkout Pro preference **when the preference is created**, not when it is
paid — so a preference created shortly before the rename notifies `/pages/*` afterwards. The gateway
therefore keeps `/pages/*` as a deprecated alias pointing at the `MARKETPLACE` binding, which is why
that path still answers. Remove it once no preference created before the cutover can still be paid,
and run the scoped reconciliation pass first:

```bash
node scripts/migrate-pages-to-marketplace.mjs --apply \
  --only=purchases,payment_events,sale_vouchers,download_events --since=<cutover unix seconds>
```

### Where the `prd` branch fits

Today `dev` is the default branch and every push to it releases *both* stacks: Cloudflare's Git
integration builds production from it, and `deploy-dev.yml` deploys the development one. That is
temporary. Once a `prd` branch exists, production moves behind it — one dashboard change, pointing
each Worker's build at `prd` — and nothing in this repository has to move with it: `deploy-dev.yml`
already watches `dev` and only `dev`.

---

## 🌐 Deployment

Deployment targets **Cloudflare Workers** directly, using each app's `wrangler.jsonc`.

From the repo root, deploy every workspace app:

```bash
pnpm run deploy
```

Or deploy a single app:

```bash
cd apps/api && pnpm run deploy
cd apps/landing && pnpm run deploy
cd apps/auth && pnpm run deploy
cd apps/cms && pnpm run deploy
cd apps/marketplace && pnpm run deploy
cd apps/support && pnpm run deploy
cd apps/notifications && pnpm run deploy
```

`apps/api/wrangler.jsonc` binds the custom domain `api.franciscosolis.cl` (zone
`franciscosolis.cl`) plus the `LANDING`, `AUTH`, `CMS`, `MARKETPLACE`, `SUPPORT` and `NOTIFICATIONS`
service bindings, so those Workers must be deployed under exactly the names `landing`, `auth`, `cms`,
`marketplace`, `support` and `notifications` for the bindings to resolve. The
`franciscosolis-notifications` queue has to exist before `auth`, `support`, `marketplace` or
`notifications` is first deployed.

`apps/auth` also needs its secrets in production:

```bash
cd apps/auth
pnpm exec wrangler secret put JWT_PRIVATE_KEY
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

`apps/marketplace` needs its three:

```bash
cd apps/marketplace
pnpm exec wrangler secret put MERCADOPAGO_ACCESS_TOKEN
pnpm exec wrangler secret put MERCADOPAGO_WEBHOOK_SECRET
pnpm exec wrangler secret put DOWNLOAD_SIGNING_KEY
```

It also needs the `franciscosolis-app-releases` R2 bucket to exist, with no public access and no custom
domain: every byte is served through the Worker.

`apps/notifications` needs its VAPID private key (see *Setting up the development stack* for how to
generate a pair, and why each environment has its own):

```bash
cd apps/notifications
pnpm exec wrangler secret put VAPID_PRIVATE_KEY
```

`apps/cms` needs no secrets at all.

### Database migrations

The five stateful Workers — `auth`, `cms`, `marketplace`, `support` and `notifications` — own a D1 database each, and their migrations are
applied by the **`Migrate` workflow** (`.github/workflows/migrate.yml`), not by hand. It runs on a
push to `dev` that touches `apps/*/migrations/**`, one job per database, and can also be started by
hand from the Actions tab — applying is idempotent, so a run against a database that is already
current is a no-op.

It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (with the **D1:Edit** permission on the
account) and `CLOUDFLARE_ACCOUNT_ID`. Without them the workflow stops on its first step and says so
rather than failing later inside Wrangler.

Wrangler's own behaviour is what makes this safe to automate: in a non-interactive shell it skips
the confirmation prompt but still captures a backup first, and a migration that errors is rolled
back with the previous one left applied. So a failed run is safe to re-run once the migration is
fixed.

Running them by hand is still there for a database that has drifted, or for a first deploy:

```bash
pnpm run db:migrate:list      # what is pending, every database
pnpm run db:migrate:remote    # apply it
pnpm run db:migrate:local     # the same, against the local dev databases
```

**One caveat about ordering.** The Workers themselves are deployed by Cloudflare's Git integration,
which starts from the same push, so the migration and the deploy race rather than being sequenced.
That is tolerable because of how these Workers fail on a schema that is behind: a public read
degrades to the pre-migration shape, while an editorial write errors outright — so the window costs
the CMS its write path for as long as the migration takes and costs the public site nothing. If it
ever needs to be strictly ordered, point Cloudflare's **build command** at `pnpm run
db:migrate:remote` with `CLOUDFLARE_API_TOKEN` in the build environment; it then runs before that
Worker's deploy, and this workflow becomes redundant.

To regenerate Cloudflare binding types after editing `wrangler.jsonc`:

```bash
pnpm run cf-typegen
```

---

## ⚙️ Configuration

| File | Purpose |
|------|---------|
| `apps/api/wrangler.jsonc` | Routes, custom domain, `LANDING`, `AUTH`, `CMS`, `MARKETPLACE`, `SUPPORT` and `NOTIFICATIONS` service bindings, observability sampling |
| `apps/landing/wrangler.jsonc` | Worker name/config for the `landing` service |
| `apps/auth/wrangler.jsonc` | Worker name/config for the `auth` service, D1 binding, email sending binding, notifications queue producer, public URL and issuer vars |
| `apps/auth/migrations/` | D1 migrations for `franciscosolis_auth` |
| `apps/cms/wrangler.jsonc` | Worker name/config for the `cms` service, D1 binding, email sending binding, JWKS/issuer, allowed audiences, email domains and senders |
| `apps/cms/migrations/` | D1 migrations for `franciscosolis_cms` |
| `apps/marketplace/wrangler.jsonc` | Worker name/config for the `marketplace` service, D1 and R2 bindings, JWKS/issuer, the editorial and account audience lists, allowed email domains, and the public/site base URLs |
| `apps/marketplace/migrations/` | D1 migrations for `franciscosolis_marketplace` |
| `apps/notifications/wrangler.jsonc` | Worker name/config for the `notifications` service: D1, email sending, `AUTH` binding, the queue consumer, the hourly digest cron, VAPID and site vars |
| `apps/notifications/migrations/` | D1 migrations for `franciscosolis_notifications` |
| `pnpm-workspace.yaml` | Workspace packages (`apps/*`, `packages/*`) and shared dependency catalog |
| `apps/*/vitest.config.ts` | Test runtime for that app — bindings, D1 migrations and service-binding stubs |
| `.github/workflows/ci.yml` | CI pipeline: typecheck, test and dry-run build, one independent check per app |
| `.github/workflows/migrate.yml` | Applies pending production D1 migrations, one job per database |
| `.github/workflows/deploy-dev.yml` | Deploys the development stack in binding order |

---

## 🤝 Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feat/your-feature`
3. Add tests for what you changed — `pnpm run test` and `pnpm run typecheck` must pass
4. Commit: `git commit -m "feat: add your feature"`
5. Push and open a PR against `dev`

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0** — see the
[LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE) file for details.

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
