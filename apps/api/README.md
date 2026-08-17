<div align="center">

# 🌐 api — franciscosolis.cl Gateway

**Entry Worker (`api.franciscosolis.cl`) that exposes system status, aggregates the OpenAPI spec of its components, and proxies requests to the monorepo's other Workers via Service Bindings.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`api` is the root Worker of the [`api.franciscosolis.cl`](https://github.com/Im-Fran/api.franciscosolis.cl) monorepo. It's deployed on the `api.franciscosolis.cl` domain and acts as the **public gateway/entrypoint**: it doesn't implement any business logic of its own beyond a status endpoint, and instead forwards requests to the monorepo's internal Workers through [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/), merging their OpenAPI specs into a single document.

It's built with [Hono](https://hono.dev/) on [Cloudflare Workers](https://workers.cloudflare.com/), using `wrangler` for both local development and deployment. Three internal components are registered — `landing` (the landing site's Worker, at `apps/landing`), `auth` (centralized authentication, at `apps/auth`) and `cms` (content management, at `apps/cms`) — and they're declared as data in a single registry (`src/services.ts`), so adding a new internal module is one entry in that array rather than new code in the gateway.

## ✨ Features

- **Status endpoint (`GET /`)** — Returns a JSON payload with a greeting message and the list of available modules (`modules`).
- **Proxy to the `landing` Worker (`ALL /landing/*`)** — Forwards any HTTP method under `/landing/*` to the `landing` Worker through the `LANDING` binding, stripping the `/landing` prefix from the path before forwarding.
- **Proxy to the `auth` Worker (`ALL /auth/*`)** — Forwards the complete request (method, headers and body) to the `auth` Worker through the `AUTH` binding. Unlike the `landing` proxy it preserves every header, because the auth module records `CF-Connecting-IP` and `User-Agent` in its audit trail, and it forwards with `redirect: 'manual'` so the 302s carrying an authorization code reach the browser instead of being followed inside the Worker.
- **Proxy to the `cms` Worker (`ALL /cms/*`)** — Forwards the complete request to the `cms` Worker through the `CMS` binding. Like the `auth` proxy it preserves every header, because the CMS validates the `Authorization` token itself and records `CF-Connecting-IP` in its audit trail.
- **Aggregated OpenAPI (`GET /openapi.json`)** — Generates this API's own OpenAPI spec with `hono-openapi` and merges it (`mergeRemoteSpecs`) with the spec exposed by each internal component (`landing` under `/landing`, `auth` under `/auth`, `cms` under `/cms`). If an internal component doesn't respond, it's silently skipped from the merged spec instead of breaking the rest.
- **Locked-down CORS** — Only allows `GET`, `POST`, `PATCH`, `DELETE` and `OPTIONS` from `localhost:5173`, `*.franciscosolis.workers.dev`, and `*.franciscosolis.cl`; any other origin gets the response meant for `https://franciscosolis.cl`. The write verbs exist for the auth module's sign-in, token exchange and admin API.
- **Centralized error handling** — `app.onError` translates `HTTPException` (or any error) into a `{ code, error }` JSON body with the matching HTTP status.
- **JSON charset fix** — Middleware that forces `charset=UTF-8` on `application/json` responses, since Hono's `c.json()` doesn't include it by default (see the `ponytail` comment in `src/index.ts`).

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| HTTP framework | [Hono](https://hono.dev/) 4 |
| Validation / schemas | [Valibot](https://valibot.dev/) |
| API documentation | [hono-openapi](https://www.npmjs.com/package/hono-openapi) + `@valibot/to-json-schema` |
| Inter-service communication | Cloudflare Service Bindings (Fetcher) |
| Tooling | Wrangler 4, TypeScript (ESNext, strict) |
| Package manager | pnpm (workspace + catalog) |

## 📋 Requirements

- **Node.js** compatible with Wrangler 4 (recent LTS)
- **pnpm** `11.17.0` (defined in `packageManager` of the monorepo root `package.json`)
- **Wrangler** `^4.110.0` (installed as a devDependency, no global install required)
- A Cloudflare account with access to the project (Workers + Service Bindings) for `deploy`, and for the `LANDING` and `AUTH` bindings to resolve in production

## 🚀 Getting Started

This package is part of the `api.franciscosolis.cl` pnpm monorepo. Dependency installation happens from the **repo root**, not inside `apps/api`.

### 1. Clone the repository

```bash
git clone -b dev https://github.com/Im-Fran/api.franciscosolis.cl.git
cd api.franciscosolis.cl
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Run in development

From `apps/api/`:

```bash
pnpm dev
```

This runs `wrangler dev --ip 0.0.0.0 --port 8787 --inspector-port 9229`. The API is available at [http://localhost:8787](http://localhost:8787) (debug inspector on port `9229`).

> From the monorepo root, `pnpm dev` runs the `dev` script of **all** workspace apps (`apps/*`) in parallel, including `landing`, `auth` and `cms`, which is needed so the `/landing/*`, `/auth/*` and `/cms/*` proxies have something to forward to locally.

There's no separate `build` command: Wrangler compiles and bundles the Worker as part of `dev`/`deploy`.

## 🏗 Regenerating Binding Types

```bash
pnpm cf-typegen
```

Runs `wrangler types --env-interface CloudflareBindings`, regenerating types from the bindings defined in `wrangler.jsonc` (useful after adding a new Service Binding in `env.ts`/`wrangler.jsonc`).

## 🌐 Deployment

The Worker is deployed directly with Wrangler, no intermediate build step:

```bash
pnpm deploy
```

Runs `wrangler deploy --minify`, publishing the `api` Worker on the route configured in `wrangler.jsonc`:

- Custom domain: `api.franciscosolis.cl` (zone `franciscosolis.cl`)
- `workers_dev` enabled (also reachable via `*.workers.dev`)
- Observability enabled (logs and traces with a `head_sampling_rate` of `0.25`)
- Workers cache enabled

The service bindings (`services: [{ binding: "LANDING", service: "landing" }, { binding: "AUTH", service: "auth" }, { binding: "CMS", service: "cms" }]`) connect this Worker to the `landing`, `auth` and `cms` Workers deployed in the same Cloudflare account — the `/landing/*`, `/auth/*` and `/cms/*` proxies and the OpenAPI merge depend on those Workers being deployed and reachable under exactly those names.

## ⚙️ Configuration — Routing to a New Internal Module

Modules are declared as **data**, in the `SERVICE_MODULES` registry of `src/services.ts`. The proxy route, the `modules` list in `GET /`, the OpenAPI merge and the `Env` binding type are all derived from that array, so `src/index.ts` does not grow when a module is added.

To expose a new internal monorepo component behind this gateway:

1. Add the Service Binding in `wrangler.jsonc` (`services: [...]`) pointing to the target Worker's name.
2. Add an entry to `SERVICE_MODULES` in `src/services.ts`:

```ts
{
  name: 'blog',            // mounts ALL /blog/*, and merges its spec under /blog
  binding: 'BLOG',         // the binding declared in wrangler.jsonc
  tag: 'Blog',             // OpenAPI tag for the proxy route
  description: 'Proxy to the blog Worker',
  // Optional, both omitted by default:
  //   forwardHeaders: ['Content-Type', 'Authorization']  → only these headers cross the binding
  //   redirect: 'manual'                                 → pinned on the forwarded Request
}
```

That's it — there's no third step. Omitting `forwardHeaders` forwards the caller's request as it stands (method, headers and body), which is what a module needs when it validates the `Authorization` header itself or records `CF-Connecting-IP`/`User-Agent` in an audit trail. `test/unit/services.test.ts` fails if the entry names a binding that `wrangler.jsonc` doesn't declare.

There are no environment variables (`.env`) in this app: all infrastructure configuration lives in `wrangler.jsonc` (bindings, domain, observability) and is resolved at deploy time by Cloudflare.

## 🤝 Contributing

This package is managed from the monorepo root. Follow the standard flow: fork, `feat/...` branch, descriptive commit, and PR against `dev` (this repo's main branch).

## 📄 License

This project is licensed under **GPL-3.0-only** — see the [LICENSE](https://github.com/Im-Fran/api.franciscosolis/blob/dev/LICENSE) file for details.

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
