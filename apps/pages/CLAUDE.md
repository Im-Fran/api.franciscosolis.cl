# CLAUDE.md

## LANGUAGE RULE — MANDATORY, NO EXCEPTIONS

ALL code, comments, variable/function names, commit messages, PR descriptions, and any
other written content in this repository MUST be in English. This applies regardless of
the language the user writes to Claude Code in. Never write Spanish (or any other
language) into files, commits, or code in this repo.

## Repo purpose

`pages` is the **Standalone App Pages** Worker for the `api.franciscosolis.cl` monorepo. Like
`landing`, `auth` and `cms`, it is not public: the root gateway (`apps/api`) reaches it through the
`PAGES` service binding and proxies `/pages/*` to it, so its public base URL is
`https://api.franciscosolis.cl/pages`. It lives at `apps/pages`.

It exists so that every application built here gets a product page to **one house standard** rather
than a bespoke site each time: a banner, a row of tabs under it, and the content behind them.
`franciscosolis.cl/application/<slug>` is what renders it.

An application page is four tabs, and the registry in `src/lib/tabs.ts` is the whole model:

- **Overview** — one centred Markdown document. Always present.
- **Updates** — release notes, newest release first, each with a version, a release date and its
  store or repository links.
- **Wiki** — documentation pages with a sidebar, nested at most one level deep.
- **Contact** — how to reach support, as one Markdown document beside the application's links.

An application can also **take money**: `free`, `donation` (optional payment) or `paid` (a download
needs an approved purchase), through MercadoPago Checkout Pro, with every payment tied to an account on
the franciscosolis.cl SSO. The builds are attached to the **Updates** tab and served by this Worker
against a per-request ticket, never from a bucket URL.

Reads of published pages are public (that is what the website calls); everything under `/admin`
requires an access token from `apps/auth`. Its editor is **a section of the CMS interface**
(`franciscosolis.cl/cms/pages`), not an application of its own, which is why the accepted audience
is the CMS's client id. The buyer-facing routes take a token from the *website's* client id instead, on
a second audience list.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`drizzle-orm/d1`), backed by the `franciscosolis_pages` database.
- **R2** (`RELEASES` → `franciscosolis-app-releases`) for the downloadable builds, and **MercadoPago
  Checkout Pro** over plain `fetch` for payments — no SDK, which is three functions in
  `src/lib/mercadopago.ts` rather than a dependency that assumes Node.
- Dependency versions come from the parent workspace's pnpm `catalog` — use `catalog:`, never a
  hardcoded version.
- `pnpm` install/deps are managed from the **monorepo root**.

## Commands (run from this directory, `apps/pages/`)

- `pnpm run dev` → `wrangler dev --ip 0.0.0.0 --port 8792 --inspector-port 9233`
- `pnpm run deploy` → `wrangler deploy --minify`
- `pnpm run cf-typegen` → run after editing `wrangler.jsonc` bindings.
- `pnpm run db:generate` → `drizzle-kit generate`, writes a new SQL migration.
- `pnpm run db:migrate:local` / `pnpm run db:migrate:remote` → apply migrations with Wrangler, and
  `pnpm run db:migrate:list` to see what is pending on the remote database. Production migrations
  are applied by `.github/workflows/migrate.yml` on a push to `dev`; these are for local work and
  for repairing a database that has drifted. See the root `CLAUDE.md`.

## Environment

This Worker holds **three secrets**, which is a change from how it started: `MERCADOPAGO_ACCESS_TOKEN`,
`MERCADOPAGO_WEBHOOK_SECRET` and `DOWNLOAD_SIGNING_KEY`. Token verification still needs no key of its
own — that is the auth Worker's public JWKS, read over the `AUTH` service binding — but taking money and
signing download links both do. They are set with `wrangler secret put`; `.dev.vars` (gitignored, copy
from `.dev.vars.example`) holds the local values, and never a live MercadoPago credential. Everything
else lives in `wrangler.jsonc` under `vars`.

## Source layout

- `src/index.ts` — Hono app: charset/cache middleware, `onError`, `GET /`, route mounting,
  `/openapi.json`.
- `src/db/schema.ts` — the entire D1 schema. `src/db/client.ts` builds a per-request client.
- `src/lib/` — `tabs.ts` (the tab registry), `links.ts` (the link vocabulary), `locales.ts` (the
  published languages and the translation-override rules), `jwks.ts` (offline token verification),
  `config.ts` (statuses, limits, TTLs), `validation.ts` (shared valibot fragments), `errors.ts`
  (unique-violation → 409), `slug.ts`, plus the payment half: `pricing.ts` (the three modes and the
  charge rules), `mercadopago.ts` (Checkout Pro and the webhook signature), `downloads.ts` (the signed
  download tickets and the cooldown), `files.ts` (the build vocabulary and the object keys).
