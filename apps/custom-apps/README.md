<div align="center">

# 🛰️ custom-apps — Bespoke Apps Panel

**Internal Cloudflare Worker behind `api.franciscosolis.cl/custom-apps` and `ingest.franciscosolis.cl/custom-apps`: the clients, the apps built for them, every installation of those apps and what each one reports.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`custom-apps` is how the apps built to order for clients — POS terminals, kiosks, desktop and
Android apps, websites — are kept running after they ship. It has **two front doors over one
database**, and which one a request came through is decided by its hostname:

- **The panel API.** Not exposed to the public internet directly: the root gateway (`apps/api`)
  reaches it through a Cloudflare **service binding** and proxies `/custom-apps/*`, so its public
  base URL is `https://api.franciscosolis.cl/custom-apps`. Every route is under `/v1`, gated to one
  account: a token minted for the `franciscosolis-custom-apps` application, a verified
  `@franciscosolis.cl` address and the `custom-apps:admin` permission. The panel itself lives on
  the website at `franciscosolis.cl/custom-apps`.
- **The ingest surface.** What the client apps talk to, at
  `https://ingest.franciscosolis.cl/custom-apps/v1/<appId>` — a zone route straight to this Worker,
  never through the gateway. It accepts installation tokens and nothing else; the panel accepts
  access tokens and nothing else.

This is phase 1 of the plan: the CRM, the inventory of apps and installations, enrollment, presence,
telemetry and the kill switch. Releases and remote updates, remote commands, maintenance windows,
contracts and the secrets vault build on the same model and are not here yet.

---

## ✨ Features

- **A small CRM** — companies (a business or a natural person, with a RUT validated by its modulo-11
  check digit and stored in one canonical form so `12.345.678-5` and `123456785` collide), contacts
  with several addresses and phones, and a many-to-many link carrying each contact's roles at each
  company (`owner`, `technical`, `billing`, `maintenance_approver`) and at most one primary contact.
- **Company → app → installation** — an app belongs to a company, and every device (or browser) it
  runs on is an installation with its own token, version, channel and telemetry. Deleting along that
  axis is *refused* while something hangs off it, so removing a client never takes its fleet with it.
- **Auto-approved enrollment, defended around rather than in front** — anybody holding an app's
  public key (`cak_…`) can enroll a device, so enrollment is rate limited per IP and per app, every
  new installation is flagged for review, and what it gets is a token for exactly one revocable
  installation. Re-enrolling with the same `device_id` recovers the same installation; a revoked one
  can never come back under it.
- **Opaque device tokens, stored as hashes** — access (`cat_…`, 24 hours) and refresh (`car_…`,
  180 days, rotated on every use). Every request looks its installation up by the token's SHA-256,
  which is what makes a revocation take effect on the very next request.
- **Presence without a stored flag** — "connected" is `last_seen_at` within three heartbeat
  intervals, computed when somebody asks, so a device that simply stops talking reads as gone on its
  own. Each heartbeat credits the time since the last one, split across the UTC hours it spans, as
  online and as in use.
- **Telemetry where N/A means N/A** — every measurement is nullable, because a browser reports
  none of the system ones and a desktop most; a value a platform cannot measure is never a zero.
  Metrics and usage events go through a Cloudflare Queue to D1, with natural keys that make a
  redelivered batch insert nothing twice.
- **Thirty days raw, the summary forever** — an hourly cron purges raw samples and events past
  retention, and at 03:00 Santiago time rolls each installation's day into averages, maxima,
  95th percentiles, network totals and hours online and in use. A roll-up recomputes its day rather
  than adding to it, and the day before is rolled up again for devices that flushed late.
- **A usage heatmap for planning maintenance** — weekday × hour in Santiago time, averaged over
  every occurrence of that hour in the last 30 days, so an hour nobody used is a zero rather than a
  gap.
