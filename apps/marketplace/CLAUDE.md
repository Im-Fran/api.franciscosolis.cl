# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`marketplace` is the storefront Worker for the `api.franciscosolis.cl` monorepo. Like `landing`,
`auth`, `cms` and `support` it is not public: the root gateway (`apps/api`) reaches it through the
`MARKETPLACE` service binding and proxies `/marketplace/*` to it, so its public base URL is
`https://api.franciscosolis.cl/marketplace`. It lives at `apps/marketplace`.

It replaced `apps/pages`, which was the same Worker under a smaller name — one product page per
application, to one house standard. What a storefront needed and a product page did not is what this
Worker adds: reviews, release channels, per-release compatibility, analytics and a category.

A product page is five tabs, and the registry in `src/lib/tabs.ts` is the whole model:

- **Overview** — one centred Markdown document, with the sidebar beside it. Always present.
- **Releases** — release notes, newest release first, each on one of four channels.
- **Wiki** — documentation pages with a sidebar, nested at most one level deep.
- **Reviews** — what the people who obtained it thought, with the owner's answers.
- **Contact** — how to reach support, as one Markdown document beside the product's links.

A product can **take money**: `free`, `donation` (optional payment) or `paid` (a download needs an
approved purchase), through MercadoPago Checkout Pro, with every payment tied to an account on the
franciscosolis.cl SSO. The builds hang off a release and are served by this Worker against a
per-request ticket, never from a bucket URL.

Around those payments it runs a **back office**, per product: the sales of one product, sales
*recorded by hand* for money taken in cash or by transfer or a copy given away, the **vouchers**
(receipts) issued for them, and refunds — including the statutory *derecho a retracto*.

Reads of published products are public; everything under `/admin` needs an access token minted for
the marketplace console, carrying an allowed email domain **and** the `marketplace:editor`
permission. The buyer-facing routes take a token from the *website's* client id instead, on a second
audience list.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`drizzle-orm/d1`), backed by the `franciscosolis_marketplace` database.
- **R2** (`RELEASES` → `franciscosolis-app-releases`) for the downloadable builds, and **MercadoPago
  Checkout Pro** over plain `fetch` for payments — no SDK, which is a handful of functions in
  `src/lib/mercadopago.ts` rather than a dependency that assumes Node.
- **Cloudflare Email Sending** (`EMAIL`) and `@franciscosolis/emails` for one thing only: the voucher,
  and the notice that one was refunded. This Worker has no inbound mail and must not grow any —
  correspondence is `apps/support`'s job, and a reply belongs on a ticket. Like the CMS it aliases
  `prettier/standalone` and `prettier/plugins/html` out of its bundle, in `wrangler.jsonc` *and* in
  `vitest.config.ts`.
- **`@franciscosolis/translate`** (workspace package) for the prompt behind `POST /admin/translate`,
  and **Workers AI** (the `AI` binding) to run it.
- The **Cache API** (`caches.default`) for one thing only: deduplicating a page view. See the note
  below on why that is not a table.
- Dependency versions come from the parent workspace's pnpm `catalog` — use `catalog:`, never a
  hardcoded version.

## Commands (run from this directory, `apps/marketplace/`)

- `pnpm run dev` → `wrangler dev --ip 0.0.0.0 --port 8794 --inspector-port 9235`
- `pnpm run deploy` → `wrangler deploy --minify`
- `pnpm run cf-typegen` → run after editing `wrangler.jsonc` bindings.
- `pnpm run db:generate` → `drizzle-kit generate`, writes a new SQL migration.
- `pnpm run db:migrate:local` / `pnpm run db:migrate:remote` → apply migrations with Wrangler, and
  `pnpm run db:migrate:list` to see what is pending. Production migrations are applied by
  `.github/workflows/migrate.yml` on a push to `dev`. See the root `CLAUDE.md`.

## Environment

This Worker holds **three secrets**: `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` and
`DOWNLOAD_SIGNING_KEY`. Token verification needs no key of its own — that is the auth Worker's public
JWKS, read over the `AUTH` service binding — but taking money and signing download links both do.
They are set with `wrangler secret put`; `.dev.vars` (gitignored, copy from `.dev.vars.example`)
holds the local values, and never a live MercadoPago credential.

