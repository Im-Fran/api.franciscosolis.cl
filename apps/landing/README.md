<div align="center">

# 🏠 landing.franciscosolis.cl API

**Internal Cloudflare Worker that powers franciscosolis.cl's landing page: GitHub stats and site metadata, served over Hono.**

[![License](https://img.shields.io/github/license/Im-Fran/landing.franciscosolis)](LICENSE)

</div>

---

## 📖 Overview

This is the API behind the **franciscosolis.cl** landing page. It's a Cloudflare Worker
built with **Hono** that isn't exposed to the public internet directly — it's consumed by
the root [`api.franciscosolis.cl`](https://github.com/Im-Fran/api.franciscosolis.cl) Worker
through a Cloudflare **service binding**, and lives at `apps/landing` in that monorepo.

Right now its main job is fetching live GitHub statistics (commits, stars, profile info)
for the `Im-Fran` GitHub account, using the GitHub REST and GraphQL APIs, and exposing them
as clean JSON endpoints. It also publishes its own OpenAPI 3 spec, which the root API merges
into its combined documentation under the `/landing/*` prefix.

Input/output is validated with **valibot**, and the OpenAPI document is generated
automatically from those schemas via `hono-openapi` — no spec is hand-written or can drift
from the actual response shape.

---

## ✨ Features

- **GitHub stats endpoints** — `/stats/github/commits`, `/stats/github/profile`, and
  `/stats/github/stars`, all backed by a `GH_TOKEN` secret and the `Im-Fran` GitHub account.
  `/stats/github` itself lists the available endpoints.
- **Health check** — `GET /` returns a simple `{ code, data: { message } }` payload to
  confirm the Worker is up.
- **Auto-generated OpenAPI spec** — every route is described with `describeRoute` and a
  valibot schema, and exposed live at `/openapi.json` via `hono-openapi`.
- **Correct JSON charset** — a shared middleware appends `; charset=UTF-8` to
  `application/json` responses.
- **Typed error responses** — `onError` normalizes `HTTPException`s and unexpected errors
  into a consistent `{ code, error }` JSON body.
- **Star counting across all owned repos** — `getGitHubStars` paginates through every
  repository the user owns via GraphQL and sums `stargazers.totalCount`.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers |
| Framework | [Hono](https://hono.dev) |
| Validation | [valibot](https://valibot.dev) |
| OpenAPI generation | [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| HTTP client | [axios](https://axios-http.com) |
| Language | TypeScript |
| CLI / deploy | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) |
| License | GPL-3.0-only |

---

## 📋 Requirements

- **Node.js** with `pnpm` (the parent monorepo pins `pnpm@11.17.0`)
- A GitHub personal access token with read access, for `GH_TOKEN`
- A Cloudflare account (for `wrangler dev`/`deploy`)

---

## 🚀 Getting Started

This package lives inside the [`api.franciscosolis.cl`](https://github.com/Im-Fran/api.franciscosolis.cl)
pnpm workspace. Clone the repo, then work from here:

```bash
git clone https://github.com/Im-Fran/api.franciscosolis.cl.git
cd api.franciscosolis.cl
pnpm install
```

### Configure environment

```bash
cd apps/landing
cp .dev.vars.example .dev.vars
```

Then edit `.dev.vars` and fill in:

| Variable | Description |
|----------|-------------|
| `GH_TOKEN` | GitHub token used to call the REST and GraphQL APIs for `Im-Fran`'s stats |

### Run in development

```bash
pnpm run dev
```

This runs `wrangler dev --ip 0.0.0.0 --port 8788 --inspector-port 9230`, so the Worker is
available at [http://localhost:8788](http://localhost:8788).

### Generate/sync Cloudflare types

```bash
pnpm run cf-typegen
```

Regenerates the `CloudflareBindings` type from `wrangler.jsonc` so `Hono<{ Bindings: Env }>`
stays in sync with the actual bindings.

---

## 🌐 Deployment

```bash
pnpm run deploy
```

Runs `wrangler deploy --minify`. Observability (logs and traces, 25% sampling) is enabled
in `wrangler.jsonc`, along with smart placement and Workers' built-in edge cache.

In the parent monorepo, this Worker is bound to the root `api` Worker as a service binding
(`LANDING`), so it doesn't need its own public route beyond `workers.dev`.

---

## 📄 License

This project is licensed under **GPL-3.0-only** — see the [LICENSE](https://github.com/Im-Fran/landing.franciscosolis/blob/dev/LICENSE) file for details.

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
