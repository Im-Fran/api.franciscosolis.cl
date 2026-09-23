# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`notifications` is the **notification** Worker for the `api.franciscosolis.cl` monorepo. The
gateway (`apps/api`) reaches it through the `NOTIFICATIONS` service binding and proxies
`/notifications/*`, so its public base URL is `https://api.franciscosolis.cl/notifications`. It lives
at `apps/notifications`.

It exists to send less email. Other Workers publish events onto a queue; this Worker files each one
in the account's in-site inbox, pushes it to the devices the account registered (Web Push), and
emails it immediately, in a daily or weekly digest, or never, as the account chose. The website shows
the bell in its header and the inbox and preferences at `franciscosolis.cl/account/notifications`.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`franciscosolis_notifications`).
- **Cloudflare Queues** (consumer), **Email Sending** (`EMAIL`), an hourly **cron trigger**.
- `@franciscosolis/emails` for every email body. No other runtime dependency: Web Push is implemented
  on WebCrypto in `src/lib/webpush.ts`.
- Dependency versions come from the workspace `catalog` — use `catalog:`, never a hardcoded version.

## Commands (run from this directory, `apps/notifications/`)

- `pnpm run dev` → `wrangler dev` on :8795.
- `pnpm run test` / `test:coverage` / `typecheck` / `build` / `build:dev`.
- `pnpm run db:generate` → `drizzle-kit generate`; `db:migrate:local` / `db:migrate:remote` /
  `db:migrate:list` (and `:dev`). Production migrations run from `.github/workflows/migrate.yml`.
- `node scripts/generate-vapid-keys.mjs` (alias `pnpm run vapid:generate`, but pipe the former: `pnpm run` prints a banner on stdout) → prints a VAPID private JWK on stdout (pipe it into
  `wrangler secret put VAPID_PRIVATE_KEY [--env dev]`) and the public key on stderr.

## Source layout

- `src/index.ts` — the Hono app and the other two entry points (`queue`, `scheduled`).
- `src/db/schema.ts` — `recipients`, `notifications`, `push_subscriptions`.
- `src/lib/` — `catalog.ts` (every type, its category, whether it is emailable, its copy in both
  languages), `config.ts`, `webpush.ts` (RFC 8291 + 8292), `time.ts` (the Santiago clock), `jwks.ts`.
- `src/services/` — `ingest.ts` (the queue consumer), `push.ts`, `digest.ts`, `email.ts`,
  `recipients.ts` (preferences).
- `src/routes/me.ts` — every signed-in route.

## Architecture notes (non-obvious)

- **Events arrive on a queue because a service binding would be a deploy cycle.** This Worker binds
  `AUTH` to read the JWKS, and `auth` is a producer. `auth → notifications` plus
  `notifications → auth` has no valid first deploy. A queue is not a Worker, so it breaks the cycle,
  and it brings two things a binding would not: retries, and a sign-in that never waits on — or fails
  because of — this Worker. Do not replace it with a binding.
- **The event id is the primary key, and every side effect is gated on the insert.** Queues deliver
  at least once. A redelivered event hits the key, inserts nothing, and therefore pushes and emails
  nothing. Anything added to `ingestEvent` must stay after that `returning()` check.
- **Text is rendered on read, never stored.** A row keeps `type` + `data`; `renderCopy` writes the
  title and body in whichever language the reader has *now*. A wording fix is a code change, not a
  data migration. An unknown type at ingest is *retried*, not stored with a fallback: it means a
  producer shipped a type before this Worker learned it, and the queue's retries wait for the deploy.
- **`emailable: false` is the no-duplicates rule.** Receipts, refunds and support mail are still sent
  by the Worker that owns them — a receipt is a document, a support reply is a thread you can answer
  from your inbox. For those types this Worker keeps the in-site copy and the push and never emails.
  Magic links and invitations never come through here at all.
- **The account-access notice moved here, its template did not.** `apps/auth` used to email every
  sign-in and authorization itself. It now publishes `account.sign_in` / `account.authorization`, and
  falls back to emailing directly if the publish throws — a security notice must never be lost to a
  queue outage. An `immediate` recipient still gets the detailed `AccountAccessEmail`.
- **`email_status` is the digest's queue.** `none` / `pending` / `sent` / `skipped`, decided at
  arrival from the preferences then in force. The digest lists only unread `pending` rows, marks read
  ones `skipped`, and sends nothing when nothing is left. `immediate` recipients are in the daily run
  too: their rows are only `pending` if the immediate send failed, so the daily run is their retry.
- **The cron is hourly because Chile has daylight saving.** Digests are due at 09:00
  `America/Santiago`; a fixed UTC cron would drift by an hour for half the year. `lib/time.ts` asks
  `Intl` what time it is there. `recipients.last_digest_at` plus a guard window makes a run
  idempotent, so a double-fired cron sends nothing twice.
- **One secret configures push.** `VAPID_PRIVATE_KEY` is a P-256 private JWK; its `x`/`y` are the
  public key, which `GET /` publishes for `applicationServerKey`. Missing → push is off and `GET /`
  says `null`, not an error. Keys are **per environment**: a subscription is bound to the public key
  it was made with, so a dev browser can never be pushed to from production.
- **A push endpoint is a browser profile, not an account.** `endpoint` is unique across the table and
  moves to whichever account registered it last, so a shared browser does not keep receiving the
  previous account's sign-in notices. The website also unsubscribes locally on sign-out.
- **No scheduled purge.** Retention is indefinite by decision; the only delete path is a person
  deleting their own notification.
- **The website is the only audience.** `NOTIFICATIONS_ALLOWED_AUDIENCES` is `franciscosolis-web`.
  There is no console and no permission: every query is scoped to the token's `sub`, and no route
  takes a user id from the request. A verified address on the token is recorded as where to email;
  an unverified one is not.

## Testing

`test/helpers/push.ts` is a browser: it decrypts pushes from the receiving side of RFC 8291,
independently of `src/lib/webpush.ts`, which is the only meaningful test of an encryption routine.
The suite runs against the top-level `wrangler.jsonc` (no named `test` environment — nothing here
opens a remote proxy session), stubs `AUTH` for the JWKS as the other suites do, installs a
throwaway VAPID key per test with `installVapidKey`, and calls `worker.queue()` / `runDigests()`
directly with hand-built batches and dates.