**`MERCADOPAGO_ENVIRONMENT` is the one var that must be right, and it is a var rather than a guess.**
It is `live` at the top level and `sandbox` under `env.dev`, and it decides two things: which of the
two URLs a created preference is answered with, and what is stamped onto every purchase. A *test*
credential answers a preference with **both** `init_point` and `sandbox_init_point`, and they are
different checkouts — only the second is the one the provider's test cards work on. Inferring the
environment from the shape of the credential does not work either: a test *user*'s application
credential is spelled exactly like a production one. Local `wrangler dev` inherits the top-level
`live`, which is why `.dev.vars.example` overrides it.

**Two pieces of setup live outside this repository.** The D1 databases do not exist until somebody
creates them (`wrangler d1 create franciscosolis_marketplace`, and the `_dev` one), and their ids go
into `wrangler.jsonc` — the placeholders there are placeholders. And the
`franciscosolis-marketplace` OAuth client application is a row in the auth database, in each
environment, with `marketplace:editor` granted to the editorial accounts. Until it exists, `/admin`
is a 401 for everybody, which is the correct failure and an invisible one.

## Source layout

- `src/index.ts` — Hono app: charset/cache middleware, `onError`, `GET /` (which advertises every
  closed vocabulary), route mounting, `/openapi.json`.
- `src/db/schema.ts` — the entire D1 schema. `src/db/client.ts` builds a per-request client.
- `src/lib/` — the closed vocabularies and the pure rules: `tabs.ts`, `links.ts`, `categories.ts`,
  `channels.ts`, `compatibility.ts`, `reviews.ts`, `analytics.ts`, `locales.ts`, `pricing.ts`,
  `sales.ts`, `mercadopago.ts`, `downloads.ts`, `files.ts`, plus `jwks.ts`, `config.ts`,
  `validation.ts`, `errors.ts` and `slug.ts`.
- `src/middleware/auth.ts` — `requireEditor`, the editorial gate. `src/middleware/account.ts` —
  `requireAccount`/`optionalAccount`, the buyer's and the reviewer's.
- `src/services/` — `products.ts`, `releases.ts`, `wiki.ts`, `compatibility.ts`, `reviews.ts`,
  `ratings.ts`, `analytics.ts`, `overview.ts`, `release-files.ts`, `purchases.ts`, `downloads.ts`,
  `sales.ts`, `vouchers.ts`, `mail.ts`, `audit.ts`, `ai.ts`, and `access.ts` — the one place that
  decides whether somebody may download.
- `src/routes/` — `products.ts` (the public reads and the overview panel), `reviews.ts`, `views.ts`,
  `store.ts`, `downloads.ts`, `payments.ts`, and `admin/` for the editorial API.
- `migrations/` — one `0000_init.sql`, generated by drizzle-kit.

## Architecture notes (non-obvious)

### The page model

- **A tab is a registry entry, never a per-product layout field** (`src/lib/tabs.ts`). A product
  picks a subset of the same five tabs, in an order, and nothing else about its shape is
  configurable. `reviews` is what that sentence looks like when it is used: a fifth entry plus the
  routes in `src/routes/reviews.ts`, and nothing else about the registry changed for it.
- **The Overview sidebar is not a tab.** It is chrome beside the banner, like the links row, and it
  has a route of its own (`GET /products/:slug/overview`) precisely so it does not need an entry in
  the registry. The day it becomes a tab key the tab list stops describing what a visitor clicks.
- **`overview` is forced into the tab list and forced to the front** (`normalizeTabs`).
- **Unknown tab keys are dropped on read, not rejected** (`parseTabs`). A tab key retired in a later
  version degrades to "one tab fewer" rather than 500-ing the product it was left on. The *write*
  path is strict. Every stored vocabulary here reads the same way — `parsePricingMode`,
  `parseChannel`, `parseCategory`, `parseReviewStatus`, `toPublicCompatibility`.
- **Overview and Contact are columns; Releases, Wiki and Reviews are tables.** There is never more
  than one of either document, so splitting them out would buy a join for nothing. The **editor's
  reply to a review is four columns on `product_reviews`** for exactly the same reason: there is
  never more than one, and columns mean no join on the public read plus "one reply" enforced by the
  shape rather than by an index somebody can later relax.
- **This schema uses foreign keys, unlike the CMS's.** A release, a wiki page, a compatibility entry
  or a review only means anything as part of one product.
