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
own API (`apps/landing`), the centralized authentication service (`apps/auth`) and the
content management service (`apps/cms`). The
workers talk to each other directly through Cloudflare **service bindings** — no HTTP
round-trip over the public internet — and the root API transparently proxies and merges the
OpenAPI specs of every internal module it exposes.

Every worker is built with **Hono** on the edge, validates input/output with **valibot**,
and auto-generates an OpenAPI 3 document via `hono-openapi`. The `api` worker's `/openapi.json`
is not just its own spec: it fetches each internal module's spec over its service binding and
merges the paths/components under a prefix (e.g. `/landing/*`), so consumers get one combined
API description without the internal modules needing to be public.

The workspace is managed with **pnpm workspaces**, sharing dependency versions through a
pnpm `catalog` so every worker stays on the same Hono/valibot/wrangler versions.

---

## ✨ Features

- **Single public entrypoint, multiple internal Workers** — `apps/api` proxies `/landing/*`,
  `/auth/*` and `/cms/*` to the `landing`, `auth` and `cms` Workers via Cloudflare service
  bindings (`LANDING`, `AUTH`, `CMS`), keeping internal services off the public internet.
- **Centralized authentication** — `apps/auth` implements an OAuth 2.0 authorization code
  flow with PKCE over two providers (magic link by email, Google OAuth 2.0), backed by a D1
  database of users, identities, applications, roles, permissions, invitations and sessions.
  It issues EdDSA-signed JWTs that any service can verify offline against its published JWKS.
- **Content management** — `apps/cms` backs the landing page's content collections (projects,
  experience, skills, certifications, education), its legal pages, and outgoing email sent
  through Cloudflare Email Sending. Published content is readable publicly; editing requires an
  access token from `apps/auth` belonging to an `@franciscosolis.cl` account, verified offline
  against the auth JWKS.
- **Merged OpenAPI spec** — `mergeRemoteSpecs` (`apps/api/src/openapi.ts`) fetches each
  internal Worker's `/openapi.json` and merges it into the root spec under its route prefix;
  an unreachable module is silently skipped instead of breaking the whole document.
