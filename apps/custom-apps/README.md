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

Phases 1 to 3 of the plan are here: the CRM, the inventory of apps and installations, enrollment,
presence, telemetry and the kill switch; remote operation — socket presence, commands and
screenshots, feature flags and remote config, in-app messages, remote logs, crash reports and alerts;
and releases — signed builds uploaded from CI, channels, staged rollout, a minimum version, the
offer an A/B updater installs from, its reports, the automatic pause and rollback. From phase 4,
contracts are here — hours per cycle with rollover and overage, the work log, the end of a contract
driving the kill switch — and support tickets opened from inside the apps. Maintenance windows, site uptime and the
secrets vault build on the same model and are not here yet.

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
- **Every heartbeat audited, one point per minute charted** — each heartbeat is kept as it arrived
  in `heartbeat_log`, while only the last one of each minute becomes a metric sample (network
  counters are summed across the minute). A device that heartbeats every few seconds leaves a full
  trail and still draws one point a minute.
- **Thirty days raw, the summary forever** — an hourly cron purges raw samples and events past
  retention, and at 03:00 Santiago time rolls each installation's day into averages, maxima,
  95th percentiles, network totals and hours online and in use. A roll-up recomputes its day rather
  than adding to it, and the day before is rolled up again for devices that flushed late.
- **A usage heatmap for planning maintenance** — weekday × hour in Santiago time, averaged over
  every occurrence of that hour in the last 30 days, so an hour nobody used is a zero rather than a
  gap.
- **The kill switch** — `active`, `grace`, `maintenance` or `suspended`, per app and overridable per
  installation, answered on every heartbeat and on `/status`. A grace period carries its end (at most
  31 days ahead), and the cron suspends the app when it passes, recorded in the audit trail with no
  actor.
- **Two presence modes, one rule** — `ping` (`POST /heartbeat` every interval) or `socket`: a
  WebSocket to `GET /socket` held by a Durable Object per installation with the Hibernation API, so an
  idle kiosk costs nothing between messages. The device sends the same heartbeats down the socket,
  and whatever the panel changes for it — a command, the state, config, messages, its log level — is
  pushed the moment it is saved instead of on the next heartbeat. "Connected" is the same rule in
  both modes, plus one thing only a socket can tell: a clean close reads as offline at once.
- **Every heartbeat answer is the device's to-do list** — the state to obey, the presence settings,
  the commands it has not acknowledged, and the tags of its config and messages, so it refetches
  those only when they changed (`GET /config` and `GET /messages` answer `ETag`s and 304s).
- **Remote commands from a closed catalogue** — restart the app, restart a kiosk, reload config,
  clear the cache, take a screenshot, upload logs, check for updates. Nothing else can be sent, so
  the panel never runs arbitrary code on a client's device. A command is repeated in every answer
  until acknowledged, expires (an hour by default, a week at most) and is audited.
- **Screenshots, off until a contract says otherwise** — asked for by command, uploaded as the
  image itself, kept in a private R2 bucket without expiry and served to the panel through the
  Worker. Both the app and the device must allow them, since a screen can show a client's own
  customers, and any one of them can be deleted.
- **Feature flags and a versioned remote config** — a flag is a boolean, a variant or a number for
  the whole app, one channel or one installation, the most specific winning per device. The config
  is one JSON document per app, validated against a schema in a strict subset of JSON Schema (a
  keyword outside it is refused, not ignored), saved as numbered versions that are never deleted,
  with optimistic concurrency and restore-as-next-version.
- **In-app messages** — banners and modals with a severity, a window and a target, each confirmed by
  the device that showed it.
- **Remote logs and grouped crashes** — logs at or above a level set per app and per device (the
  server drops the rest too); crashes grouped by the normalised top frames of their stack and by
  version, counted forever, reopened when a report arrives after the group was resolved. Both kept
  raw for 30 days.
- **Alerts** — rules on one app or every app: an installation offline for X minutes, CPU or memory
  held above a threshold, and spikes of crashes, error logs or enrollments. Evaluated every five
  minutes; one alert per rule and subject while it holds, reopened rather than repeated when it
  flaps, resolved on its own when the condition clears. The rule's creator is told through the
  notification centre (`apps/notifications`), in the bell, by push and by email as their preferences
  say; a silenced rule keeps recording and stops telling.
