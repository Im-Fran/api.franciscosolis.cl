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
  installations, telemetry views, commands and screenshots, flags and remote config, messages,
  crashes and logs, alert rules and alerts, audit log. Used by the panel at
  `franciscosolis.cl/custom-apps`.
- **Ingest** — `ingest.franciscosolis.cl/custom-apps/v1/:appId/*`, a zone route straight to this
  Worker. Enrollment, token refresh, heartbeat, the socket, status, metrics, events, logs, crashes,
  config, messages, command acknowledgements and screenshot uploads, the per-app `openapi.json` and
  `sdk.js`. Used by client apps only.

Phases 1 (CRM, inventory, enrollment, presence, telemetry, kill switch) and 2 (remote operation:
socket presence, commands and screenshots, flags and config, messages, logs, crashes, alerts,
automatic grace expiry) of the custom-apps plan. Releases/updates (phase 3), maintenance windows,
contracts, tickets, uptime and the secrets vault (phase 4) build on this schema.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`franciscosolis_custom_apps`). Raw D1 statements where a batch mixes
  upserts, or a query is an aggregate Drizzle would only obscure (`services/rollup.ts`,
  `services/series.ts`, `services/telemetry.ts`, the heartbeat).
- **Cloudflare Queues**, producer *and* consumer of `franciscosolis-custom-apps-telemetry`, and a
  producer of `franciscosolis-notifications` for alerts.
- **Durable Objects** (`InstallationSocket`, one per installation, WebSocket Hibernation) for socket
  presence, and **R2** (`SCREENSHOTS`) for screenshots.
- **Workers Rate Limiting** (`ratelimits`), a **cron trigger** every five minutes.
- No runtime dependency beyond the catalog's Hono/valibot/Drizzle; versions via `catalog:`.

## Commands (run from this directory, `apps/custom-apps/`)

- `pnpm run dev` → `wrangler dev` on :8796. Locally the ingest host is `127.0.0.1:8796` (see
  `.dev.vars.example`), because dispatch is by hostname.
- `pnpm run test` / `test:coverage` / `typecheck` / `build` / `build:dev`.
- `pnpm run db:generate` → `drizzle-kit generate`; `db:migrate:local` / `db:migrate:remote` /
  `db:migrate:list` (and `:dev`). Production migrations run from `.github/workflows/migrate.yml`.

## Source layout

- `src/index.ts` — `dispatch` (hostname → panel or ingest), the panel's `GET /` and
  `/openapi.json`, the shared error/charset conventions, the `queue` and `scheduled` handlers, and
  the `InstallationSocket` export the Durable Object binding resolves to.
- `src/panel/` — `index.ts` (the `/v1` gate and `/me`), `shared.ts`, `routes/` (`companies`,
  `contacts`, `apps` — keys, status, sdk, installations list, usage — `installations`, `overview` —
  overview and audit log — `remote` — commands, screenshots, flags, config, messages —
  `diagnostics` — crashes and logs — `alerts`).
- `src/ingest/index.ts` — every device route and the per-app documents.
- `src/middleware/` — `admin.ts` (`requireAdmin`), `installation.ts` (`requireInstallation`).
- `src/services/` — `enrollment.ts`, `presence.ts` (connected rule, heartbeat credit),
  `heartbeat.ts` (recording a heartbeat and the directives every answer carries, for both
  transports), `socket.ts` (the Durable Object and `syncApp` / `syncInstallation`), `commands.ts`,
  `remote-config.ts` (flag resolution, config versions, ETags), `messages.ts`, `targeting.ts` (the
  app / channel / installation scopes flags and messages share), `telemetry.ts` (device payload
  schemas — metrics, events, logs, crashes and the crash signature — the queue message, the
  consumer), `alerts.ts` (rule evaluation), `notify.ts` (the notifications-queue contract),
  `maintenance.ts` (the five-minute cron), `rollup.ts` (daily roll-up, purge — the hourly half),
  `series.ts` (what the panel charts), `sdk.ts` (the `sdk.js` template), `apps.ts` (modules, current
  key, `buildSdk`), `serialize.ts` (rows → JSON), `audit.ts`.
- `src/lib/` — `config.ts` (every vocabulary and limit), `json-schema.ts` (the config schema
  subset), `rut.ts`, `tokens.ts`, `time.ts` (Santiago wall clock), `validation.ts`, `validate.ts`,
  `jwks.ts`, `json.ts`, `errors.ts`.

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
- **"Connected" is never stored.** It is `last_seen_at >= now - 3 × interval`, unless a socket
  closed cleanly after the last heartbeat (`socket_closed_at >= last_seen_at`), in JS
  (`isConnected`), in SQL (`connectedSql`) and in the offline alert (`services/alerts.ts`) — keep the
  three in step. Opening a socket is not a sign of life by itself; the device's first heartbeat is.
- **Two transports, one heartbeat.** `POST /heartbeat` and a `heartbeat` frame on the socket both
  call `recordHeartbeat`, and both answer `directivesFor`: state, presence, outstanding commands and
  the `sync` tags. Anything new a device must be told goes there, once, and reaches both modes.
- **The Durable Object holds sockets and nothing else.** It is named by installation id, reached only
  through the ingest route after `requireInstallation` (the identity travels in headers that route
  sets, never read from the network), keeps everything in the socket attachment because it hibernates,
  and writes through the same D1 code as HTTP. One socket per installation (a new one closes the old
  with 4000); a revocation closes it with 4001. Panel writes push to sockets with `syncApp` /
  `syncInstallation` in `waitUntil` — never holding up the response, never failing it — and only to
  installations whose `socket_connected_at` is set, so no object is ever created just to find nobody
  home.
