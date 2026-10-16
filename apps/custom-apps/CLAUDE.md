# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`custom-apps` is the Worker behind the bespoke apps built for clients. It has **two surfaces over one
D1 database**, chosen by hostname in `src/index.ts`:

- **Panel API** — reached through the gateway's `CUSTOM_APPS` binding at
  `api.franciscosolis.cl/custom-apps`, every route under `/v1`. Companies, contacts, apps, app keys,
  installations, telemetry views, audit log. Used by the panel at `franciscosolis.cl/custom-apps`.
- **Ingest** — `ingest.franciscosolis.cl/custom-apps/v1/:appId/*`, a zone route straight to this
  Worker. Enrollment, token refresh, heartbeat, status, metrics, events, the per-app `openapi.json`
  and `sdk.js`. Used by client apps only.

This is phase 1 of the custom-apps plan (CRM, inventory, enrollment, presence, telemetry, kill
switch). Releases/updates, remote commands, the socket presence mode, maintenance windows,
contracts, alerts and the secrets vault are later phases and build on this schema.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`franciscosolis_custom_apps`). Raw D1 statements where a batch mixes
  upserts, or a query is an aggregate Drizzle would only obscure (`services/rollup.ts`,
  `services/series.ts`, `services/telemetry.ts`, the heartbeat).
- **Cloudflare Queues**, producer *and* consumer of `franciscosolis-custom-apps-telemetry`.
- **Workers Rate Limiting** (`ratelimits`), an hourly **cron trigger**.
- No runtime dependency beyond the catalog's Hono/valibot/Drizzle; versions via `catalog:`.

## Commands (run from this directory, `apps/custom-apps/`)

- `pnpm run dev` → `wrangler dev` on :8796. Locally the ingest host is `127.0.0.1:8796` (see
  `.dev.vars.example`), because dispatch is by hostname.
- `pnpm run test` / `test:coverage` / `typecheck` / `build` / `build:dev`.
- `pnpm run db:generate` → `drizzle-kit generate`; `db:migrate:local` / `db:migrate:remote` /
  `db:migrate:list` (and `:dev`). Production migrations run from `.github/workflows/migrate.yml`.

## Source layout

- `src/index.ts` — `dispatch` (hostname → panel or ingest), the panel's `GET /` and
  `/openapi.json`, the shared error/charset conventions, and the `queue` and `scheduled` handlers.
- `src/panel/` — `index.ts` (the `/v1` gate and `/me`), `shared.ts`, `routes/` (`companies`,
  `contacts`, `apps` — keys, status, sdk, installations list, usage — `installations`, `overview` —
  overview and audit log).
- `src/ingest/index.ts` — every device route and the per-app documents.
- `src/middleware/` — `admin.ts` (`requireAdmin`), `installation.ts` (`requireInstallation`).
- `src/services/` — `enrollment.ts`, `presence.ts` (connected rule, heartbeat credit),
  `telemetry.ts` (device payload schemas, the queue message, the consumer), `rollup.ts` (daily
  roll-up, purge, the cron), `series.ts` (what the panel charts), `sdk.ts` (the `sdk.js` template),
  `apps.ts` (modules, current key, `buildSdk`), `serialize.ts` (rows → JSON), `audit.ts`.
- `src/lib/` — `config.ts` (every vocabulary and limit), `rut.ts`, `tokens.ts`, `time.ts`
  (Santiago wall clock), `validation.ts`, `validate.ts`, `jwks.ts`, `json.ts`, `errors.ts`.

## Architecture notes (non-obvious)

- **Dispatch is by hostname, and that is the separation.** A request whose host is
  `INGEST_PUBLIC_URL`'s reaches the ingest app with the base path stripped; anything else reaches the
  panel. A path can therefore never smuggle a panel request onto the ingest host or the reverse.
  The panel only accepts EdDSA JWTs; the ingest surface only opaque installation tokens — neither
  can even parse the other's credential. Keep them in separate Hono apps.
- **Enrollment is auto-approved by decision.** The app key is public (it ships in every build and in
  `sdk.js`), so it is stored in clear and shown in full. The defences are around enrollment:
  `ENROLL_IP_LIMITER` / `ENROLL_APP_LIMITER`, `needs_review` on every new installation, and a token
  good for one revocable installation. Revoking a key stops new enrollments only.
- **Device tokens are opaque and only their SHA-256 is stored**, unlike the app key. Every ingest
  request reads the installation's row anyway, and the hash lookup is what makes revocation
  immediate. Refresh rotates both tokens with a compare-and-swap on the old refresh hash; a device
  that loses the answer re-enrolls with its `device_id`, which finds the same row. A revoked row has
  its hashes nulled and refuses re-enrollment under the same `device_id` (403).
- **"Connected" is never stored.** It is `last_seen_at >= now - 3 × interval`, in JS
  (`isConnected`) and in SQL (`connectedSql`) — keep the two in step.
- **The heartbeat writes synchronously, metrics and events through the queue.** Presence must be
  current the moment the panel reads it, and the heartbeat's installation update and its
  `usage_hourly` upserts commit in one `DB.batch`. Bulk telemetry goes to the queue so the device is
  answered after validation alone. The consumer's inserts are `OR IGNORE` against natural keys
  (`(installation_id, recorded_at)`, `(installation_id, event_id)`), so redelivery writes nothing
  twice and a failing batch is simply retried. An unknown message shape is acknowledged, not retried.
- **A heartbeat credits the gap since the previous one, but only while still connected.** After a
  gap longer than the offline threshold nothing is credited — inventing time would turn every
  reconnect into phantom use. `active_seconds` is capped at the credited time and split across
  hours in proportion (`heartbeatCredit`).
- **Every measurement is nullable, and null means N/A.** Never coerce a missing value to 0.
- **The roll-up recomputes, it never accumulates.** `computeDaily` derives a Santiago day from the
  raw tables; `rollupDay` upserts it. The cron runs hourly (Chile has DST), purges every run, and at
  `ROLLUP.hour` rolls up yesterday *and the day before*. Panel reads compute today and yesterday live
  when no stored row exists, so the daily table is never behind.
- **Correlated subqueries name the outer column as `"apps"."id"`, never `${apps.id}`.** Drizzle
  renders a single-table column unqualified, and SQLite resolves a bare `"id"` to the inner table —
  a count that was silently wrong before this was caught.
- **`audit_logs` is append-only in the database** (two triggers in `0000_init.sql`, hand-added after
  the generated DDL). The test setup therefore never deletes from it; tests assert on rows of the
  resources they created.
- **`sdk.js` is deterministic** — no dates, no build ids — so `GET /v1/apps/:appId/sdk` can quote a
  stable SRI hash. Anything added to the template must keep that property.
- **Only `ping` presence exists.** `socket` arrives with remote commands (a Durable Object per
  installation); until then it is not in `PRESENCE_MODES`, so no app can be configured into a mode
  nothing answers.

## Testing

The suite runs against the top-level `wrangler.jsonc` (no named `test` environment). `AUTH` is stubbed
for the JWKS as in the other suites (`test/helpers/tokens.ts`); `TELEMETRY_QUEUE` is replaced by a
capture before every test (`test/helpers/telemetry.ts`) and tests hand what was sent to the consumer
with `drainTelemetry()` — the simulated queue would otherwise deliver to this Worker in the background
mid-assertion. The rate limiters are Miniflare's real ones; device requests use a random
`CF-Connecting-IP` so the per-IP limit only bites the test that means it to.
