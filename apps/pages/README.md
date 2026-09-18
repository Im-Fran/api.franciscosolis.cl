<div align="center">

# 📱 pages — Standalone App Pages

**Internal Cloudflare Worker behind `api.franciscosolis.cl/pages`: one product page per application built here, all to the same house standard — a banner, a tab bar, and the content behind it.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`pages` is where the applications built at **franciscosolis.cl** get a page of their own. It is not
exposed to the public internet directly: the root gateway Worker (`apps/api`) reaches it through a
Cloudflare **service binding** and proxies `/pages/*`, so its public base URL is
`https://api.franciscosolis.cl/pages`. The website renders it at
`franciscosolis.cl/application/<slug>`.

It exists so that a new application means a new row rather than a new site. An application page is
a banner, a handful of links and a subset of four tabs — Overview, Updates, Wiki and Contact — in
the order the application picked. Nothing else about the layout is configurable, which is the whole
point: a page built here looks like every other page built here.

Reading published pages is **public** — that is what the website itself calls, and those are the
only responses a shared cache is allowed to keep. Everything under `/admin` requires an access token
issued by [`apps/auth`](../auth/README.md) for an `@franciscosolis.cl` account. This Worker has no
front-end of its own: it is edited from a section of the CMS interface at
`franciscosolis.cl/cms/pages`, which is why the audience it accepts is the CMS's client id and why
there is no second application to register.

---

## ✨ Features

- **A tab registry, not a per-page layout** — `src/lib/tabs.ts` is the entire model. An application
  turns on the subset of tabs it wants, in an order; the day a page can describe its own shape, the
  set of pages stops being a house standard. `overview` is forced into the list and forced to the
  front, because every other tab is something a visitor reaches after deciding the application is
  for them.