- **The financial and event half carries no foreign key at all**, deliberately: `purchases`,
  `sale_vouchers`, `payment_events`, `download_events`, `product_daily_stats` and `ai_requests`. A
  payment is a financial record, a download is something that happened and a daily total is a fact
  about traffic; deleting a product page must not erase any of them. The slug, the version and the
  filename are snapshotted onto those rows instead.
- **`product_reviews.release_id` is `ON DELETE set null`, not cascade.** Deleting a version must not
  delete what people wrote about it.
- **Releases are ordered by `released_at`**, not `created_at` or `published_at`. An editor writing up
  three versions in one sitting would otherwise get them in typing order, and back-dating a release
  somebody forgot would silently put it at the top.
- **A version is free text, not semver** (`versionInput`). This Worker fronts a Minecraft plugin and
  a mobile app equally well. What it may not contain is whitespace or a slash — it is a path segment.
- **Every nested editorial route is scoped by its product** (`/admin/products/:productId/…`), and
  compatibility by its release on top of that. That is what stops an id from one product being read,
  edited or deleted through another's URL.
- **`published_at` is stamped once**, the first time something goes live, and kept through later
  unpublish/republish cycles. The rating window depends on this: a release taken down and put back
  must not move the cutoff.
- **Only prose is translated, never structure.** Which tabs a page has, its slug, a release's version
  and channel, a category key and a compatibility kind are the same fact in every language.

### Channels

- **A channel is not a status.** `draft`/`published`/`archived` decides whether anybody may see the
  entry; `nightly`/`beta`/`rc`/`release` decides how much they should trust it. Every release
  carries both, independently.
- **The channel is part of the version key**, so `1.4.0` can exist as an `rc` and later as a
  `release`. That is why the public address is `/products/:slug/releases/:channel/:version`: a
  lookup by version alone would answer with whichever row SQLite reached first, and the one it
  reached could be the gated one.
- **The default feed is `release` only**, and `?channel=all` lifts the filter. An unknown channel is
  **refused** rather than falling back, deliberately unlike a tab key: a tab key is content and
  degrades to one tab fewer; a channel is a filter, and a typo that silently became `all` would put
  nightlies in front of somebody who never asked for one.
- **`pre_release_requires_purchase` exists for `donation` mode.** A pay-what-you-like product is free
  to take, so the pre-release line is the only thing a supporter gets that a non-supporter does not —
  which is the incentive without charging anybody for the product itself. In `paid` mode it is inert
  in practice (a non-payer cannot download anything anyway) and in `free` mode `describePricing`
  reports it as false, the same nulling a stale `price` gets.
- **Everything about a pre-release stays public** — the note, the links, the compatibility, the file
  listing. Only the download is gated. Hiding a nightly would remove the very incentive the gate
  exists to create.

### Money and downloads

- **Every decision about whether somebody may download is made in `services/access.ts`**, the
  channel gate included. Two routes need it — the status endpoint the website polls and the one that
  mints a ticket — and a second place deciding it is a second place to get it wrong. The one that
  gets it wrong gives a paid build away.
- **`isChannelGated` is separate from `Access.gate` on purpose.** `gate` answers "why is this person
  refused", which for a paid product is always the price; `isChannelGated` answers "is this line
  reserved for supporters", which is a fact about the release with no caller in it — and that is what
  keeps the file listing cacheable.
- **A non-payer sees the offer every time, without exception** (`mustOfferPayment`).
- **The download is a Worker route because a URL cannot be asked a question.** The bucket has no
  public access, `object_key` is never serialized into any response shape, and the only way to the
  bytes is `GET /downloads/:ticket`.
- **The cooldown is `nbf` on the ticket**, not a timer on the page. A `setTimeout` is something
  anybody can step over in the dev tools. The route passes `cooldownSeconds` explicitly rather than
  leaving the ticket to its `paid ? 0 : 5` default, because that default is wrong for a *free*
  product: `resolveAccess` says its cooldown is zero, and a ticket that waited anyway would
  contradict the `cooldown_seconds: 0` the same response advertises.
- **Tickets are signed, not stored.** Nothing is revocable as a result, which is exactly why one
  lives five minutes: the short window *is* the mitigation for a shared link.