- **Locked-down CORS** — the API only accepts requests from `localhost:5173`,
  `*.franciscosolis.workers.dev`, and `*.franciscosolis.cl` origins, defaulting to
  `https://franciscosolis.cl` otherwise. Methods are limited to the verbs the auth module
  needs (`GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`).
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
  `valibot`, `wrangler`, `axios`, `drizzle-orm`, `drizzle-kit`, `typescript`, `vitest`,
  `@cloudflare/vitest-pool-workers`, `@vitest/coverage-istanbul`, `@hono/standard-validator`
  and `@valibot/to-json-schema` in a single `catalog` consumed by every app.
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
| Database | Cloudflare D1 + [Drizzle ORM](https://orm.drizzle.team) (`apps/auth`, `apps/cms`) |
| Email | [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) (`apps/auth`, `apps/cms`) |
| HTTP client | axios |
| Language | TypeScript (strict) |
| Package manager | pnpm workspaces (11.17.0) with a shared dependency catalog |
| Testing | [Vitest](https://vitest.dev) running inside `workerd` via `@cloudflare/vitest-pool-workers` |
| CI | GitHub Actions, one independent check per app |
| Deployment | Cloudflare Wrangler, custom domain `api.franciscosolis.cl` |
| Inter-service comms | Cloudflare Workers service bindings |

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
cd apps/auth && pnpm run keys:generate   # prints the JWT_PRIVATE_KEY to paste in
```

`apps/cms` has no secrets of its own — its `.dev.vars` only points `AUTH_JWKS_URL` and
`AUTH_ISSUER` at the local auth Worker.

| Variable | Description | Where |
|----------|-------------|-------|
| `GH_TOKEN` | GitHub API token used by `apps/landing`'s `/stats/github` route | `apps/landing/.dev.vars` |
| `JWT_PRIVATE_KEY` | Ed25519 JWK signing the access tokens issued by `apps/auth` | `apps/auth/.dev.vars` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client used by `apps/auth` | `apps/auth/.dev.vars` |

Then create the database tables:

```bash
cd apps/auth && pnpm run db:migrate:local
cd apps/cms && pnpm run db:migrate:local
```

The `api` worker has no secrets of its own; it only needs the `LANDING`, `AUTH` and `CMS`
service bindings, which are wired up in `apps/api/wrangler.jsonc`. See
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
| `api` | The `landing`, `auth` and `cms` Workers are booted as auxiliary Miniflare Workers (`apps/api/test/stubs.ts`), so `LANDING`/`AUTH`/`CMS` are genuine service bindings under test |
| `landing` | A dummy `GH_TOKEN`; every GitHub call is mocked at the `axios` module |
| `auth` | A live D1 database with `migrations/` applied per test file, plus a fixed test-only Ed25519 signing key |
| `cms` | A live D1 database with `migrations/` applied per test file; `AUTH_JWKS_URL` points at an unroutable host so a JWKS fetch that escapes its stub fails loudly |

Because `auth` and `cms` apply their real `migrations/` directory to each test file's isolated
database, a migration that stops applying cleanly fails the test run rather than surfacing at
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

It runs **one job per app**, so `api`, `landing`, `auth` and `cms` each report as an independent
check. `fail-fast` is disabled: a failure in one app never cancels or hides the others, and the
check that goes red points straight at the Worker that broke. Each job does the same three things
for its own app:

1. **Typecheck** — `tsc --noEmit` over `src/` and `test/` together.
2. **Test** — the full suite inside `workerd`, with a coverage report uploaded as an artifact.
3. **Build** — `wrangler deploy --dry-run`, catching config and bundling breakage the tests cannot see.

A final aggregate job named `ci` turns green only when all four app jobs did, which gives branch
protection a single status to require instead of a list that has to be edited whenever an app is
added or renamed.

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
```

`apps/api/wrangler.jsonc` binds the custom domain `api.franciscosolis.cl` (zone
`franciscosolis.cl`) plus the `LANDING`, `AUTH` and `CMS` service bindings, so those Workers must
be deployed under exactly the names `landing`, `auth` and `cms` for the bindings to resolve.

`apps/auth` also needs its secrets and its database migrations in production:

```bash
cd apps/auth
pnpm exec wrangler secret put JWT_PRIVATE_KEY
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm run db:migrate:remote
```

`apps/cms` needs its own migrations in production, but no secrets:

```bash
cd apps/cms
pnpm run db:migrate:remote
```

To regenerate Cloudflare binding types after editing `wrangler.jsonc`:

```bash
pnpm run cf-typegen
```

---

## ⚙️ Configuration

| File | Purpose |
|------|---------|
| `apps/api/wrangler.jsonc` | Routes, custom domain, `LANDING`, `AUTH` and `CMS` service bindings, observability sampling |
| `apps/landing/wrangler.jsonc` | Worker name/config for the `landing` service |
| `apps/auth/wrangler.jsonc` | Worker name/config for the `auth` service, D1 binding, email sending binding, public URL and issuer vars |
| `apps/auth/migrations/` | D1 migrations for `franciscosolis_auth` |
| `apps/cms/wrangler.jsonc` | Worker name/config for the `cms` service, D1 binding, email sending binding, JWKS/issuer, allowed audiences, email domains and senders |
| `apps/cms/migrations/` | D1 migrations for `franciscosolis_cms` |
| `pnpm-workspace.yaml` | Workspace packages (`apps/*`, `packages/*`) and shared dependency catalog |
| `apps/*/vitest.config.ts` | Test runtime for that app — bindings, D1 migrations and service-binding stubs |
| `.github/workflows/ci.yml` | CI pipeline: typecheck, test and dry-run build, one independent check per app |

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