- `src/middleware/auth.ts` — `requireEditor`, the editorial gate. `src/middleware/account.ts` —
  `requireAccount`/`optionalAccount`, the buyer's.
- `src/services/` — `applications.ts`, `updates.ts`, `wiki.ts` (including the sidebar tree and the
  hierarchy rule), `audit.ts`, `release-files.ts`, `purchases.ts`, `downloads.ts`, and `access.ts` —
  the one place that decides whether somebody may download.
- `src/routes/applications.ts` — the public reads; `store.ts` (pricing, access, checkout, `/me/*`),
  `downloads.ts` (the file list, the ticket, the bytes) and `payments.ts` (the webhook) are the paid
  half; `src/routes/admin/` is the editorial API.
- `migrations/` — `0000_init.sql`, `0001_payments_and_downloads.sql` and `0002_chargebacks.sql`,
  generated by drizzle-kit.

## Architecture notes (non-obvious)

- **A tab is a registry entry, never a per-application layout field** (`src/lib/tabs.ts`). That is
  the "house standard" the Worker exists to enforce: an application picks a subset of the same four
  tabs, in an order, and nothing else about its shape is configurable. The day a page needs a fifth
  kind of tab, it is an entry here plus the route that serves it — the moment a page can describe
  its own layout, the set of pages stops being a standard.
- **`overview` is forced into the tab list and forced to the front** (`normalizeTabs`). A page
  without it is a banner and a row of links; every other tab is something a visitor reaches after
  deciding the application is for them.
- **Unknown tab keys are dropped on read, not rejected** (`parseTabs`). The read path runs over
  whatever is in the column, so a tab key retired in a later version of this Worker degrades to "one
  tab fewer" rather than 500-ing the application it was left on. The *write* path is strict.
- **Overview and Contact are columns; Updates and Wiki are tables.** There is never more than one of
  either document, so splitting them out would buy a join for nothing. That asymmetry is what the
  `source` field on a tab definition tells a front-end.
- **This schema uses foreign keys, unlike the CMS's.** An update or a wiki page only means anything
  as part of one application, and an orphan would be invisible to every route here while still
  holding its slug. `ON DELETE cascade` is what makes `DELETE /admin/applications/:id` take its
  contents with it — release files included.
- **`purchases`, `payment_events` and `download_events` are the exception, and deliberately so.** They
  carry **no** foreign key onto `applications`: a payment is a financial record and a download is
  something that happened, and deleting a product page must not erase either. The application's slug,
  the release's version and the filename are snapshotted onto those rows instead, which is what keeps
  them readable once the page is gone.
- **The wiki tree is two levels deep by rule rather than by schema** (`resolveParentId` in
  `src/services/wiki.ts`). A self-referencing column cannot express a depth limit. Four shapes are
  refused with a 422: a parent in another application, a page as its own parent, a parent that is
  itself nested, and nesting a page that already has children.
- **`parent_id` carries no foreign key onto its own table, deliberately.** A page is reparented far
  more often than an application is deleted, and a cascade there would delete a section's
  documentation along with the heading. `DELETE` on a wiki page therefore promotes its children
  explicitly before removing the row.
- **A page whose section is absent is promoted, not dropped** (`buildWikiTree`). On the public
  routes that case is normal rather than exceptional — a section left as a draft takes its children
  out of the visible set — and losing them entirely would make an unpublished heading hide published
  documentation.
- **Updates are ordered by `released_at`, not by `created_at` or `published_at`.** An editor writing
  up three versions in one sitting would otherwise get them in typing order, and back-dating a
  release somebody forgot would silently put it at the top. A release published with no date of its
  own is dated *now*, because an undated release sorts below every dated one.
- **A version is free text, not semver** (`versionInput` in `routes/admin/updates.ts`). This Worker
  fronts a Minecraft plugin and a mobile app equally well, and `2.6.4`, `v3`, `2026.1` and
  `1.0-beta` are all somebody's real version. What it may not contain is whitespace or a slash — it
  is a path segment on the public route.
- **Every nested route is scoped by its application** (`/admin/applications/:applicationId/…`). That
  is not decoration: it is what stops an id from one application being read, edited or deleted
  through another's URL, and it makes a 404 mean the same thing whichever half of the pair is wrong.
- **Link kinds are a closed vocabulary** (`src/lib/links.ts`), because the website renders an icon
  from `kind` and a free-form string is a list of icons nobody can finish. `other` is the escape
  hatch. Links live as JSON on the row rather than in a table: a handful per row, always read with
  it, always replaced wholesale.
- **Tokens are verified offline; the key set comes over the `AUTH` service binding.** `lib/jwks.ts`
  caches the key set per isolate for an hour, and a `kid` that is not in it forces one refetch
  before failing — which is what a key rotation looks like from here. The binding is not optional: a
  Worker's subrequest to its own zone skips Workers routing and goes to the zone's origin, which
  does not exist, so the public JWKS URL answers `522` from in here. `test/functional/jwks-cache.test.ts`
  owns the cache for its whole run, which is why it cannot live in `admin-gate.test.ts`.