- **Signed releases from CI** — CI uploads a build with a token of its own (`cic_…`, one app, the
  upload route and nothing else), the artifact as the request body and an Ed25519 signature over
  its SHA-256 digest in a header. The body is streamed into a private R2 bucket and through SHA-256
  at once, the signature is checked against the app's release public key, and a build that fails is
  deleted before it is ever recorded. It lands as a draft; a person publishes it.
- **Channels, lines and staged rollout** — a release is one artifact for one channel, platform and
  architecture (`arm64` and `aarch64` are the same line; `universal` builds fit all). Publishing
  starts at a percentage and can name devices to reach first; a device's bucket is stable across
  releases, so the same kiosks are always the canaries. A minimum version makes the update
  mandatory for devices below it.
- **An offer the updater can trust** — every heartbeat answer says whether there is an update;
  `/updates/latest` carries the hash, the signature, the health-check timeout and the failure budget
  the A/B updater needs, and downloads go through a 15-minute signed link that serves ranges, so a
  platform downloader without the bearer token can fetch and resume them. The device reports
  `downloaded`, `installed`, `health_ok`, `rolled_back` or `failed`.
- **Pause and rollback** — the cron pauses a release whose devices roll back or crash past the app's
  thresholds (with a minimum sample, so one kiosk is not a trend); withdrawing a release sends every
  device on it back to the previous version as a mandatory rollback, and rolling a line back
  withdraws everything newer in one step. A `release_rollbacks` alert rule tells somebody.
- **Contracts and hours** — a contract belongs to a company and covers some of its apps (one
  contract per app at a time), priced in CLP or UF. It includes minutes of maintenance and support
  per cycle — daily, weekly or monthly, anchored on its start date — and, if it says so, unused
  minutes roll over, with a cap in minutes and in cycles; what is used beyond everything available
  is overage, priced at the contract's hourly rate and charged in the next cycle. Cycles open and
  close with the calendar, and a closed cycle is final.
- **The work log (bitácora)** — hours entered by hand against a company and optionally one of its
  apps, each filed under the contract and cycle of its day, with a link to the commit or merge
  request. Work outside any contract is still logged; a day in a closed cycle is refused.
- **The end of a contract drives the kill switch** — before a contract that does not renew itself
  ends, the client's billing contacts are emailed and the covered apps show a notice; when it
  lapses, the apps go into grace for the contract's grace days (or straight to suspension), with
  only what the contract keeps running — updates or support — besides the app itself. Renewing
  brings them back at once; a contract that renews itself is simply extended. `contract_expiring`
  and `cycle_hours_low` alert rules watch both.
- **Support tickets** — the `support` module lets an app open a ticket from its own support screen
  (`POST /tickets`, and `FSCustomApps.openTicket()` on websites) with the device attached: version,
  system, last contact, recent logs and open crashes. The conversation lives in the panel's inbox and
  goes both ways — the app reads the answers and can write again, and a heartbeat tells it how many
  answers it has not read. Whoever turned support on (or took it over) is told about new tickets and
  messages in the website's bell; nothing is emailed. Work logged against a ticket shows on it.
