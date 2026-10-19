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
  crashes and logs, alert rules and alerts, releases and CI tokens, contracts, cycles and the work
  log, support tickets, audit log. Used by the panel at
  `franciscosolis.cl/custom-apps`. One route on this host takes no panel token: CI uploading a
  release (`src/panel/ci.ts`), mounted ahead of the `/v1` gate and accepting only a CI token.
- **Ingest** — `ingest.franciscosolis.cl/custom-apps/v1/:appId/*`, a zone route straight to this
  Worker. Enrollment, token refresh, heartbeat, the socket, status, metrics, events, logs, crashes,
  config, messages, command acknowledgements and screenshot uploads, the update offer, download
  links and update reports, support tickets, the per-app `openapi.json` and `sdk.js`. Used by client apps only.

Phases 1 (CRM, inventory, enrollment, presence, telemetry, kill switch), 2 (remote operation:
socket presence, commands and screenshots, flags and config, messages, logs, crashes, alerts,
automatic grace expiry) and 3 (releases: signed uploads from CI, channels and staged rollout, minimum
version, the A/B updater's offer and reports, automatic pause, rollback) of the custom-apps plan,
and the first part of phase 4: contracts with hours cycles, the work log, contract ends driving the
kill switch, and support tickets opened from inside the apps. Maintenance windows, site uptime and
the secrets vault (the rest of phase 4) build on this schema. The tickets are the owner's deliberate
exception to the repository's "support is plain email" rule (see the root CLAUDE.md): they belong to
the clients' apps and to this internal panel, never to the website.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`franciscosolis_custom_apps`). Raw D1 statements where a batch mixes
  upserts, or a query is an aggregate Drizzle would only obscure (`services/rollup.ts`,
  `services/series.ts`, `services/telemetry.ts`, the heartbeat).
- **Cloudflare Queues**, producer *and* consumer of `franciscosolis-custom-apps-telemetry`, and a
  producer of `franciscosolis-notifications` for alerts and support tickets.
- **Durable Objects** (`InstallationSocket`, one per installation, WebSocket Hibernation) for socket
  presence, and **R2** for screenshots (`SCREENSHOTS`) and release artifacts (`RELEASES`).
- **Cloudflare Email Sending** (`EMAIL`) and `@franciscosolis/emails` for one message only: the
  contract notice to a client. Prettier is aliased
  out of the bundle in `wrangler.jsonc` and `vitest.config.ts`, as in every Worker that sends mail.
- **Workers Rate Limiting** (`ratelimits`), a **cron trigger** every five minutes.
- No runtime dependency beyond the catalog's Hono/valibot/Drizzle and the workspace's `@franciscosolis/emails`; versions via `catalog:`.

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
  `diagnostics` — crashes and logs — `alerts`, `releases` — CI tokens, releases, rollout, reports —
  `contracts` — contracts, cycles, work log — `tickets` — the support inbox, replies, the assignee),
  `ci.ts` (the CI upload, outside the gate).
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
  key, `buildSdk`), `releases.ts` (the offer, rollout buckets, release stats, the pause rule, signature
  verification), `contracts.ts` (contract status, cycle sync, work log filing, notices, lapse and
  renewal, the cron's share), `tickets.ts` (the context a ticket captures, serializers, unread counts,
  the assignee's notifications), `mail.ts` (the `EMAIL` binding), `serialize.ts` (rows → JSON), `audit.ts`.
- `src/lib/` — `config.ts` (every vocabulary and limit), `json-schema.ts` (the config schema
  subset), `rut.ts`, `tokens.ts`, `time.ts` (Santiago wall clock), `semver.ts`, `download-tickets.ts`,
  `hours.ts` (cycle boundaries and the rollover arithmetic),
  `validation.ts`, `validate.ts`, `jwks.ts`, `json.ts`, `errors.ts`.

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
- **An alert outlives its rule.** `alerts.rule_id` is nullable with `ON DELETE SET NULL`, and each
  alert carries `rule_name` / `rule_kind`, copied from the rule when it opens. Deleting a rule — or an
  app, whose rules cascade — first runs `retireRuleAlerts`: the snapshot takes the rule's last name,
  and the unresolved alerts are resolved by the actor, since nothing would reconcile them again. Alert
  reads left-join the rule and fall back to the snapshot: such an alert answers `rule_id: null`,
  `rule_deleted: true`, `threshold: null`. Reconciliation only ever reads alerts by `rule_id`, so
  orphans never collide with a new rule's alerts.
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
- **Read the SQL drizzle-kit generates for a table rebuild.** `0005_alert_history_cancel_reason.sql`
  had to be hand-edited: the generated copy selected the new columns from the old table, which SQLite
  reads as string literals rather than an error. Nothing references `alerts`, so the drop is safe
  whether or not `PRAGMA foreign_keys=OFF` takes effect inside D1's transaction.
- **`audit_logs` is append-only in the database** (two triggers in `0000_init.sql`, hand-added after
  the generated DDL). The test setup therefore never deletes from it; tests assert on rows of the
  resources they created.
- **`sdk.js` is deterministic** — no dates, no build ids — so `GET /v1/apps/:appId/sdk` can quote a
  stable SRI hash. Anything added to the template must keep that property.
- **A release is one artifact on one line.** The line is (app, channel, platform, arch) and the
  version is unique on it. CI uploads a **draft**; only a person publishes.
  `draft → published ⇄ paused → withdrawn`, and only a draft is ever deleted — anything that was
  published may be installed somewhere and is history.
- **The upload is streamed, never buffered.** The body is the artifact (`curl --data-binary`), split
  with `tee()` into R2 (through a `FixedLengthStream` of the declared `Content-Length`, which R2
  needs) and `crypto.DigestStream`. A 96 MB installer never sits in the isolate's memory. Any refusal
  after the bytes landed deletes the object before answering.
- **The signature is over the SHA-256 digest, not the bytes**: Ed25519, base64, raw 32-byte digest,
  verified against the app's `release_public_key` (raw 32 bytes, base64) before the row exists. The
  private key never reaches this Worker — CI holds it — and a device verifies the same way after
  downloading, against the key built into the app. The server's check exists so a build the devices
  would refuse is never offered; it is not what the devices trust.
- **CI tokens are a third credential** (`cic_…`, SHA-256 stored like device tokens), scoped to one
  app and to the upload route only. Neither a panel token nor a device token can reach that route,
  and a CI token can reach nothing else.
- **The offer is computed, never stored** (`offerFor`): the newest published release of the device's
  line that its rollout reaches and that is newer than what it runs; `mandatory` below `min_version`;
  a device running a *withdrawn* version gets the newest earlier live one as a mandatory `rollback`,
  whatever that one's rollout says. Nothing during grace or suspension. The heartbeat answer carries
  only the summary (`directives.update`); the device asks `/updates/latest` for the rest. The
  architecture is normalised (`arm64` = `aarch64`) and `universal` / `any` builds match every arch.
- **Rollout buckets are stable**: SHA-256 of `appId:installationId`, mod 100. The devices in the first
  10 % of one release are the first 10 % of the next — known canaries, not a random handful each time.
  `rollout_installations` names devices reached whatever the percentage.
- **Downloads go through a signed ticket**, not the bearer token, because what fetches the bytes is
  often a platform downloader that will not carry an `Authorization` header. HMAC over the claims with
  `UPDATE_DOWNLOAD_SECRET`, 15 minutes, nothing stored. Without the secret the link route answers 503.
  The download answers `Range`.
- **The automatic pause is a pause, not a withdrawal.** The cron computes per-release stats (distinct
  devices per report status, devices that crashed on that version since publication) and pauses a
  published release whose rollback or crash rate passes the app's thresholds, with at least
  `RELEASES.pauseMinSample` devices behind the rate. Withdrawing would send every device back down;
  that is a person's decision. Resuming a release that is still past a threshold pauses it again on the
  next run, by design.
- **Contract dates are Santiago calendar days, hours are whole minutes.** `starts_on` / `ends_on`
  (inclusive) are `YYYY-MM-DD`, compared as strings; cycles are `[starts_on, ends_on)`. No float ever
  holds hours. Amounts are in the contract's currency (CLP or UF) and never converted here.
- **Cycles are anchored on the contract's start and synced lazily** (`syncCycles`): any read of a
  contract — or the cron — closes every cycle whose period ended and opens the one containing today.
  A monthly contract starting on the 31st renews on the last day of shorter months and comes back to
  the 31st (`addMonths` always counts from the anchor). Inserts are keyed on the cycle's start and
  closes on `status = 'open'`, so concurrent syncs are harmless. `starts_on` and `cycle_period` are
  frozen once a cycle exists.
- **A renewal after a mid-cycle end opens a short cycle** (`cycleOpeningOn`). A contract's last cycle
  is cut at `ends_on`, so once it is renewed the next cycle starts on a day that is not a boundary.
  It opens exactly there and runs to the next anchored boundary, so the anchor holds, with
  `included_minutes` prorated by days (`round(included × days / period days)`); the cycles after it
  are whole again. Mapping that day back to "the period containing it" finds the closed cycle it was
  meant to follow, which is how every read of a renewed contract once spun to
  `CONTRACTS.maxCyclesPerRun`; `syncCycles` now also stops whenever an opened cycle does not end
  after the latest one. A renewal (or any change of `ends_on`) while that cut cycle is still open does
  not need a short cycle at all: `followContractEnd` moves the open cycle's end to where its period
  now ends. `remaining_minutes` is never negative — what is over is `overage_minutes`.
- **Cancelling keeps the reason on the contract** (`cancel_reason`), as well as in the
  `contract.cancelled` audit row.
- **A closed cycle is final.** Closing computes the balance once (`closeCycle`): usage is drawn from
  the oldest carried minutes first, then the cycle's own; leftovers roll over only if the contract
  says so, expire past `rollover_max_cycles`, and are trimmed oldest-first above `rollover_max_minutes`;
  usage beyond everything available is overage, priced at `overage_rate` and charged in the next
  cycle. The next cycle's carried buckets are recomputed from the closed row, which is why the work
  log refuses (409) an entry dated inside a closed cycle — a late entry would change a balance another
  cycle was derived from. Log it on the current cycle instead.
- **A work log entry is filed, not assigned.** The contract covering its app (or, for company-wide
  work, the one contract covering the company) on its day, and the cycle that day falls in. Several
  candidates is a 422 asking for `contract_id`; none is valid — work outside any contract is kept,
  just not counted.
- **The end of a contract drives the kill switch, from the cron** (`runContracts`). Inside
  `notice_days` the client's billing/owner contacts are emailed (falling back to the primary contact,
  then anyone) and each covered app gets a warning message, once (`notice_sent_at`); a failed email
  leaves it unset so the next run retries. Past `ends_on` the covered apps go into grace until the end
  of the last grace day — or straight to suspension with no grace days — and the existing grace expiry
  suspends them later; `lapsed_at` makes it once. Renewing (`/renew`, or moving `ends_on` later)
  reactivates the apps in grace or suspended, ends the notices (`created_by = contract:<id>`) and lets
  the client be warned again. A contract with `auto_renew` is extended by `renewal_months` and never
  lapses. Cancelling stops new cycles and notices and leaves the apps alone.
