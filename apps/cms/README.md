<div align="center">

# 📝 cms — Content Management

**Internal Cloudflare Worker behind `api.franciscosolis.cl/cms`: landing page content, legal pages and outgoing email, gated to `@franciscosolis.cl` accounts.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`cms` is what **franciscosolis.cl** is edited through. It is not exposed to the public internet
directly: the root gateway Worker (`apps/api`) reaches it through a Cloudflare **service binding**
and proxies `/cms/*`, so its public base URL is `https://api.franciscosolis.cl/cms`.

It owns three areas:

- **Landing page content** — projects, experience, skills, certifications and education, all in a
  single `content_entries` table discriminated by collection, with the collection-specific fields
  validated per collection.
- **Legal pages** — privacy policy, terms, cookies and so on, as documents with a version and an
  effective date.
- **Outgoing email** — ad-hoc or from a stored template, sent through **Cloudflare Email Sending**
  from the `mail.franciscosolis.cl` domain, with every attempt logged.

Reading published content is **public** — that is what the website itself calls. Everything under
`/admin` requires an access token issued by [`apps/auth`](../auth/README.md) for an
`@franciscosolis.cl` account.

---

## ✨ Features

- **One content model, many collections** — adding a collection is an entry in the registry
  (`src/lib/collections.ts`), not a migration. Shared columns cover title, slug, summary, body,
  status, ordering, dates, links and tags; a per-collection valibot schema validates the rest.
- **Strict content validation** — collection schemas are `strictObject`, so a misspelled field is
  a 422 instead of a typo silently stored in a JSON blob nobody reads again.
- **Draft / published / archived** — public routes only ever return `published` entries and 404
  everything else, so an unfinished draft is not even discoverable.
- **Manual ordering** — `position` first, then most recent, then title, with a bulk
  `POST /admin/content/:collection/reorder` for drag-and-drop front-ends.
- **Versioned legal pages** — `version` + `effective_at` alongside the body, so a published policy
  can say when it changed.
- **Email with templates** — `{{ variable }}` placeholders whose variable list is derived from the
  text itself, so the two can never drift. A send missing a value is refused rather than mailing a
  half-rendered message.
- **Sender allowlist, twice** — an editor may only pick from `MAIL_ALLOWED_SENDERS`, and
  Cloudflare independently enforces `allowed_sender_addresses` from `wrangler.jsonc`.
- **Full email log** — every message is written to `email_messages` before it is attempted and
  updated with the outcome, rendered body included.
- **Offline token verification** — EdDSA access tokens are checked against the auth Worker's
  published JWKS, cached per isolate, with an automatic refetch when a key rotates. No service
  binding back into `auth`, no per-request call.
- **Domain-gated access** — a verified email address on an allowed domain, plus an audience that
  matches this CMS. A perfectly valid token minted for the public website does not open this door.
- **Audit trail** — every editorial write lands in `audit_logs` with the editor's address.
- **Auto-generated OpenAPI** — every route is described with `describeRoute` + valibot, published
  at `/openapi.json` and merged into the gateway's combined document under `/cms/*`.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | [Hono](https://hono.dev) + [hono-openapi](https://www.npmjs.com/package/hono-openapi) |
