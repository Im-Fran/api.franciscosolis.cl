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

Around those payments it also runs a **back office**, per application: the sales of one application,
sales *recorded by hand* for money taken in cash or by transfer or a copy given away, the **vouchers**
(receipts) issued for them, and refunds — including the statutory *derecho a retracto*. None of that is
a fifth tab: the four above are what a visitor sees, and the takings are an editorial section
(`franciscosolis.cl/cms/pages/<id>/sales`) that the tab registry knows nothing about.

Reads of published pages are public (that is what the website calls); everything under `/admin`
requires an access token from `apps/auth`. Its editor is **a section of the CMS interface**
(`franciscosolis.cl/cms/pages`), not an application of its own, which is why the accepted audience
is the CMS's client id. The buyer-facing routes take a token from the *website's* client id instead, on
a second audience list.

## Stack

- Cloudflare Workers, Hono 4, hono-openapi + valibot, Wrangler 4, TypeScript strict.
- **Drizzle ORM** over D1 (`drizzle-orm/d1`), backed by the `franciscosolis_pages` database.
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

**`MERCADOPAGO_ENVIRONMENT` is the one var that must be right, and it is a var rather than a guess.**
It is `live` at the top level and `sandbox` under `env.dev`, and it decides two things: which of the two
URLs a created preference is answered with, and what is stamped onto every purchase. A *test*
credential answers a preference with **both** `init_point` and `sandbox_init_point`, and they are
different checkouts — only the second is the one the provider's test cards work on. So "it has a test
token, therefore it is a test payment" was never true on its own, and inferring the environment from the
shape of the credential does not work either: a test *user*'s application credential is spelled exactly
like a production one. Local `wrangler dev` inherits the top-level `live`, which is why
`.dev.vars.example` overrides it — without that line a local test preference sends the browser to the
live URL and the test cards are refused there.

`MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` are the voucher's sender. Only one address is listed in
`allowed_sender_addresses`, because unlike the CMS nothing here lets a request choose a sender. It is
restated in the `test` environment too — Miniflare implements that binding locally, and leaving it out
would make `env.EMAIL` undefined, which the voucher path swallows: a suite that passes while never
sending a receipt.

## Source layout

- `src/index.ts` — Hono app: charset/cache middleware, `onError`, `GET /`, route mounting,
  `/openapi.json`.
- `src/db/schema.ts` — the entire D1 schema. `src/db/client.ts` builds a per-request client.
- `src/lib/` — `tabs.ts` (the tab registry), `links.ts` (the link vocabulary), `locales.ts` (the
  published languages and the translation-override rules), `jwks.ts` (offline token verification),
  `config.ts` (statuses, limits, TTLs), `validation.ts` (shared valibot fragments), `errors.ts`
  (unique-violation → 409), `slug.ts`, plus the payment half: `pricing.ts` (the three modes and the
  charge rules), `mercadopago.ts` (Checkout Pro, the webhook signature, the refund call and the
  environment), `downloads.ts` (the signed download tickets and the cooldown), `files.ts` (the build
  vocabulary and the object keys), and `sales.ts` — the *administrative* half: where money came from,
  the environment it came in on, the refund reasons, the statutory withdrawal window and the voucher
  numbering. `pricing.ts` decides what somebody is charged; `sales.ts` is about a sale once it exists.
- `src/middleware/auth.ts` — `requireEditor`, the editorial gate. `src/middleware/account.ts` —
  `requireAccount`/`optionalAccount`, the buyer's.
- `src/services/` — `applications.ts`, `updates.ts`, `wiki.ts` (including the sidebar tree and the
  hierarchy rule), `audit.ts`, `release-files.ts`, `purchases.ts`, `downloads.ts`, and `access.ts` —
  the one place that decides whether somebody may download. The back office adds `sales.ts` (manual
  sales, refunds, the totals), `vouchers.ts` (issuing, re-issuing, sending, voiding) and `mail.ts` (the
  one send path), and `ai.ts` is the translation drafts' meter and rate limit.
- `src/routes/applications.ts` — the public reads; `store.ts` (pricing, access, checkout, `/me/*`),
  `downloads.ts` (the file list, the ticket, the bytes) and `payments.ts` (the webhook) are the paid
  half; `src/routes/admin/` is the editorial API, where `purchases.ts` is the read-only listing across
  every application, `sales.ts` is the per-application back office and `translate.ts` drafts one
  translated field.
- `migrations/` — `0000_init.sql`, `0001_payments_and_downloads.sql`, `0002_chargebacks.sql`,
  `0003_ai_requests.sql` and `0004_manual_sales_and_vouchers.sql`, generated by drizzle-kit.

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
- **`GET /admin/purchases` is still read-only, and it is now the *cross-application* listing.** It
  answers "everything that ever came in", whatever product it came in for, and a total over it is the
  only thing it is for. Administering the sales of one application lives under that application
  (`routes/admin/sales.ts`), exactly as the updates and the wiki do — which is what stops a sale of one
  product being read, refunded or receipted through another's URL.
