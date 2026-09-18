# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`support` is the **support ticket** Worker for the `api.franciscosolis.cl` monorepo. Like `landing`,
`auth`, `cms` and `pages` it is not public over HTTP: the root gateway (`apps/api`) reaches it
through the `SUPPORT` service binding and proxies `/support/*` to it, so its public base URL is
`https://api.franciscosolis.cl/support`. It lives at `apps/support`.

It does two things:

- **Tickets.** Anybody can open one with an email address, from `franciscosolis.cl/help/new` or by
  writing to `soporte@franciscosolis.cl` / `support@franciscosolis.cl`. The conversation works in
  both directions by email *and* in the browser: replies, internal notes only the team sees, labels,
  assignment, watchers, an editable subject, and a GitHub-issues-style timeline. When the team
  answers and the person does not come back within thirty minutes, they get one digest email.
- **A help centre.** Bilingual articles with two kinds of search over them: FTS5 for the public
  search box, and Workers AI embeddings in Vectorize for the assistant that drafts an agent's reply
  out of them.

The website renders the public half at `franciscosolis.cl/help` and `/tickets/<reference>`; the team
works the queue at `franciscosolis.cl/support`.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`drizzle-orm/d1`), backed by the `franciscosolis_support` database.
- **Workers AI** (`AI`) and **Vectorize** (`VECTORIZE`) — the first use of either in this monorepo.
- **Cloudflare Email Sending** (`EMAIL`) out, **Email Routing** in, and a **cron trigger**.
- `postal-mime` for parsing inbound MIME, and `@franciscosolis/emails` for every outgoing body.
- Dependency versions come from the parent workspace's pnpm `catalog` — use `catalog:`, never a
  hardcoded version.
- `pnpm` install/deps are managed from the **monorepo root**.

## Commands (run from this directory, `apps/support/`)

- `pnpm run dev` → `wrangler dev --ip 0.0.0.0 --port 8793 --inspector-port 9234`
- `pnpm run deploy` → `wrangler deploy --minify`
- `pnpm run db:generate` → `drizzle-kit generate`, writes a new SQL migration.
- `pnpm run db:migrate:local` / `db:migrate:remote` / `db:migrate:list`. Production migrations are
  applied by `.github/workflows/migrate.yml` on a push to `dev`; these are for local work and for
  repairing a database that has drifted. See the root `CLAUDE.md`.

`wrangler dev` cannot serve Workers AI or Vectorize from a local simulation — neither has one. The
`AI` binding always runs against the real service, and `VECTORIZE` carries `"remote": true` for the
same reason, so `/admin/assist` and the vector half of an article save need real credentials locally.
Everything else works offline.

## Environment

This Worker has **no secrets**. It verifies access tokens against the auth Worker's public JWKS, and
the link that lets somebody read their own ticket without an account is a per-ticket random secret
stored as a hash on the row, not a key held here. `.dev.vars` (gitignored, copy from
`.dev.vars.example`) only repoints `AUTH_ISSUER` and the public ticket URL at local services.

## Source layout

- `src/index.ts` — the Hono app *and* the other two entry points. See the first architecture note.
- `src/db/schema.ts` — the whole D1 schema. `src/db/client.ts` builds a per-request client.
- `src/lib/` — `config.ts` (statuses, limits, the thirty minutes), `jwks.ts` (offline token
  verification), `tokens.ts` (the two per-ticket secrets), `references.ts` (`FS-1042`), `mime.ts`
  (HTML→text and quoted-reply trimming), `locales.ts`, `validation.ts`, `json.ts`, `errors.ts`,
  `slug.ts`.
- `src/middleware/` — `auth.ts` (`requireAgent`, `requirePermission`) and `ticket-access.ts`
  (the three-way gate on one ticket).
- `src/services/` — `tickets.ts`, `notifications.ts` (the thirty-minute rule), `email.ts` (out),
  `inbound.ts` (in), `ai.ts`, `vectors.ts`, `help.ts`, `help-search.ts`, `rate-limit.ts`, `audit.ts`.
- `src/routes/` — `tickets.ts` and `help.ts` are public; `me.ts` is the signed-in requester;
  `admin/` is the team.
- `migrations/` — `0000_init.sql` (drizzle, plus the FTS5 table appended by hand) and `0001_seed.sql`.

## Architecture notes (non-obvious)

- **This Worker has three entry points and the gateway fronts only one of them.** `fetch` is proxied
  from `apps/api` like every other internal Worker here; `email` is dispatched straight to the script
  by Cloudflare Email Routing and `scheduled` by the cron, and neither passes through the gateway or
  can. That is the one documented exception to this monorepo's "internal Workers are reached only
  through `apps/api`" rule. Do not "tidy up" the `workers_dev` or routing configuration on the
  strength of that rule: doing so silently removes the inbound half of the product while every test
  still passes.