- **The kill switch** — `active`, `grace`, `maintenance` or `suspended`, per app and overridable per
  installation, answered on every heartbeat and on `/status`.
- **Per-app documents** — each app gets its own `openapi.json`, filtered to the modules it has
  enabled, and websites get a generated `sdk.js` with the app's id, key and modules baked in. The
  script is deterministic, so the panel quotes a Subresource Integrity hash that pins it.
- **An append-only audit trail, enforced by the database** — triggers abort any `UPDATE` or
  `DELETE` on `audit_logs`. Edits carry `{ before, after }` with only the fields that changed, and
  what a device did is recorded with no actor.

---

## 🛠 Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | [Cloudflare Workers](https://developers.cloudflare.com/workers/) |
| HTTP | [Hono](https://hono.dev) |
| Schemas & docs | [valibot](https://valibot.dev) + [hono-openapi](https://github.com/rhinobase/hono-openapi) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) via [Drizzle ORM](https://orm.drizzle.team) |
| Telemetry writes | [Cloudflare Queues](https://developers.cloudflare.com/queues/) |
| Abuse limits | [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| Tooling | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) + [Vitest](https://vitest.dev) |

---

## 📋 Requirements

Beyond a `pnpm install` at the monorepo root, this Worker needs things that live in the Cloudflare
account and in `apps/auth` rather than in this directory — twice, once per environment:

- A **D1 database**: `franciscosolis_custom_apps` (and `franciscosolis_custom_apps_dev`). Their ids
  go into `wrangler.jsonc`, replacing the placeholders committed there.
- A **queue**: `franciscosolis-custom-apps-telemetry` (and `franciscosolis-custom-apps-telemetry-dev`).
- A **proxied DNS record** for `ingest` (and `ingest-dev`) in the `franciscosolis.cl` zone, so the
  zone routes have a hostname to match.
- The **`franciscosolis-custom-apps` client application** and the `custom-apps:admin` permission,
  which `apps/auth`'s `0013_custom_apps_application.sql` registers, granted to the panel's owner.

---

## 🚀 Getting Started

```bash
pnpm install                                   # from the monorepo root
cp apps/custom-apps/.dev.vars.example apps/custom-apps/.dev.vars
cd apps/custom-apps
pnpm run db:migrate:local
pnpm run dev
```

The panel answers on `http://localhost:8796` (and through the gateway on
`http://localhost:8787/custom-apps` when `apps/api` is running too); the ingest surface on
`http://127.0.0.1:8796/custom-apps/v1/<appId>`, because it is told apart by hostname.

---

## 📡 Panel API

### Public

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | The vocabularies the panel builds its forms from, the ingest base URL and the retention |
| `GET` | `/openapi.json` | This Worker's panel document |

### Panel (Bearer token for `franciscosolis-custom-apps` with `custom-apps:admin`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v1/me` | The account behind the token |
| `GET` | `/v1/overview` | Fleet counts, apps by state, latest enrollments and what waits for review |
| `GET` / `POST` | `/v1/companies` | List (`?search`) and create |
| `GET` / `PATCH` / `DELETE` | `/v1/companies/:companyId` | One company with its contacts and apps; delete refused while it has apps |
| `GET` | `/v1/companies/:companyId/contacts` | Its contacts with their roles |
| `PUT` / `DELETE` | `/v1/companies/:companyId/contacts/:contactId` | Link with roles (and `is_primary`), or unlink |
| `GET` / `POST` | `/v1/contacts` | List (`?search`, `?company_id`) and create |
| `GET` / `PATCH` / `DELETE` | `/v1/contacts/:contactId` | One contact with the companies they belong to |
| `GET` / `POST` | `/v1/apps` | List (`?company_id`, `?state`, `?kind`, `?search`) and create, with its first key |
| `GET` / `PATCH` / `DELETE` | `/v1/apps/:appId` | One app; delete refused once anything enrolled |
| `PUT` | `/v1/apps/:appId/status` | The kill switch: state, message, until |
| `GET` / `POST` | `/v1/apps/:appId/keys` | Keys, shown in full; add one |
| `POST` | `/v1/apps/:appId/keys/:keyId/rotate` · `/revoke` | Replace or retire a key |
| `GET` | `/v1/apps/:appId/sdk` | The `sdk.js` URL and its integrity hash |
| `GET` | `/v1/apps/:appId/installations` | `?status`, `?needs_review`, `?connected`, `?search` |
| `GET` | `/v1/apps/:appId/usage` · `/usage/heatmap` | Daily fleet usage; the weekday × hour heatmap |
| `GET` / `PATCH` | `/v1/installations/:installationId` | Live view; alias, channel, per-installation state override |
| `POST` | `/v1/installations/:installationId/review` · `/revoke` | Confirm a new device; revoke one for good |
| `GET` | `/v1/installations/:installationId/metrics` · `/metrics/daily` · `/events` | Downsampled series, daily roll-up, usage events |
| `GET` | `/v1/audit-log` | `?event` (a trailing `.` matches a family), `?resource_type`, `?resource_id`, `?actor`, `?from`, `?to` |

The full, always-current description is the OpenAPI spec at
`https://api.franciscosolis.cl/openapi.json`, where this document is merged under `/custom-apps`.

---

## 📲 Ingest API

Base: `https://ingest.franciscosolis.cl/custom-apps/v1/<appId>`. There is no SDK for the Rust apps
by decision: each integrates the routes it needs from its app's own `openapi.json`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/openapi.json` · `/sdk.js` | The app's own documents; public |
| `POST` | `/enroll` | `app_key`, `device_id`, `platform` and what the device knows about itself → tokens |
| `POST` | `/token/refresh` | Rotate both tokens; on a 401, enroll again with the same `device_id` |
| `POST` | `/heartbeat` | Every `presence.interval_seconds`: `active_seconds`, `app_version`, a light `snapshot` |
| `GET` | `/status` | The state to obey, read on start-up |
| `POST` | `/metrics` | Up to 100 samples (module `metrics`) |
| `POST` | `/events` | Up to 100 usage events (module `events`) |

A device should keep its tokens in the platform's secure store, ask `/status` on start-up, queue
metrics and events locally while offline and send them when the network is back.

---

## ⚙️ Configuration

| Variable | Purpose |
| --- | --- |
| `AUTH_JWKS_URL` | Path the auth Worker's key set is read from, over the `AUTH` binding |
| `AUTH_ISSUER` | Expected `iss` claim. Must match `apps/auth` exactly |
| `CUSTOM_APPS_ALLOWED_AUDIENCES` | Client ids whose tokens may use the panel — its own only |
| `CUSTOM_APPS_ALLOWED_EMAIL_DOMAINS` | Domains allowed in, under the permission |
| `INGEST_PUBLIC_URL` | Base of the ingest surface; its host is what requests are dispatched on |

Bindings: `DB` (D1), `AUTH` (service binding, read for its JWKS only), `TELEMETRY_QUEUE` (producer
and consumer of the same queue), `ENROLL_IP_LIMITER`, `ENROLL_APP_LIMITER` and `INGEST_LIMITER`
(rate limits), the ingest zone route and an hourly cron. There are no secrets.

---

## 🌐 Deployment

```bash
wrangler d1 create franciscosolis_custom_apps                # and _dev; ids into wrangler.jsonc
wrangler queues create franciscosolis-custom-apps-telemetry  # and -dev
cd apps/custom-apps && pnpm run deploy
```

The Worker must be deployed as `custom-apps` for the gateway's `CUSTOM_APPS` binding to resolve —
**before** the gateway change that binds it — and after `auth`, which it binds. Migrations are
applied by the repository's `Migrate` workflow on a push to `dev`; `pnpm run db:migrate:remote` is
the manual fallback.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