- **The webhook is the only unauthenticated write, and three things guard it**: MercadoPago's
  `x-signature`; a *fetch of the resource* with our own credential, because the notification body is
  not evidence; and a unique key that makes a retry a no-op which still answers 200. With no secret
  configured it refuses everything.
- **An approved payment *is* the entitlement.** No `entitlements` table, so a refund is a status
  change on the row that already exists. `findActivePurchase` matches on the account id *or* the
  verified address, which is also what makes a manual cash sale confer a review.
- **A voucher is a document, not a view of the sale.** Never edited, never deleted; correcting one
  voids it and issues the next number.
- **The withdrawal window is a constant, not a setting** (`WITHDRAWAL_DAYS`, ley 19.496 art. 3 bis b).
  `days_left` is rounded **up**: a buyer whose right expires in four hours has not lost it.
- **Amounts are integers of whole pesos.** Nothing here holds a float.
- **Every migration on `purchases` stays additive.** A `DROP TABLE`/rename rebuild races the
  production deploy, and for the length of it every paid download would 404 rather than degrade.
  `UNLINKED_USER_ID` (the empty string) is the sentinel a nullable column would have been. The
  rename from `application_id` to `product_id` did not violate this because it was not performed in
  place: `0000_init.sql` creates the table in its final shape against an empty database, and the
  rows arrive by `INSERT`. From there the rule binds unchanged.

### Reviews and ratings

- **One review per person per product**, enforced by a unique index rather than by a service check.
  Editing replaces it, which is why the write is a `PUT` and not a `POST`.
- **Only somebody who obtained the product may write one**: an approved purchase, or a download on
  record for that account. `download_events.user_id` is null for an anonymous download — that is what
  makes a free build free — so only a download taken while signed in counts; matching by address
  instead is not identity. For a `free` product that leaves the bar low, and that is accepted: the
  structural mitigation is one review per person, the operational one is reports and hiding.
- **The anchor is the latest *stable* release**, falling back to the newest pre-release only for a
  product that has never shipped one. "The newest thing they could have downloaded" was the first
  shape this took and it is worse: a product publishing a build every night would anchor every
  review to last night's, so the rating window would move daily and a `resets_rating` release would
  be measured against something nobody installed. The sidebar names the latest stable version for
  the same reason, and a review and the version beside it should agree.
- **`anchored_at` is a snapshot, not a join.** It holds the anchor release's `published_at`, set on
  create and re-set on edit. It makes the rating window a scalar comparison with no join at all, and
  it survives the anchor release being deleted — which `release_id` does not.
- **The rating cutoff and the aggregate are one statement.** Two round trips means two snapshots, and
  an editor publishing a resetting release between them yields an average over a cutoff that no
  longer applies.
- **The cutoff expression is written once**, in `services/ratings.ts`, and imported by the
  single-product path, the batch path and the detail path. Two places computing it is two places to
  get the reset wrong, and the second is always the one nobody re-reads.
- **Nothing denormalises the rating onto `products`.** A cached average is a second thing that can
  disagree with the reviews, and it would have to be recomputed when a release is *published* — a
  reset changes every average without touching a single review, which is an invalidation nobody
  would remember to write.
- **`AVG()` over an empty set answers NULL, and that survives all the way out.** A product
  serializing `average: 0` would render as a one-star product on every listing card.
- **A release's own rating has no cutoff.** A reset says "the product changed"; it says nothing about
  how good version 1.4.0 was.
- **The reviewer's address is never serialized publicly.** It is the eligibility key, and a review is
  a public document; the two must not be the same field in the same response. The editor's address is
  left out of a reply for the same kind of reason — the page renders the product's name.
- **Hiding and deleting are separate audit events**, not one `review.moderated`: one is reversible
  and one is not. The delete snapshots what it removed onto the trail, because nothing else will.
- **One report per person per review.** A review is not more reportable because somebody pressed the
  button eight times, and `report_count` is what the queue sorts on. It is **recounted** from the
  reports table rather than incremented and decremented, so it cannot drift.
- **The reports queue is cross-product**, exactly as `GET /admin/purchases` is. It answers "what
  needs moderating anywhere", and nesting it would mean opening every product to find the problem.

### Analytics

- **A view is a POST on its own path, not a side effect of the GET.** The public reads carry
  `public, max-age=60`, so a cache hit never reaches this Worker: a counter in the read path would
  undercount by whatever the hit ratio happened to be.