- **It is the first Worker here that enforces a permission.** `apps/cms` and `apps/pages`
  deliberately stop at the email-domain gate and never read `permissions`. A support system cannot:
  tickets are *assignable to people*, and "assign to a person" is meaningless without a defined set
  of people. `apps/auth` resolves roles per client application, so `support:agent` plus a client
  application of its own is the mechanism that produces one — which is why, unlike `apps/pages`, this
  Worker does not reuse the CMS's audience. The cost is the one `lib/jwks.ts` already documents:
  `permissions` is a snapshot, so revoking an agent takes effect within one access-token lifetime.
- **There are two audience lists and they must never be merged.** `SUPPORT_ALLOWED_AUDIENCES` gates
  `/admin`; `SUPPORT_REQUESTER_AUDIENCES` is wider and only lets somebody read their own ticket.
  Collapsing them would leave the domain and permission checks as the only thing keeping a token
  minted for the public website out of the support console.
- **A failed ticket lookup answers 404, never 403.** Ticket numbers are short and sequential, so a
  403 would turn the reference space into an oracle that enumerates every support request ever
  filed — and the fact that a given person filed one. `requireTicketAccess` makes "no such ticket"
  and "not yours" indistinguishable from outside, and `POST /tickets/resend-link` always answers 202
  for the same reason.
- **Two secrets hang off a ticket, and conflating them is a bug waiting to happen.**
  `access_token_hash` is a credential: it travels in the fragment of an emailed link and must be
  rotatable the day that link is forwarded to the wrong person. `reply_key` is routing metadata baked
  into an address that sits in every participant's mail client forever and can never be rotated
  without breaking their reply button. Different lifetimes, different columns.
- **The reply routing key is lowercase hex, not base64url** (`generateRoutingKey`). It travels as the
  local part of an email address through relays that normalise case, and a base64url key is silently
  destroyed by that. 128 bits is ample for something whose only job is to name a row.
- **Only the SHA-256 of the access secret is stored**, which is what makes a database dump useless
  for reading tickets — and the direct consequence is that *nothing running afterwards can rebuild
  the link*. That is why the deferred digest quotes the replies in full and links to the ticket
  without a secret, and why `POST /tickets/resend-link` rotates rather than re-sends.
- **Ticket numbers and message ordinals are both allocated with `UPDATE ... RETURNING`.**
  `SELECT max() + 1` races, and the concurrency that actually hits it is two inbound emails delivered
  in the same second. `seq` exists at all because `unixepoch()` is whole seconds: the digest window
  is "every agent reply after the last one we sent", which cannot be expressed against a key with
  ties. The inbox's `ORDER BY updated_at DESC, number DESC` is the same problem in a listing.
- **The thirty-minute rule does not extend its deadline.** A second agent reply inside the window is
  an `ON CONFLICT DO NOTHING` against a partial unique index, so the first deadline stands and the
  digest simply grows. Extending would let a chatty agent push the notice out forever and the person
  would hear nothing at all. Cancelling is per *recipient*, not per ticket. The race between a reply
  and the sweep is settled in favour of sending. A row stuck in `sending` is reaped after ten
  minutes — without that, one dead isolate silences that person on that ticket permanently.
- **Drizzle 0.45 cannot express a partial unique index as an `ON CONFLICT` target for SQLite**, so
  that one insert in `services/notifications.ts` is written as SQL. Its `onConflictDoNothing({where})`
  emits the predicate where a `DO UPDATE`'s clause goes, which against `DO NOTHING` is a syntax
  error. Losing the partial index instead is not an option: it is what makes "one pending notice per
  person per ticket" true of the database rather than of that function.
- **The AI pass runs after the ticket exists, never before it.** An inbound email is written from its
  raw headers and `enrichTicket` improves it in `waitUntil`, so a model outage, a timeout or an answer
  that does not fit the schema costs a plainer subject line and never an email. The alternative —
  extract, then create, with a fallback branch — puts the code that must work during an incident on
  the path that only runs during one.
- **The inbound thread cascade is ordered by how much each signal can be trusted**, and the last
  rung has a condition on it: a `[FS-1042]` subject tag is honoured *only* when the sender is already
  a participant of that ticket. Unconditional, it is a one-line forgery that injects a message into —
  and reveals the replies on — a stranger's thread.
- **There is no column for HTML anywhere on a ticket.** Not having it is what makes it structurally
  impossible for a later change to render the most thoroughly unauthenticated input this monorepo
  stores. `lib/mime.ts` converts an HTML-only message to text at ingest, and the quoted trail is
  trimmed there too — without that, message *n* carries all of 1..n-1, storage grows quadratically
  and every digest quotes the whole history back at the person who wrote it. The untrimmed body is
  kept in `body_text_raw` so an over-eager trim is recoverable.
- **Attachments are recorded and not stored.** Filename, type and size go on the message and a line
  in the body says what arrived. Storing the bytes needs a bucket, a moderation step and a gated
  download route — the lesson of `AVATARS` in `apps/auth` — which is a change of its own. Dropping
  them silently was the only genuinely unacceptable option: an agent would be answering about a
  screenshot they have no idea exists.