- **There *is* now an endpoint that writes an approved payment, and the reason the old rule said there
  must not be still holds.** That rule was about the webhook: it is public, so it believes nothing it is
  told and reads every status back from the provider. `POST /admin/applications/:id/sales` is a
  different endpoint with different trust — behind `requireEditor`, so a verified token minted for the
  CMS audience carrying an allowed email domain — and three things make each row it writes visibly what
  it is: `created_by` names the editor, `provider` is `manual` rather than `mercadopago`, and `source`
  says on its face which channel the money came through. It is also its own audit event carrying the
  amount. Money genuinely does change hands outside MercadoPago (cash at a stand, a transfer, a copy
  given away), and the alternative to recording it is not "no unverified approvals" — it is a
  spreadsheet beside the database, which nothing can refund from and which grants no download.
  What stays refused: setting a status directly, editing an amount, and recording a sale whose `source`
  claims MercadoPago took it.
- **A refund can now be issued from here, and the order of the two writes is the whole point**
  (`refundSale`). For a MercadoPago sale the provider is asked *first* and the row is written second: a
  row marked refunded for money that never moved is a buyer who has lost their download and is still
  out of pocket. For a manual sale there is nothing to ask. The notification that follows applies the
  same transition again and lands on the timestamps already stamped, because `applyPaymentStatus` keeps
  the first of each. The idempotency key is the purchase *and the amount*, so a double-click is one
  refund while a deliberate second partial refund still goes through.
- **`MERCADOPAGO_ENVIRONMENT` is stamped on the purchase, not read off the configuration when the row
  is displayed** — because the configuration is the thing that changes. It keeps a test payment out of a
  revenue total, and it is what lets a refund refuse before it asks: the provider answers 404 for an id
  from the other account, which is indistinguishable from a payment that never existed. `checkoutUrlFor`
  is the other half; see *Environment* above for why the credential cannot be sniffed instead.
- **The withdrawal window is a constant, not a setting** (`WITHDRAWAL_DAYS` in `src/lib/sales.ts`). Ley
  19.496 art. 3 bis b) gives a consumer ten days to withdraw from a distance sale, and a digital licence
  bought on a web page is exactly that. It is not ours to shorten, and an editor who could would
  eventually. Every admin view of a sale carries `withdrawal` — deadline, days left, whether it is still
  open — with `days_left` rounded **up**, so the last partial day reads as one day rather than zero: a
  buyer whose right expires in four hours has not lost it, and an editor told "0 days left" would refuse
  a refund they are obliged to give. `withdrawal` is also its own refund reason, kept apart from the
  others so "how many of these were obligatory" stays answerable.
- **A voucher is a document, not a view of the sale** (`src/services/vouchers.ts`). Everything it prints
  — the amount, the address, the application's name — is copied onto the row when it is issued, because
  a receipt emailed in March has to still say in December what it said then, for a sale whose price has
  since changed and whose application page may since have been deleted. It follows that a voucher is
  **never edited and never deleted**: every copy already in an inbox would become a forgery of the row.
  Correcting one is a re-issue, which voids the previous and takes the next number — which is why there
  are two statuses and no third, and why `sale_vouchers` has no `PATCH`.
- **At most one voucher is live per sale, and issuing voids the previous one first, in that order.** Two
  valid receipts for one payment is how the same sale gets claimed twice.
- **Voucher numbers are counted out of the table, per year, and retried on collision.** A counter row is
  a second thing that can disagree with the vouchers themselves, and there is no volume here that makes
  `count(*)` expensive. The unique index is what actually guarantees the number: two editors issuing in
  the same instant both read the same count, one loses the insert, and the loser counts again. The count
  matches on the number's own prefix (`FS-2026-`) rather than on `issued_at`, so correcting an issue
  date cannot move a voucher into another year's sequence.
- **A send is counted only after it resolves.** A voucher claiming three sends when two of them failed
  is worse than one that says nothing — this number is read when somebody insists they never received
  it. A failed send is returned to the editor, who is looking at the screen, and is not recorded.
- **The voucher issued on an approved payment swallows its own failures** (`issueVoucherForApproval`).
  The webhook has to answer 200 or MercadoPago retries forever, and a receipt that did not render is not
  a reason to re-apply a payment that was already applied. The sale is left with no live voucher, which
  is a state the Sales screen shows and one click fixes.