- **Per-app documents** — each app gets its own `openapi.json`, filtered to the modules it has
  enabled, and websites get a generated `sdk.js` with the app's id, key and modules baked in — which,
  with the matching modules, also reports uncaught errors as crashes, sends logs, keeps the flags and
  config, exposes the running messages and runs the commands a browser can. The script is
  deterministic, so the panel quotes a Subresource Integrity hash that pins it.
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
| Telemetry writes, alert notifications | [Cloudflare Queues](https://developers.cloudflare.com/queues/) |
| Socket presence | [Durable Objects](https://developers.cloudflare.com/durable-objects/) with WebSocket Hibernation |
| Screenshots, release artifacts | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| Contract notices | [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/) + [`@franciscosolis/emails`](../../packages/emails/README.md) |
| Abuse limits | [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| Tooling | [Wrangler](https://developers.cloudflare.com/workers/wrangler/) + [Vitest](https://vitest.dev) |

---

## 📋 Requirements

Beyond a `pnpm install` at the monorepo root, this Worker needs things that live in the Cloudflare
account and in `apps/auth` rather than in this directory — twice, once per environment:

- A **D1 database**: `franciscosolis_custom_apps` (and `franciscosolis_custom_apps_dev`). Both
  exist and their ids are in `wrangler.jsonc`; recreating one means replacing its id there.
- A **queue**: `franciscosolis-custom-apps-telemetry` (and `franciscosolis-custom-apps-telemetry-dev`).
  It also produces to `franciscosolis-notifications` (and `-dev`), which `apps/notifications` owns.
- Two **R2 buckets**: `franciscosolis-custom-apps-screenshots` and
  `franciscosolis-custom-apps-releases` (and their `-dev` copies), with no public access and no custom
  domain.
- A **secret**: `UPDATE_DOWNLOAD_SECRET`, per environment, which signs download links. Without it
  devices get a 503 when they ask for one.
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
| `GET` | `/v1/overview` | Fleet counts, apps by state, unresolved alerts, latest enrollments and what waits for review |
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
| `GET` / `PATCH` | `/v1/installations/:installationId` | Live view; alias, channel, state override, log level override, screenshots |
| `POST` | `/v1/installations/:installationId/review` · `/revoke` | Confirm a new device; revoke one for good |
| `GET` | `/v1/installations/:installationId/metrics` · `/metrics/daily` · `/events` | Downsampled series, daily roll-up, usage events |
| `GET` | `/v1/installations/:installationId/heartbeats` | Every heartbeat as it arrived (`?from`, `?to`), newest first |
| `GET` / `POST` | `/v1/installations/:installationId/commands` | Commands sent and their results; send one |
| `POST` | `/v1/commands/:commandId/cancel` | Withdraw one not yet answered |
| `GET` | `/v1/installations/:installationId/screenshots` | Screenshots, newest first |
| `GET` / `DELETE` | `/v1/screenshots/:screenshotId/image` · `/v1/screenshots/:screenshotId` | The image; delete one |
| `GET` / `POST` | `/v1/apps/:appId/flags` | Flags at every scope; set one |
| `PATCH` / `DELETE` | `/v1/flags/:flagId` | Change a value; remove it |
| `GET` / `PUT` | `/v1/apps/:appId/config` | The current document and schema; save a new version (`base_version` for concurrency) |
| `GET` | `/v1/apps/:appId/config/history` | Every version |
| `POST` | `/v1/apps/:appId/config/history/:version/restore` | Save an old version as the next |
| `GET` / `POST` | `/v1/apps/:appId/messages` | `?status=active\|scheduled\|ended`; create one |
| `PATCH` / `DELETE` | `/v1/messages/:messageId` | Edit or end; delete |
| `GET` | `/v1/messages/:messageId/receipts` | Who confirmed it |
| `GET` | `/v1/apps/:appId/crashes` | Crash groups (`?status`, `?app_version`, `?search`) |
| `GET` / `PATCH` | `/v1/crashes/:crashId` | One group; resolve, ignore or reopen it |
| `GET` | `/v1/crashes/:crashId/reports` | Its reports, stack included |
| `GET` | `/v1/apps/:appId/logs` · `/v1/installations/:installationId/logs` | Remote logs (`?level`, `?search`, `?from`, `?to`) |
| `GET` / `POST` | `/v1/alert-rules` | Rules; create one (its creator is notified) |
| `PATCH` / `DELETE` | `/v1/alert-rules/:ruleId` | Edit, disable, silence; delete |
| `GET` | `/v1/alerts` · `/v1/alerts/:alertId` | `?status` (`unresolved` for the inbox), `?app_id`, `?rule_id` |
| `POST` | `/v1/alerts/:alertId/ack` · `/resolve` | Acknowledge, or close by hand |
| `GET` / `POST` | `/v1/apps/:appId/ci-tokens` | CI tokens; create one (the token is shown once) |
| `POST` | `/v1/ci-tokens/:tokenId/revoke` | Retire a CI token |
| `GET` | `/v1/apps/:appId/releases` | Releases (`?channel`, `?platform`, `?arch`, `?status`) with installed / healthy / rolled-back counts |
| `GET` / `PATCH` / `DELETE` | `/v1/releases/:releaseId` | One release with its stats and reach; notes, minimum version, named devices; delete a draft |
| `POST` | `/v1/releases/:releaseId/publish` · `/rollout` | Publish at a percentage; widen or narrow it |
| `POST` | `/v1/releases/:releaseId/pause` · `/resume` · `/withdraw` · `/rollback` | Stop offering it; offer it again; pull it; roll the line back to it |
| `GET` | `/v1/releases/:releaseId/artifact` · `/reports` | The artifact; what devices reported |
| `GET` | `/v1/installations/:installationId/updates` | What it would be offered now, and its update reports |
| `GET` / `POST` | `/v1/contracts` | Contracts (`?company_id`, `?app_id`, `?status`); create one |
| `GET` / `PATCH` / `DELETE` | `/v1/contracts/:contractId` | One contract with its current cycle and usage per app; edit (`app_ids` replaces the covered apps); delete one with no history |
| `POST` | `/v1/contracts/:contractId/renew` · `/cancel` | Renew until a new end (reactivating apps a lapse switched off); cancel |
| `GET` | `/v1/contracts/:contractId/cycles` | Its cycles, newest first, with their balance |
| `GET` | `/v1/cycles/:cycleId` | One cycle and the work logged in it |
| `POST` | `/v1/cycles/:cycleId/close` · `/bill` | Close one whose period ended; mark its overage billed |
| `GET` / `POST` | `/v1/work-logs` · `/v1/apps/:appId/work-logs` | The work log (`?company_id`, `?app_id`, `?contract_id`, `?cycle_id`, `?kind`, `?from`, `?to`) with the total minutes; log work |
| `PATCH` / `DELETE` | `/v1/work-logs/:workLogId` | Edit or delete an entry while its cycle is open |
| `GET` | `/v1/tickets` · `/v1/tickets/:ticketId` | The support inbox (`?status`, `active` for what needs somebody; `?app_id`, `?company_id`, `?installation_id`, `?search`, `#42` included); one ticket with its conversation, device context and logged work |
| `POST` / `PATCH` | `/v1/tickets/:ticketId/replies` · `/v1/tickets/:ticketId` | Answer (it becomes `pending`, or `resolved`/`closed`); change its status or subject |
| `POST` | `/v1/apps/:appId/support/assignee` | Take over an app's tickets: you are notified of them |
| `GET` | `/v1/audit-log` | `?event` (a trailing `.` matches a family), `?resource_type`, `?resource_id`, `?actor`, `?from`, `?to` |

### CI (Bearer CI token of the app)

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/apps/:appId/releases/upload` | The artifact as the body (≤ 96 MB, `Content-Length` required); `version`, `platform`, `arch`, `filename` and optionally `channel`, `min_version`, `notes` in the query; `X-Signature` (and optionally `X-Sha256`) in the headers |

Publishing from GitHub Actions, with the private key in a secret as a PEM:

```bash
# Ed25519 over the raw SHA-256 digest of the artifact, base64.
openssl dgst -sha256 -binary dist/pos-setup.msi > digest.bin
printf '%s' "$RELEASE_SIGNING_KEY" > key.pem
openssl pkeyutl -sign -rawin -inkey key.pem -in digest.bin | base64 -w0 > signature.txt
curl --fail-with-body -X POST \
  "https://api.franciscosolis.cl/custom-apps/v1/apps/$APP_ID/releases/upload?version=$VERSION&platform=windows&arch=x86_64&filename=pos-setup.msi&channel=stable" \
  -H "Authorization: Bearer $CUSTOM_APPS_CI_TOKEN" \
  -H "X-Signature: $(cat signature.txt)" \
  -H "X-Sha256: $(sha256sum dist/pos-setup.msi | cut -d' ' -f1)" \
  -H 'Content-Type: application/x-msi' \
  --data-binary @dist/pos-setup.msi
```

The key pair comes from `openssl genpkey -algorithm ed25519 -out key.pem`; the app's
`release_public_key` is the raw 32 bytes of its public half in base64
(`openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64`), and the same bytes are
built into the app so the updater can verify what it downloads.

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
| `POST` | `/heartbeat` | Every `presence.interval_seconds`: `active_seconds`, `app_version`, a light `snapshot`. Logged in full; the last of each minute is charted. Answers the state, presence, outstanding commands and the `sync` tags |
| `GET` | `/socket` | Socket mode: a WebSocket for heartbeats and instant pushes (native apps; `Authorization` on the upgrade) |
| `GET` | `/status` | The state to obey, read on start-up |
| `POST` | `/metrics` | Up to 100 samples (module `metrics`) |
| `POST` | `/events` | Up to 100 usage events (module `events`) |
| `POST` | `/logs` | Up to 100 entries at or above `sync.log_level` (module `logs`) |
| `POST` | `/crashes` | Up to 20 crash reports with their stacks (module `crashes`) |
| `GET` | `/config` | Resolved flags and the config document, with an `ETag` (module `config`) |
| `GET` | `/messages` · `POST /messages/:messageId/seen` | Running messages; confirm one was shown (module `messages`) |
| `POST` | `/commands/:commandId/ack` | A command's result (module `commands`) |
| `POST` | `/commands/:commandId/screenshot` | The image a `screenshot` command asked for, as the body |
| `GET` | `/updates/latest` | The release to install, or null (module `updates`); `?platform`, `?arch`, `?version` override what enrollment said |
| `GET` | `/updates/:releaseId/download` | A 15-minute link to the artifact, usable without the token |
| `GET` | `/downloads/:ticket` | The artifact itself; public, answers `Range` |
| `POST` | `/updates/:releaseId/report` | `downloaded`, `installed`, `health_ok`, `rolled_back` or `failed` |
| `POST` | `/tickets` | Open a ticket: `subject`, `message`, optionally `name` and `email`; the device is attached (module `support`) |
| `GET` | `/tickets` · `/tickets/:ticketId` | This installation's tickets with their unread answers; one with its conversation (marks the answers read) |
| `POST` | `/tickets/:ticketId/messages` | Write on a ticket again (reopens it; a closed one refuses) |

A device should keep its tokens in the platform's secure store, ask `/status` on start-up, queue
metrics, events and logs locally while offline and send them when the network is back, deduplicate
commands by `id`, and refetch `/config` or `/messages` only when their tag in `sync` changes.

An updater, when `update` in a heartbeat answer is not null: read `/updates/latest`, get a link,
download it, check its SHA-256 and verify the signature over that digest against the key built into
the app, keep the running version as the fallback slot, install and restart into the new one, and
report `installed`. Report `health_ok` once the new version has started, reached this API and passed
its own checks; if that has not happened within `health_check_timeout_seconds`, or it crashes
`max_failures` times in a row, switch back to the fallback and report `rolled_back`. An offer marked
`mandatory` must be installed before the app carries on; one marked `rollback` is the way back from
a withdrawn version.

---

## ⚙️ Configuration

| Variable | Purpose |
| --- | --- |
| `AUTH_JWKS_URL` | Path the auth Worker's key set is read from, over the `AUTH` binding |
| `AUTH_ISSUER` | Expected `iss` claim. Must match `apps/auth` exactly |
| `CUSTOM_APPS_ALLOWED_AUDIENCES` | Client ids whose tokens may use the panel — its own only |
| `CUSTOM_APPS_ALLOWED_EMAIL_DOMAINS` | Domains allowed in, under the permission |
| `INGEST_PUBLIC_URL` | Base of the ingest surface; its host is what requests are dispatched on |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Sender of the contract notices; must be allowed by the `EMAIL` binding |

Bindings: `DB` (D1), `AUTH` (service binding, read for its JWKS only), `TELEMETRY_QUEUE` (producer
and consumer of the same queue), `NOTIFICATIONS_QUEUE` (producer, for alerts), `PRESENCE` (the
`InstallationSocket` Durable Object), `SCREENSHOTS` and `RELEASES` (R2), `EMAIL` (Cloudflare Email
Sending, from `hola@mail.franciscosolis.cl`), `ENROLL_IP_LIMITER`,
`ENROLL_APP_LIMITER` and `INGEST_LIMITER` (rate limits), the ingest zone route and a cron every five
minutes. One secret: `UPDATE_DOWNLOAD_SECRET` (`wrangler secret put UPDATE_DOWNLOAD_SECRET`, and again
with `--env dev`), any long random string; rotating it invalidates the links already handed out,
which live 15 minutes anyway.

---

## 🌐 Deployment

```bash
cd apps/custom-apps
pnpm exec wrangler d1 create franciscosolis_custom_apps                # and _dev; ids into wrangler.jsonc
pnpm exec wrangler queues create franciscosolis-custom-apps-telemetry  # and -dev
pnpm exec wrangler r2 bucket create franciscosolis-custom-apps-screenshots  # and -dev
pnpm exec wrangler r2 bucket create franciscosolis-custom-apps-releases     # and -dev
openssl rand -base64 48 | pnpm exec wrangler secret put UPDATE_DOWNLOAD_SECRET  # and --env dev
pnpm run deploy
```

The Worker must be deployed as `custom-apps` for the gateway's `CUSTOM_APPS` binding to resolve —
**before** the gateway change that binds it — and after `auth`, which it binds. The screenshots
and releases buckets must exist before the deploy that binds them, and so must the notifications queue. The Durable
Object class is created by the `v1` migration in `wrangler.jsonc` on the first deploy. Migrations are
applied by the repository's `Migrate` workflow on a push to `dev`; `pnpm run db:migrate:remote` is
the manual fallback.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
