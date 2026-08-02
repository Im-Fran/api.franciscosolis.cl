<div align="center">

# 🔌 api.franciscosolis.cl

**Public REST API for franciscosolis.cl, built as a pnpm monorepo of Cloudflare Workers.**

[![License](https://img.shields.io/github/license/Im-Fran/api.franciscosolis.cl)](LICENSE)

</div>

---

## 📖 Overview

This repository holds the backend that powers **franciscosolis.cl**: a public-facing API
worker (`apps/api`) that fronts a set of internal Cloudflare Workers, starting with the
landing site's own API (`apps/landing`, pulled in as a git submodule). The two workers talk
to each other directly through Cloudflare **service bindings** — no HTTP round-trip over the
public internet — and the root API transparently proxies and merges the OpenAPI specs of
every internal module it exposes.

Both workers are built with **Hono** on the edge, validate input/output with **valibot**,
and auto-generate an OpenAPI 3 document via `hono-openapi`. The `api` worker's `/openapi.json`
is not just its own spec: it fetches each internal module's spec over its service binding and
merges the paths/components under a prefix (e.g. `/landing/*`), so consumers get one combined
API description without the internal modules needing to be public.

The workspace is managed with **pnpm workspaces**, sharing dependency versions through a
pnpm `catalog` so both workers stay on the same Hono/valibot/wrangler versions.

---

## ✨ Features

- **Single public entrypoint, multiple internal Workers** — `apps/api` proxies `/landing/*`
  to the `landing` Worker via a Cloudflare service binding (`LANDING`), keeping internal
  services off the public internet.
- **Merged OpenAPI spec** — `mergeRemoteSpecs` (`apps/api/src/openapi.ts`) fetches each
  internal Worker's `/openapi.json` and merges it into the root spec under its route prefix;
  an unreachable module is silently skipped instead of breaking the whole document.
- **Locked-down CORS** — the API only allows `GET` requests and only from
  `localhost:5173`, `*.franciscosolis.workers.dev`, and `*.franciscosolis.cl` origins,
  defaulting to `https://franciscosolis.cl` otherwise.
- **Correct JSON charset** — a shared middleware appends `; charset=UTF-8` to
  `application/json` responses so non-ASCII text isn't mangled by Latin-1-defaulting clients.
- **Typed error responses** — `onError` normalizes both `HTTPException`s and unexpected
  errors into a consistent `{ code, error }` JSON body.
- **GitHub stats module** — the `landing` Worker exposes `/stats/github`, backed by a
  `GH_TOKEN` secret.
- **Shared dependency versions** — `pnpm-workspace.yaml` pins `hono`, `hono-openapi`,
  `valibot`, `wrangler`, `axios`, `@hono/standard-validator` and `@valibot/to-json-schema`
  in a single `catalog` consumed by every app.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | [Hono](https://hono.dev) + [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| Validation | [valibot](https://valibot.dev) via `@hono/standard-validator` |
| HTTP client | axios |
| Language | TypeScript (strict) |
| Package manager | pnpm workspaces (11.17.0) with a shared dependency catalog |
| Deployment | Cloudflare Wrangler, custom domain `api.franciscosolis.cl` |
| Inter-service comms | Cloudflare Workers service bindings |

---

## 📋 Requirements

- **Node.js** (any version compatible with `wrangler` and `@cloudflare/workers-types`)
- **pnpm** `11.17.0` (declared in `package.json` as `packageManager`)
- **Git**, with submodule support (`apps/landing` is a git submodule)
- A **Cloudflare account** with Workers access for `dev`/`deploy`

---

## 🚀 Getting Started

### 1. Clone the repository (with submodules)

```bash
git clone --recurse-submodules git@github.com:Im-Fran/api.franciscosolis.cl.git
cd api.franciscosolis.cl
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

Both submodules (`apps/api`, `apps/landing`) are pinned via HTTPS URLs in `.gitmodules`
(not SSH), so Cloudflare's build environment can clone them without extra credentials.
Both the root repo and each submodule use `dev` as their default branch.

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

The `landing` Worker needs a GitHub token for its stats module. Copy the example dev-vars
file and fill it in:

```bash
cp apps/landing/.dev.vars.example apps/landing/.dev.vars
```

| Variable | Description | Where |
|----------|-------------|-------|
| `GH_TOKEN` | GitHub API token used by `apps/landing`'s `/stats/github` route | `apps/landing/.dev.vars` |

The `api` worker has no secrets of its own; it only needs the `LANDING` service binding,
which is wired up in `apps/api/wrangler.jsonc`.

### 4. Run in development

From the repo root, this runs every workspace app's `dev` script in parallel:

```bash
pnpm run dev
```

This starts:
- `api` on `http://localhost:8787` (inspector on port `9229`)
- `landing` on `http://localhost:8788` (inspector on port `9230`)

Each app can also be run individually from its own directory, e.g. `cd apps/api && pnpm run dev`.

---

## 🏗 Building for Production

There is no separate build step — Cloudflare Workers are deployed straight from TypeScript
source via Wrangler's own bundler as part of `deploy` (see below).

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
```

`apps/api/wrangler.jsonc` binds the custom domain `api.franciscosolis.cl` (zone
`franciscosolis.cl`) and a `LANDING` service binding pointing at the `landing` Worker, so the
`landing` Worker must be deployed under the name `landing` for the binding to resolve.

To regenerate Cloudflare binding types after editing `wrangler.jsonc`:

```bash
pnpm run cf-typegen
```

---

## ⚙️ Configuration

| File | Purpose |
|------|---------|
| `apps/api/wrangler.jsonc` | Routes, custom domain, `LANDING` service binding, observability sampling |
| `apps/landing/wrangler.jsonc` | Worker name/config for the `landing` service |
| `pnpm-workspace.yaml` | Workspace packages (`apps/*`, `packages/*`) and shared dependency catalog |

---

## 🤝 Contributing

1. Fork the repo (and its `apps/landing` submodule if you need to change it)
2. Create a branch: `git checkout -b feat/your-feature`
3. Commit: `git commit -m "feat: add your feature"`
4. Push and open a PR

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0** — see the
[LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE) file for details.

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