- **Three things must hold to get in** (`requireEditor`): a valid unexpired signature from the auth
  issuer, an `aud` in `PAGES_ALLOWED_AUDIENCES`, and a *verified* email whose domain is in
  `PAGES_ALLOWED_EMAIL_DOMAINS`. Domain matching is on the full domain label, never a suffix.
- **Token errors are redacted before they are returned** (`describeTokenError`): several `hono/jwt`
  errors embed the offending token in their message, which would echo a live credential into a
  response body and any log that captures it.
- **5xx bodies are generic** (`onError`): an unexpected error here is usually a Drizzle failure whose
  message carries the full statement plus bound parameters — which for this Worker means the body of
  a page an editor has not published yet.
- **Public routes only ever see `published`, and say 404 for anything else** — including for the
  updates and the wiki of a draft application, which hides everything behind its tabs, not just its
  own row. A 403 would confirm the slug of an unannounced product. They are also the only responses
  with a `public` Cache-Control; the global middleware defaults everything else to `no-store`.
- **`published_at` is stamped once**, the first time a page or a release goes live, and kept through
  later unpublish/republish cycles — it records when the thing was announced, not when it was last
  toggled.
- **The site is bilingual by override, not by row** (`src/lib/locales.ts`), exactly as in the CMS.
  The row *is* the default locale (`en`) and `translations` holds `{"es":{"name":"…"}}` for the
  rest. The one difference from the CMS's module: the translatable field set is a **parameter**,
  because three different kinds of row are translated here and each has its own prose fields.
- **Pricing is a registry of three modes, and that is the same decision as the tab registry**
  (`src/lib/pricing.ts`): `free`, `donation`, `paid`. Tiers, regional prices, subscriptions and upgrade
  paths are absent on purpose — each one turns a product page into a store. `parsePricingMode` falls
  back to `free` on an unknown value, which is the direction that grants the least, and
  `describePricing` nulls the price of an application that is not currently `paid` so a stale column
  can never be quoted. The column itself is kept, because an editor switching modes for a launch week
  should not have to retype it.
- **Every decision about whether somebody may download is made in `services/access.ts`.** Two routes
  need it — the status endpoint the website polls, and the one that mints a ticket — and a second place
  deciding it is a second place to get it wrong. The one that gets it wrong gives a paid build away.
- **A non-payer sees the offer every time, without exception.** That is a product rule, not an
  implementation detail: `mustOfferPayment` derives it from the mode and the entitlement, so no route
  can quietly make an exception of itself, and no client can ask it not to.
- **The download is a Worker route because a URL cannot be asked a question.** A public bucket or a
  presigned R2 link cannot be asked whether the holder paid, nor made to wait five seconds. So the
  bucket has no public access, `object_key` is never serialized into any response shape (see
  `toPublicReleaseFile`), and the only way to the bytes is `GET /downloads/:ticket`.
- **The five-second cooldown is `nbf` on the ticket** (`src/lib/downloads.ts`), not a timer on the
  page. A non-payer's ticket is minted five seconds in the future and answers `425 Too Early` until
  then — a `setTimeout` is something anybody can step over in the dev tools. A payer's ticket starts
  immediately, and that is the whole difference between the two experiences once the modal is gone.
- **Tickets are signed, not stored.** A row per click would be a D1 write on the hot path of a file
  download, and a second to mark it used. Nothing is revocable as a result, which is exactly why a
  ticket lives five minutes: the short window *is* the mitigation for a shared link.
- **Metadata and bytes are two requests** (`routes/admin/files.ts`). Multipart would mean buffering a
  90 MB installer to parse a form inside a 128 MB isolate, and it would leave no way to replace a
  build's bytes without recreating the row a published release already links to. The bytes are streamed
  into R2, the size is read back off the stored object, and a declared `X-Checksum-Sha256` is handed to
  R2 to verify rather than computed here — which would need the whole file in memory.
- **A file with no upload is invisible everywhere and cannot be published.** `uploaded_at` being null
  is what "not ready" means, and publishing one would put a download that 404s on the Updates tab.
- **The webhook is the only unauthenticated write here, and three things guard it**
  (`routes/payments.ts`): MercadoPago's `x-signature` over the manifest it actually signs; a *fetch of
  the resource* with our own credential, because the notification body is not evidence and anybody can
  post one claiming an approval; and a unique key that makes a retry a no-op which still answers 200 —
  anything else has the provider retrying forever. With no secret configured it refuses everything:
  the endpoint that can grant a licence fails closed.