| Validation | [valibot](https://valibot.dev) |
| Database | Cloudflare D1 (`franciscosolis_cms`) + [Drizzle ORM](https://orm.drizzle.team) |
| Email | [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/) |
| Auth | EdDSA JWTs from `apps/auth`, verified offline against its JWKS |
| Language | TypeScript (strict) |

---

## 🚀 Getting Started

Dependencies are installed from the **monorepo root** (`pnpm install`).

### 1. Create the database

```bash
pnpm exec wrangler d1 create franciscosolis_cms
```

Paste the printed `database_id` into `wrangler.jsonc` — it ships with a placeholder, and remote
deploys cannot bind the database until it is replaced.

### 2. Apply migrations

```bash
pnpm run db:migrate:local     # local development
pnpm run db:migrate:remote    # production
```

### 3. Point the Worker at a local auth service

```bash
cp .dev.vars.example .dev.vars
```

There are no secrets to fill in — the file only redirects `AUTH_JWKS_URL` and `AUTH_ISSUER` at the
local auth Worker so tokens minted locally are accepted.

### 4. Run it

```bash
pnpm run dev    # http://localhost:8790, inspector on 9232
```

From the monorepo root, `pnpm run dev` starts this Worker alongside `api`, `landing` and `auth`,
which is what the `/cms/*` proxy needs to have something to forward to.

---

## 🔐 Getting in

The CMS is registered in the auth database as the public client `franciscosolis-cms`
(`apps/auth/migrations/0002_cms_application.sql`). A front-end signs in with the standard
authorization code + PKCE flow against `https://api.franciscosolis.cl/auth`, asking for that
client id, and sends the resulting access token as `Authorization: Bearer <token>`.

Three conditions have to hold for a request to reach an admin route:

1. The token is valid, unexpired and signed by the configured issuer.
2. Its `aud` is listed in `CMS_ALLOWED_AUDIENCES` — a token minted for the public website is
   rejected here.
3. Its email address is **verified** and its domain is listed in `CMS_ALLOWED_EMAIL_DOMAINS`
   (`franciscosolis.cl`).

Because sign-up in `apps/auth` is invitation-only, a new editor also needs an invitation (or an
entry in `BOOTSTRAP_ADMIN_EMAILS`) before they can sign in at all.

The redirect URIs registered for the CMS client are placeholders until the front-end has a real
URL; update them with `PATCH /auth/admin/applications/franciscosolis-cms`.

---

## 📡 API

Paths below are relative to `https://api.franciscosolis.cl/cms`.

### Public

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Status and the list of collections |
| `GET` | `/collections` | Collections with their names and descriptions |
| `GET` | `/content/:collection` | Published entries (`featured`, `tag`, `search`, `limit`, `offset`) |
| `GET` | `/content/:collection/:slug` | A single published entry |
| `GET` | `/legal` | Published legal pages, without bodies |
| `GET` | `/legal/:slug` | A single published legal page |
| `GET` | `/openapi.json` | This Worker's OpenAPI document |

### Editorial (Bearer token required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/me` | The editor behind the current token |
| `GET` | `/admin/audit` | Trail of every write made through the CMS |
| `GET` | `/admin/content/:collection` | Entries in every state (`status`, `search`, `tag`) |
| `POST` | `/admin/content/:collection` | Create an entry |
| `POST` | `/admin/content/:collection/reorder` | Bulk-set `position` |
| `GET` | `/admin/content/:collection/:id` | A single entry by id |
| `PATCH` | `/admin/content/:collection/:id` | Update an entry |
| `DELETE` | `/admin/content/:collection/:id` | Delete an entry |
| `GET` | `/admin/legal` | Every legal page, drafts included |
| `POST` | `/admin/legal` | Create a legal page |
| `GET` `PATCH` `DELETE` | `/admin/legal/:id` | Read, update or delete a legal page |
| `GET` | `/admin/email-templates` | Templates with their variables |
| `POST` | `/admin/email-templates` | Create a template |
| `GET` `PATCH` `DELETE` | `/admin/email-templates/:id` | Read, update or delete a template |
| `POST` | `/admin/emails` | Send an email |
| `GET` | `/admin/emails` | Log of every send attempt |
| `GET` | `/admin/emails/:id` | A single logged message |

### Example — publish a project

```bash
curl -X POST https://api.franciscosolis.cl/cms/admin/content/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "api.franciscosolis.cl",
    "summary": "Monorepo of Cloudflare Workers behind the public API",
    "status": "published",
    "featured": true,
    "started_at": "2026-01-15",
    "tags": ["hono", "cloudflare"],
    "data": {
      "role": "Author",
      "technologies": ["Hono", "D1"],
      "repository_url": "https://github.com/Im-Fran/api.franciscosolis.cl"
    }
  }'
```

### Example — send a templated email

```bash
curl -X POST https://api.franciscosolis.cl/cms/admin/emails \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": ["someone@example.com"],
    "template": "contact-reply",
    "variables": { "name": "Ada", "topic": "the CMS" }
  }'
```

The response is `202` with the logged message; its `status` is `sent` or `failed`. A provider
failure is reported in the body rather than as an HTTP error, because the attempt was recorded
either way.

---

## 🧱 Content model

Every collection shares the same columns and differs only in its `data` blob:

| Collection | `data` fields |
|------------|---------------|
| `projects` | `role`, `client`, `technologies[]`, `repository_url`, `demo_url`, `highlights[]` |
| `experience` | `company`, `position`, `location`, `employment_type`, `company_url`, `achievements[]`, `technologies[]` |
| `skills` | `category`, `level` (1–5), `years_of_experience`, `icon` |
| `certifications` | `issuer`, `credential_id`, `credential_url`, `expires` |
| `education` | `institution`, `degree`, `field`, `location`, `institution_url` |

To add a collection, add an entry to `COLLECTIONS` in `src/lib/collections.ts` with its `data`
schema. No migration and no new route are needed — listings, validation and the OpenAPI document
pick it up from the registry.

---

## ⚙️ Configuration

All configuration lives in `wrangler.jsonc` under `vars`:

| Variable | Purpose |
|----------|---------|
| `AUTH_JWKS_URL` | JWKS the access tokens are verified against |
| `AUTH_ISSUER` | Expected `iss` claim; must match the auth Worker's issuer |
| `CMS_ALLOWED_AUDIENCES` | Client application ids whose tokens are accepted |
| `CMS_ALLOWED_EMAIL_DOMAINS` | Email domains allowed into the CMS |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Default sender identity |
| `MAIL_ALLOWED_SENDERS` | Addresses an editor may send as |

Bindings: `DB` (D1 `franciscosolis_cms`) and `EMAIL` (Cloudflare Email Sending, restricted by
`allowed_sender_addresses`).

---

## 🌐 Deployment

```bash
pnpm run deploy
pnpm run db:migrate:remote
```

This Worker must be deployed under exactly the name `cms` for the gateway's `CMS` service binding
to resolve. It needs no custom domain of its own — it is reached through
`api.franciscosolis.cl/cms`.

---

## 📄 License

Licensed under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).