- **Release notes ordered by release date** — `released_at`, never `created_at`, so writing three
  versions up in one sitting does not file them in typing order and back-dating a forgotten release
  does not silently put it on top. A version is free text (`2.6.4`, `v3`, `2026.1`, `1.0-beta` are
  all somebody's real version); what it may not contain is whitespace or a slash, because it is a
  path segment on the public route.
- **A wiki two levels deep, by rule** — a self-referencing column cannot express a depth limit, so
  `resolveParentId` enforces it: a parent in another application, a page as its own parent, a parent
  that is itself nested, and nesting a page that already has children are all 422s. Deleting a
  *section* promotes its children to the top level instead of taking the documentation with it.
- **Cascades where they belong** — this is the one schema in the monorepo with foreign keys. An
  update or a wiki page only means anything as part of one application, so `DELETE
  /admin/applications/:id` takes its contents with it. `parent_id` deliberately carries no such key.
- **Bilingual by override, not by row** — the row *is* the default locale (`en`) and a `translations`
  map holds `{"es":{"name":"…"}}` for the rest. Public reads take `?locale=es` and answer with the
  text already resolved, plus the `locale` that actually came back. Only prose is translated: tabs,
  slugs, ordering, versions and icons are the same fact in every language.
- **A closed link vocabulary** — eleven kinds (`website`, `github`, `app_store`, `play_store`,
  `sponsor`, … with `other` as the escape hatch), because the website renders an icon from `kind`
  and free text is a list of icons nobody can finish. At most 12 links per row, stored as JSON and
  replaced wholesale.
- **Drafts are invisible, not forbidden** — public routes only ever return `published` rows and 404
  everything else, including the updates and wiki of a draft application. A 403 would confirm the
  slug of an unannounced product. `published_at` is stamped once, the first time something goes
  live, and survives later unpublish/republish cycles.
- **Every nested route is scoped by its application** — `/admin/applications/:applicationId/…` is
  what stops an id from one application being read or deleted through another's URL.
- **Offline token verification** — EdDSA access tokens are checked against the auth Worker's
  published JWKS, cached per isolate for an hour, with one automatic refetch when a `kid` is
  unknown. The key set arrives over the `AUTH` service binding rather than a public fetch, because a
  Worker's subrequest to its own zone skips Workers routing and hits an origin that does not exist.
- **Redacted errors** — several `hono/jwt` errors embed the offending token in their message, and an
  unexpected Drizzle failure carries the full statement with its bound parameters. Token errors are
  described rather than echoed, and 5xx bodies are generic.
- **Audit trail** — every editorial write lands in `audit_logs` with the editor's address, readable
  at `GET /admin/audit`.
- **Auto-generated OpenAPI** — every route is described with `describeRoute` + valibot, published at
  `/openapi.json` and merged into the gateway's combined document under `/pages/*`.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | [Hono](https://hono.dev) + [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| Validation | [valibot](https://valibot.dev) |
| Database | Cloudflare D1 (`franciscosolis_pages`) + [Drizzle ORM](https://orm.drizzle.team) |
| Auth | EdDSA JWTs from `apps/auth`, verified offline against its JWKS |
| Tests | [Vitest](https://vitest.dev) in `workerd` via `@cloudflare/vitest-pool-workers` |
| Language | TypeScript (strict) |

---

## 🚀 Getting Started

Dependencies are installed from the **monorepo root** (`pnpm install`).

### 1. Apply migrations

The `franciscosolis_pages` D1 database already exists and its id is wired into `wrangler.jsonc`;
only the tables need creating.

```bash
cd apps/pages
pnpm run db:migrate:local    # the local Miniflare database used by `dev`
pnpm run db:migrate:list     # what is still pending on the remote one
```

`pnpm run db:generate` writes a new migration from `src/db/schema.ts` after a schema change.

### 2. Point the Worker at a local auth service

```bash
cp .dev.vars.example .dev.vars
```

There are no secrets to fill in — this Worker holds none. The file exists only to override
`AUTH_ISSUER` so a local Pages Worker trusts the tokens a local auth Worker stamps.

### 3. Run it

```bash
pnpm run dev
```

`wrangler dev --ip 0.0.0.0 --port 8792 --inspector-port 9233`, so the Worker answers at
[http://localhost:8792](http://localhost:8792). From the monorepo root, `pnpm run dev` starts every
Worker in parallel instead, which is what the `/pages/*` proxy and the `AUTH` binding need to
resolve locally.

```bash
pnpm run test          # vitest, inside workerd
pnpm run typecheck
```

---

## 📡 API

### Public

Unauthenticated, only ever `published` rows, and each takes an optional `?locale=en|es`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | The tabs, link kinds and locales this service publishes |
| `GET` | `/applications` | Published applications, without the tab bodies |
| `GET` | `/applications/:slug` | One page: banner, tabs, links, Overview and Contact |
| `GET` | `/applications/:slug/updates` | Release notes, newest release first |
| `GET` | `/applications/:slug/updates/:version` | One release note |
| `GET` | `/applications/:slug/wiki` | The sidebar, as a tree, without bodies |
| `GET` | `/applications/:slug/wiki/:page` | One wiki page with its Markdown |

### Editorial (Bearer token required)

An access token from the auth service, minted for the CMS client application and carrying a
verified `@franciscosolis.cl` address.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/admin/me` | Who the token belongs to |
| `GET` `POST` | `/admin/applications` | List / create an application |
| `POST` | `/admin/applications/reorder` | Reorder the list |
| `GET` `PATCH` `DELETE` | `/admin/applications/:id` | One application, contents included on delete |
| `GET` `POST` | `/admin/applications/:applicationId/updates` | List / add a release note |
| `GET` `PATCH` `DELETE` | `/admin/applications/:applicationId/updates/:id` | One release note |
| `GET` `POST` | `/admin/applications/:applicationId/wiki` | List (`?tree=true`) / add a page |
| `POST` | `/admin/applications/:applicationId/wiki/reorder` | Reorder the sidebar |
| `GET` `PATCH` `DELETE` | `/admin/applications/:applicationId/wiki/:id` | One wiki page |
| `GET` | `/admin/audit` | The trail of every write |

The full, always-current description is the OpenAPI document at
`https://api.franciscosolis.cl/openapi.json`.

---

## 🧱 The page model

| Tab | What it is | Where it lives |
|-----|-----------|----------------|
| **Overview** | One centred Markdown document. Always present. | A column on the row |
| **Updates** | Release notes, newest release first, with a version, a date and links. | `application_updates` |
| **Wiki** | Documentation with a sidebar, nested at most one level deep. | `application_wiki_pages` |
| **Contact** | How to reach support, as one Markdown document. | A column on the row |

Overview and Contact are columns because there is never more than one of either; Updates and Wiki
are tables because there are many. That asymmetry is exactly what the `source` field on a tab
definition tells a front-end. Bodies are capped at 200 000 characters for a page and 50 000 for a
release note — a changelog entry longer than that is a wiki page.

Alongside them, `audit_logs` records every write, and the whole schema lives in `src/db/schema.ts`
with its migrations generated by drizzle-kit into `migrations/`.

---

## ⚙️ Configuration

All configuration lives in `wrangler.jsonc` under `vars`:

| Variable | Purpose |
|----------|---------|
| `AUTH_JWKS_URL` | Path the JWKS is read from, over the `AUTH` binding (the host is a placeholder) |
| `AUTH_ISSUER` | Expected `iss` claim; must match the auth Worker's issuer exactly |
| `PAGES_ALLOWED_AUDIENCES` | Client application ids whose tokens may write here — the CMS's |
| `PAGES_ALLOWED_EMAIL_DOMAINS` | Email domains allowed to edit, matched on the full domain label |

Bindings: `DB` (D1 `franciscosolis_pages`) and `AUTH` (service binding to the auth Worker, used only
to read its published JWKS). There are no secrets: token verification needs public keys, not a
signing key, and this Worker is never an OAuth client of anything.

---

## 🌐 Deployment

```bash
cd apps/pages && pnpm run deploy
```

Migrations are not part of that: the repo's `Migrate` workflow applies them on a push to `dev` that
touches `migrations/`, and `pnpm run db:migrate:remote` is the manual fallback. See the root README
for the ordering caveat between the two.

The Worker must be deployed under the exact name `pages` for the gateway's `PAGES` service binding
to resolve. It needs no route or custom domain of its own — it is reached through
`api.franciscosolis.cl/pages`.

See [CLAUDE.md](./CLAUDE.md) for the design decisions worth not re-deriving.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