- **Commands are at-least-once.** Repeated in every answer until acknowledged or expired; the device
  deduplicates by id. The catalogue (`COMMAND_TYPES`) is closed on purpose — never add a command that
  runs arbitrary input on a client's device.
- **Screenshots are personal data.** Off per app by default (`screenshots_enabled`), switchable per
  installation, both checked when the command is sent *and* when the image arrives. Kept without
  expiry by decision, deletable one by one, never public: the panel streams them.
- **The config schema refuses what it cannot enforce.** `lib/json-schema.ts` implements a subset of
  JSON Schema and `checkSchema` rejects any other keyword, so a constraint can never look enforced
  without being so. Config versions are append-only; restoring saves the old document as the next
  version.
- **Flags and messages share one targeting rule** (`services/targeting.ts`): installation beats
  channel beats app. `scope_value` is `''` for the app scope so the unique index sees duplicates.
- **Crash groups count forever, reports age out.** The consumer counts a report into its group only
  if that report was never stored (`INSERT … SELECT … WHERE NOT EXISTS` before the report's `INSERT OR
  IGNORE`, in the same transaction — which is why the consumer chunks its batches by message). A
  report that occurred after a group was resolved reopens it; `ignored` stays ignored. The signature
  is the SHA-256 of the normalised top frames, so addresses and line numbers do not split a group.
- **Alerts reconcile, they do not fire.** Every five minutes each rule finds the subjects its
  condition holds for, and those are reconciled with the unresolved alerts (a partial unique index
  allows one per rule and subject): open and notify once, refresh, reopen within
  `ALERTS.reopenWithinMinutes` without notifying, or resolve. Notifications go to the rule creator's
  `sub` through `apps/notifications`; silencing stops those and nothing else.
- **A grace period ends on its own.** The cron suspends an app whose `grace` reached `state_until`,
  with an audit row that has no actor and `automatic: true`.
- **The heartbeat writes synchronously, metrics and events through the queue.** Presence must be
  current the moment the panel reads it, and the heartbeat's installation update, its
  `usage_hourly` upserts, its `heartbeat_log` row and its minute's sample commit in one `DB.batch`. Bulk telemetry goes to the queue so the device is
  answered after validation alone. The consumer's inserts are `OR IGNORE` against natural keys
  (`(installation_id, recorded_at)`, `(installation_id, event_id)`), so redelivery writes nothing
  twice and a failing batch is simply retried. An unknown message shape is acknowledged, not retried.
- **A heartbeat is logged in full and charted once a minute.** Every heartbeat goes into
  `heartbeat_log` (the audit record: arrival time, IP, version, reported and credited seconds,
  snapshot). Its snapshot becomes the `metric_samples` row of its minute, `source = 'heartbeat'`,
  keyed on the minute's start: later heartbeats in the same minute overwrite the gauges and *add* to
  the network counters, so a device heartbeating every few seconds still yields one point per
  minute. This is written synchronously in the heartbeat's batch, not through the queue, because
  "last" must mean last to arrive. `source` keeps these rows from ever colliding with `POST /metrics`
  samples (`source = 'batch'`), which stay at whatever resolution the device measured.
- **A heartbeat credits the gap since the previous one, but only while still connected.** After a
  gap longer than the offline threshold nothing is credited — inventing time would turn every
  reconnect into phantom use. `active_seconds` is capped at the credited time and split across
  hours in proportion (`heartbeatCredit`).
- **Every measurement is nullable, and null means N/A.** Never coerce a missing value to 0.
- **The roll-up recomputes, it never accumulates.** `computeDaily` derives a Santiago day from the
  raw tables; `rollupDay` upserts it. The cron runs every five minutes; its first run of each hour
  purges, and at `ROLLUP.hour` (Santiago, which has DST) rolls up yesterday *and the day before*. Panel reads compute today and yesterday live
  when no stored row exists, so the daily table is never behind.
- **Correlated subqueries name the outer column as `"apps"."id"`, never `${apps.id}`.** Drizzle
  renders a single-table column unqualified, and SQLite resolves a bare `"id"` to the inner table —
  a count that was silently wrong before this was caught.
- **`audit_logs` is append-only in the database** (two triggers in `0000_init.sql`, hand-added after
  the generated DDL). The test setup therefore never deletes from it; tests assert on rows of the
  resources they created.
- **`sdk.js` is deterministic** — no dates, no build ids — so `GET /v1/apps/:appId/sdk` can quote a
  stable SRI hash. Anything added to the template must keep that property.
- **A website always pings.** A browser cannot set the `Authorization` header on a WebSocket upgrade,
  so socket mode is for native apps and `sdk.js` never opens one.

## Testing

The suite runs against the top-level `wrangler.jsonc` (no named `test` environment). `AUTH` is stubbed
for the JWKS as in the other suites (`test/helpers/tokens.ts`); `TELEMETRY_QUEUE` is replaced by a
capture before every test (`test/helpers/telemetry.ts`) and tests hand what was sent to the consumer
with `drainTelemetry()` — the simulated queue would otherwise deliver to this Worker in the background
mid-assertion. `NOTIFICATIONS_QUEUE` is captured the same way (`test/helpers/notifications.ts`): its
consumer is another Worker. The Durable Object and R2 are Miniflare's real ones; `socket.test.ts`
opens genuine WebSockets through `SELF.fetch` with an `Upgrade` header. The rate limiters are Miniflare's real ones; device requests use a random
`CF-Connecting-IP` so the per-IP limit only bites the test that means it to.