- **A view is deduplicated in the Cache API, not in D1.** A dedup table means a write on every view —
  deduped or not — plus a purge job this Worker has no cron to run; `caches.default` expires by
  itself, and the token is bucketed on `floor(now / window)` so nothing has to expire it. The cost is
  that it is per-colo, so one person across two colos counts twice. **The view counter is an estimate
  of attention, not a record of people**; `download_events` is the exact record, and nothing
  financial is derived from either. The address is hashed into the token and never stored.
- **Each event writes two daily rows**, the product-wide one and the per-release one. Summing the
  per-release rows would not give the product total, because a view of the product page belongs to no
  release at all.
- **`ALL_RELEASES` is the empty string rather than NULL**, and not for style: SQLite treats NULLs as
  distinct inside a unique index, so `ON CONFLICT DO UPDATE` would never match the product-wide row
  and every event would insert a fresh one. Nothing compares against it directly — `isProductWide` is
  the one place that knows, the same discipline `UNLINKED_USER_ID` gets.
- **The admin series fills its zero days** in the service, the rule `summarizeSales` already states,
  and is bounded at a year so a mistyped date cannot turn a chart into a table scan.
- **`first_released_at` / `last_released_at` are derived, never stored.** Two columns would drift the
  moment somebody back-dates a release they forgot, and `released_at` is exactly the field editors do
  back-date.
- **`latest_version.purchase_count` is an approximation** — approved purchases since that release was
  published — and the README says so. A purchase entitles the whole product and never names a
  release, so there is no exact answer to give.

### Gate and infrastructure

- **Tokens are verified offline; the key set comes over the `AUTH` service binding.** `lib/jwks.ts`
  caches it per isolate for an hour. The binding is not optional: a Worker's subrequest to its own
  zone skips Workers routing and goes to the zone's origin, which does not exist, so the public JWKS
  URL answers `522` from in here. `test/functional/jwks-cache.test.ts` owns the cache for its whole
  run, which is why it cannot live in `admin-gate.test.ts`.
- **Four things must hold to get into `/admin`** (`requireEditor`): a valid unexpired signature from
  the auth issuer, an `aud` in `MARKETPLACE_ALLOWED_AUDIENCES`, a *verified* email whose full domain
  label is in `MARKETPLACE_ALLOWED_EMAIL_DOMAINS`, and the `marketplace:editor` permission. This is
  the second Worker here to check a permission, after `apps/support` and unlike `apps/cms`: a
  marketplace has *people* in it, and "everyone with a company address" is not a roster. The cost is
  staleness — `permissions` is a snapshot, so revoking an editor takes effect within one
  access-token lifetime. The domain check runs every request and is the harder boundary.
- **Two audience lists, never merged.** Merging them would leave the email-domain check as the only
  thing keeping a website token out of `/admin`. The account list has no domain gate at all, on
  purpose: the whole feature is that anybody can buy and anybody who bought can review.
- **`optionalAccount` lets a bad token through as anonymous** rather than refusing it — which grants
  strictly less, never more.
- **Token errors are redacted** (`describeTokenError`): several `hono/jwt` errors embed the offending
  token in their message.
- **5xx bodies are generic** (`onError`): an unexpected error here is usually a Drizzle failure whose
  message carries the full statement plus bound parameters.
- **Public routes only ever see `published`, and say 404 for anything else** — including the releases,
  wiki and reviews of a draft product. A 403 would confirm the slug of an unannounced product.
- **The Reviews listing is the one public read that is not cached.** A review published a second ago
  has to appear, and sixty seconds of staleness on the surface a person watches after writing is the
  wrong trade.
- **The release detail carries no per-caller access block**, so it stays cacheable. A shared cache
  keying only on the URL would otherwise serve one buyer's `can_download: true` to everybody. The
  per-person half is `GET /products/:slug/access?channel=…`, which is `no-store`.
- **A translation is drafted by Workers AI and written by a person.** `POST /admin/translate` writes
  nothing; a failed or unreadable answer is a **200 with `translation: null`**. The prompt is
  `@franciscosolis/translate`; the meter (`ai_requests`) and the hourly per-editor limit are this
  Worker's own. Workers AI is billed per neuron with no per-Worker spend cap, which is what the limit
  is for.