- **Grace pauses updates and support unless the contract says otherwise** (`grace_allows`). The offer
  and the ticket routes check the lapsed contract of the app; an installation put in grace by hand has
  no contract behind it and gets neither.
- **Contract alerts are filed under an app**, because `alerts.app_id` is required: the rule's app, or
  the first app the contract covers. A contract that covers no app raises nothing.
- **Support tickets live in the panel, and nothing about them is mailed.** An app opens one
  (`POST /tickets`) with what the user typed; the device's facts, recent logs and open crashes are
  captured into `tickets.context` at that moment, so the ticket shows what the device looked like
  then, not now. The conversation is `ticket_messages`, both ways: the panel answers, the app reads it
  back (`GET /tickets/:id`, scoped to the installation that opened it — another's is a 404) and learns
  there is something to read from `sync.support_unread` in the heartbeat. `seen_at` on a message is
  the other side having read it; answering marks the requester's messages read. The status follows
  the conversation (a requester message → `open`, a reply → `pending` unless it resolves or closes;
  `closed` takes no more messages). `number` is assigned inside the insert
  (`MAX(number) + 1`), so it is unique without a counter table. The app's `support_assignee` —
  whoever turned the module on, or took the tickets over — hears about a new ticket and every
  requester message through `apps/notifications` (`custom_apps.ticket_opened` /
  `custom_apps.ticket_message`); with nobody assigned the tickets simply wait in the inbox. Hours
  spent on one are work log entries carrying `ticket_id`, and the ticket shows them in the work log's
  own shape (`toWorkLog`). Limits: five new tickets and thirty messages per installation per hour,
  refused with a `Retry-After` of the seconds until the oldest request leaves the hour.
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
`CF-Connecting-IP` so the per-IP limit only bites the test that means it to. `EMAIL` is replaced
by a capture before every test (`test/helpers/email.ts`, with `failEmail()` for the outage paths), so
no test sends mail — and the ticket tests assert that opening one sends none. Contract tests move the calendar by calling `runContracts(env, later)` with a
future instant, and give each company a RUT of its own.