- **Three topics, two generations of the provider's model, on purpose.** MercadoPago is replacing its
  payment-centric notifications with order-centric ones and offers both as separate dashboard
  checkboxes, so this Worker reads `payment` (`/v1/payments/:id`), `order` (`/v1/orders/:id`) and
  `topic_chargebacks_wh` (`/v1/chargebacks/:id`). Supporting all three costs one `switch`, and it is
  what makes the day "Pagos (legacy)" is switched off a configuration change rather than an outage in
  which payments silently stop being credited. What is deliberately *not* migrated is preference
  creation: `POST /checkout/preferences` is still how a Checkout Pro flow is started, and the orders
  API is a different integration whose checkout this Worker does not use.
- **The idempotency key is built from the payment id wherever one is known**, not from the topic. An
  account with both `payment` and `order` enabled gets two notifications describing the same money;
  keying both on `<payment>:<status>` means the transition is applied once and logged once. An order
  with no payment yet (still `created`, or expired unpaid) keys on the order instead, because there is
  nothing else to key on and it cannot collide with a payment.
- **`processed` is the orders API's word for "the money is in"**, and it is the only order status that
  entitles. `canceled` and `expired` both collapse onto `cancelled` — the difference is whether the
  payer walked away or ran out of time, and neither produced a payment. An unknown status maps to
  `pending` in both mappers, never to `approved`: the provider adds states without asking.
- **A chargeback is not a refund, and the column says so.** Both end the entitlement, but a refund is
  us giving money back and a chargeback is the payer's bank taking it, with a fee and a dispute
  deadline attached. Collapsing them would make "how often is this disputed" unanswerable, which is
  the number that decides whether an application should be sold at all. Hence the `charged_back`
  status, `charged_back_at` beside `refunded_at`, and `chargeback_id` for tracing it to their console.
  `approved_at` survives all of it: "this was paid, and then it was taken back" is what a dispute needs
  to be able to say.
- **The signature manifest's lowercasing is not settled upstream.** MercadoPago's own SDKs disagree
  (sdk-go lowercases `data.id`, sdk-java does not — mercadopago/sdk-java#420), and it only became
  visible with the orders API, whose ids are uppercase where payment ids are numeric; that same issue
  reports order notifications failing validation under *either* rule. So a refusal here may be ours or
  theirs, which is why the 401 path logs the topic — "orders are refused and payments are not" is the
  shape of that bug and is otherwise invisible. What it must never do is skip the check to find out:
  the read-back is what makes a notification *harmless*, not what makes it *authentic*.
- **An approved payment *is* the entitlement.** No `entitlements` table, so a refund is a status change
  on the row that already exists rather than two writes that have to agree, applied in the right order,
  from a notification that arrives more than once. `findActivePurchase` matches on the account id *or*
  the verified address, so what somebody bought survives a change of sign-in provider.
- **Buying requires signing in first, and that is what ties a payment to the SSO.** This Worker cannot
  create an account and must never be able to — it has no binding into the auth database, exactly as
  `apps/support` has none. "Buying creates an account" is the website's magic-link sign-in doing its
  usual job before checkout; what arrives here is a verified token, which is the only moment the link
  between a payment and a person can be made at all.
- **Two audience lists, like `apps/support`'s** (`PAGES_ALLOWED_AUDIENCES` for editors,
  `PAGES_ACCOUNT_AUDIENCES` for buyers). Merging them would leave the email-domain check as the only
  thing keeping a website token out of `/admin`. The buyer list has no domain gate at all, on purpose:
  the whole feature is that anybody can pay. `verifyAccessToken` therefore takes the list as a
  parameter rather than reading one off `env`, so widening one can never silently widen the other.
- **`optionalAccount` lets a bad token through as anonymous** rather than refusing it. A free or
  optional-pay build is downloadable by anybody, and a sign-in wall in front of software that does not
  need one is worse than an unrecognised token — which grants strictly less, never more.
- **`GET /admin/purchases` is read-only, and there is no endpoint that marks a payment approved.** One
  would be an endpoint that grants a licence without a payment, which is the thing the signature check
  exists to prevent. A refund is issued in MercadoPago's console and arrives as a notification.
- **A pricing change is its own audit event** (`pricing.updated`), not folded into
  `application.updated`: it is the one edit here that changes what somebody is charged, and a trail it
  can be read out of has to be queryable by event.
- **Only prose is translated, never structure.** Which tabs a page has, its slug, its ordering, a
  release's version number and a wiki page's icon are the same fact in every language. A page that
  shows a Wiki tab in English and not in Spanish is a bug, not a translation. A price is not prose
  either: it is one amount in CLP, and `CURRENCY` is a constant rather than a column on the row.
- **Amounts are integers of whole pesos.** CLP has no minor unit, so `unit_price: 1990` is 1990 pesos
  here and would be 19.90 anywhere with cents — which is why nothing in this Worker holds a float.