- **The FTS5 index is maintained from application code, not by SQL triggers** (`help-search.ts`).
  Its rows are one per (article, locale), derived from a JSON blob whose field names live in
  `lib/locales.ts`; a trigger would have to re-express that in SQL, somewhere drizzle does not see,
  TypeScript does not check and nobody updates the day a third locale lands. The one job a trigger
  keeps is deleting orphans, because a foreign key cannot reach into a virtual table.
- **`MATCH` takes a query language, not a string** (`toMatchQuery`). Raw input is a syntax-error
  generator and a prefix-expansion denial of service, so every term is wrapped in double quotes —
  inside which every operator is inert — and only the last gets a `*`.
- **`bm25()` returns a *negative* score and takes one weight per column including the UNINDEXED
  ones.** `ORDER BY rank DESC` returns the worst matches first and looks entirely plausible doing it.
- **Unpublishing deletes the index rows rather than flagging them.** FTS5 has no useful secondary
  index, so a `status` column would have to be filtered *after* `MATCH`, which silently eats the
  `LIMIT` budget and can return an empty page while matches sit further down.
- **`help_articles.vector_ids` records the ids actually written.** Recomputing them from the current
  chunk count on the next pass misses the trailing chunks of an article that got *shorter*, leaving
  them answering searches about text nobody can read any more.
- **The assistant re-reads every article from D1 before building the prompt**, which is what stops a
  stale vector from surfacing an unpublished draft, and is why there is no reconciliation job: an
  orphaned vector costs one wasted slot in a top-k. It also intersects the model's citations with
  what was actually retrieved, because it *will* cite slugs it invented. With no surviving sources it
  returns without calling the text model at all. **The model drafts; a human sends.**
- **Workers AI is metered per neuron with no per-Worker spend cap**, which is why every call is
  logged in `ai_requests` — the same table the assistant's hourly limit reads. Without it the first
  sign of a runaway loop in a front-end is the invoice.
- **The migration and deploy race documented in the root `CLAUDE.md` is worse here**: `email()` and
  `scheduled()` run against whatever schema is deployed. A message arriving mid-migration can fail,
  which is why `inbound_emails` records the failure rather than losing it.
- **5xx bodies are generic** (`onError`), and it matters more in this Worker than in its siblings: a
  Drizzle failure message carries the statement together with its bound parameters, and here those
  parameters are a stranger's email address and the text of the problem they wrote in about.
- **The audit trail never holds a message body.** It is read out in the console and exported by
  `GET /admin/audit`; a ticket body is somebody's personal data, and the id of the message is enough
  to find it through a route that already checks who is asking.

## Testing

Two things about this app's suite are not obvious:

- **`wrangler.jsonc` carries a named `test` environment, and that is why.**
  `@cloudflare/vitest-pool-workers` responds to an `ai` or `vectorize` binding by opening a *remote
  proxy session* against the real account — which needs a `CLOUDFLARE_API_TOKEN` CI does not have,
  and bills real neurons for a unit test. A named environment inherits nothing, so everything the
  suite needs is restated there without those two, and `test/unit/env-bindings.test.ts` fails if the
  two halves drift apart. The suite supplies `env.AI` and `env.VECTORIZE` by assignment instead
  (`test/helpers/ai.ts`), with loud defaults so a path that reaches either service unexpectedly says
  so instead of returning `undefined`.
- **Miniflare cannot dispatch an email event**, so `SELF` is useless for the inbound half. The
  handler is called directly — `worker.email(message, env, ctx)` with a fabricated
  `ForwardableEmailMessage` (`test/helpers/inbound.ts`) — which covers the real path,
  `PostalMime.parse` included. Everything that *decides* anything lives in `services/inbound.ts` so
  it can also be driven with plain objects.

The deferred-notification sweep takes the moment to sweep as an argument for the same reason: a test
hands it a `Date` thirty-one minutes out instead of waiting, and `scheduled()` stays a thin adapter.

## Operator setup (not in git)

Two things this repository cannot configure, exactly as it cannot configure Workers Builds:

1. **Email Routing rules** for `soporte@franciscosolis.cl` and `support@franciscosolis.cl` pointing at
   the `support` Worker — plus a **catch-all** rule if the `reply+<key>@` threading key is wanted, since
   Email Routing matches a custom address exactly and has no wildcard of its own. Without the
   catch-all the cascade in `services/inbound.ts` simply falls through to its next strategy. The apex
   already uses Cloudflare Email Routing as its MX, so adding these displaces no existing mailbox.
2. **The Vectorize index**, before the first deploy:
   ```
   wrangler vectorize create franciscosolis-support-help --dimensions=1024 --metric=cosine
   wrangler vectorize create-metadata-index franciscosolis-support-help --property-name=locale --type=string
   ```
   The metadata index is the silent one: without it a `locale` filter returns nothing rather than
   erroring, and the assistant degrades to "no sources found" with no signal anywhere.

`mail.franciscosolis.cl` also needs `soporte@` verified for Email Sending. The cron fires only on the
production deployment, never on a preview, so the deferred digest is not exercisable from a preview
URL — that is correct behaviour, not a bug.