- **A manual sale may carry no account, and the column is still `NOT NULL`.** `UNLINKED_USER_ID` (the
  empty string) is the sentinel, and nothing compares against it directly — `isLinkedToAccount` is the
  one place that knows. A nullable column would have meant rebuilding `purchases` in SQLite, and a
  `DROP TABLE`/rename on that table races the production deploy (see the root `CLAUDE.md`): for the
  length of it every paid download would 404 rather than degrade. Every migration on this table stays
  additive because of that. The row is found by its address instead, which is what `findActivePurchase`
  already matches on, and the account is attached later through `PATCH …/sales/:saleId`.
- **Only three things about a settled sale are editable**: the address, the account and the note. The
  amount, the status, the source and the dates are what the sale *is* — correcting one of them is a
  refund and a new sale, not an edit, and a field for it would be a field that rewrites history with no
  trace of the previous value.
- **`occurredAt` on a manual sale sets `approved_at` *and* `created_at`.** A sale entered a week late
  whose statutory ten days ran from the day it was typed would give the buyer three days too many, and
  one entered early would take days off them; a date-bounded total would be wrong in the same way.
- **The summary is grouped in the database, over the same clauses as the listing** (`summarizeSales`,
  sharing `purchaseClauses`). A total computed over a different `WHERE` than the table under it is a
  screen whose figure does not match its rows. It reports three figures rather than one because "how
  much did this make" has three honest answers: `gross` is what ever settled, `returned` is what went
  back out, `net` is the difference — and quoting the first as revenue counts a refund as income. A
  chargeback returns the whole sale regardless of the disputed amount, because the fee is not modelled
  and the conservative reading is the correct one. Every bucket of the closed sets is present at zero
  rather than absent, so a front-end renders a stable set of rows.
- **This Worker sends mail and has no inbox.** `services/mail.ts` is deliberately far smaller than the
  CMS's equivalent, and the difference is the reason: the CMS sends *editorial* mail, where a person
  picks a sender and fills a template, so it validates an allowlist and logs every message. Nothing here
  is composed by a person — the body comes from `@franciscosolis/emails`, the recipient is the address on
  the sale, and the sender is the one configured address. `sale_vouchers.sent_count`/`last_sent_at`
  already answer "did it go out, and when" for the only document there is.
- **A pricing change is its own audit event** (`pricing.updated`), not folded into
  `application.updated`: it is the one edit here that changes what somebody is charged, and a trail it
  can be read out of has to be queryable by event.
- **A translation can be drafted by Workers AI, and the route that drafts it writes nothing.**
  `POST /admin/translate` takes one field's *name* and its text and answers with a string, which is
  why one route serves all three kinds of row here: an application, a release note and a wiki page
  have different field sets and the same three kinds of prose. The draft is saved through the
  ordinary PATCH that saves every other override, so a model outage cannot corrupt a page, nothing
  machine-translated is published without somebody having read it, and a failed or unreadable answer
  is a **200 with `translation: null`** rather than an error status.
  The prompt is `@franciscosolis/translate`, shared with `apps/cms` and `apps/support`. What is this
  Worker's own is `src/services/ai.ts`: the meter (`ai_requests`) and the hourly per-editor limit read
  off it. `ai_requests` is the one table here with **no foreign key** onto anything — a metered call
  is a fact about spend, not about the page whose field happened to be translated, and it has to
  outlive that page. **Workers AI is billed per neuron with no per-Worker spend cap**, which is what
  the limit is for; the row is written whether the call succeeded or not for the same reason.
- **`TRANSLATABLE_FIELD_LIMITS` in `lib/config.ts` takes the smaller cap where two rows share a field
  name** — `body` is a release note's 50 000 rather than a wiki page's 200 000 — because the field
  name is all the translation route is told, and the conservative number is always a valid answer for
  either. It never bites: a translation is bounded far below both by `TRANSLATION.maxSourceChars`.
- **Only prose is translated, never structure.** Which tabs a page has, its slug, its ordering, a
  release's version number and a wiki page's icon are the same fact in every language. A page that
  shows a Wiki tab in English and not in Spanish is a bug, not a translation. A price is not prose
  either: it is one amount in CLP, and `CURRENCY` is a constant rather than a column on the row.
- **Amounts are integers of whole pesos.** CLP has no minor unit, so `unit_price: 1990` is 1990 pesos
  here and would be 19.90 anywhere with cents — which is why nothing in this Worker holds a float. A
  manual sale is the one place zero is a valid amount: that is what a gift is, and the floor in
  `AMOUNT_LIMITS` exists because a provider's fee would eat a smaller payment, which does not apply when
  no provider was involved.
- **A refund has a column of its own rather than an edit to `amount`** (`refunded_amount`). A partial
  refund is a real case — a donor refunded down to what they meant to give — and overwriting what was
  charged would misstate the sale in every total that reads it afterwards.
