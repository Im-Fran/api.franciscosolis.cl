<div align="center">

# 🛍 marketplace — the storefront

**Internal Cloudflare Worker behind `api.franciscosolis.cl/marketplace`: one product page per thing built here, all to the same house standard — a banner, a tab bar, the content behind it, and a sidebar that says whether it is worth your time.**

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE)

</div>

---

## 📖 Overview

`marketplace` is where the things built at **franciscosolis.cl** are published, paid for and
downloaded. It is not exposed to the public internet directly: the root gateway Worker
(`apps/api`) reaches it through a Cloudflare **service binding** and proxies `/marketplace/*`, so
its public base URL is `https://api.franciscosolis.cl/marketplace`. The website renders it at
`franciscosolis.cl/product/<slug>`.

It replaced `apps/pages`, which was the same Worker under a smaller name. A product page is still a
banner, a handful of links and a subset of tabs in the order the product picked — that part is the
house standard and it has not moved. What is new is everything a *store* needs and a product page
did not: **reviews** by the people who actually obtained it, **release channels** so a nightly and a
stable build can coexist without pretending to be the same thing, **compatibility** declared per
version rather than per product, **analytics**, and a **category**.

A product can **take money**. It is `free`, `donation` (optional payment — the build is free to take
and the modal offering to pay for it says so) or `paid` (a download needs an approved purchase).
Payments go through **MercadoPago Checkout Pro**, every payment is tied to an account on the
franciscosolis.cl SSO, and the builds are served by this Worker against a per-request ticket rather
than from a bucket URL — the only arrangement that can be asked whether the person downloading paid.

A `donation` product can also reserve its **pre-release lines for supporters**
(`pre_release_requires_purchase`). That is the one incentive that does not cost a non-payer the
product: the stable build stays free to take, and the nightlies are what paying gets you.

Around those payments it runs a **back office**, one per product: every sale, sales *recorded by
hand* for money that arrived in cash or by transfer (or a copy given away), the **vouchers** —
receipts — issued for them, and refunds, including the statutory *derecho a retracto*.

Reading published products is **public**. Everything under `/admin` needs an access token issued by
[`apps/auth`](../auth/README.md) for the **marketplace console's** own client application, carrying
an `@franciscosolis.cl` address *and* the `marketplace:editor` permission. Buyers and reviewers use a
token from the **website's** client id instead, on a deliberately separate audience list with no
domain gate at all — the whole point is that anybody can buy, and anybody who bought can review.

---

## ✨ Features

- **A tab registry, not a per-page layout** — `src/lib/tabs.ts` is the entire model. A product turns
  on the subset it wants, in an order; the day a page can describe its own shape, the set of pages
  stops being a house standard. `reviews` is a fifth entry in that registry and nothing else about it
  changed to accommodate one. The Overview **sidebar** is deliberately *not* a tab: it is chrome
  beside the banner, like the links row.
- **Four release channels** — `nightly`, `beta`, `rc`, `release`, ordered by how finished they are. A
  channel is not a status: `draft`/`published` decides whether anybody may see a release, the channel
  decides how much they should trust it. The channel is part of the version key, so `1.4.0` can exist
  as an `rc` and, a week later, as a `release`. The public feed shows the stable line unless
  `?channel` asks for more, and every channel is readable by anybody — only the *download* can be
  reserved.
- **Compatibility per release** — what a version runs on, as a typed list (`os`, `runtime`,
  `platform`, `dependency`, `hardware`, `architecture`). Per release and never per product, because a
  release is exactly where support is added and dropped. `constraint` is free text on purpose, for
  the same reason a version label is.
- **Reviews, anchored to a version** — one per person per product, written only by somebody who
  bought or downloaded it, published immediately, answerable once by the owner, and flaggable by
  readers into a cross-product moderation queue.
- **A rating that can be restarted** — publishing a release marked `resets_rating` restarts the
  average, App Store style. It **deletes nothing**: every earlier review is still stored, still
  readable, and each one says which side of the line it falls on.
- **Views and downloads, counted** — totals on the product and on each release, plus a daily series
  behind them. A view is a POST rather than a side effect of the cached read, and is deduplicated per
  viewer in the Cache API; it is an estimate of attention, not a record of people.
- **Release notes ordered by release date** — `released_at`, never `created_at`, so writing three
  versions up in one sitting does not file them in typing order. A version is free text (`2.6.4`,
  `v3`, `2026.1`, `1.0-beta`); what it may not contain is whitespace or a slash, because it is a path
  segment.
- **Downloads that can be asked a question** — the bucket has no public access, `object_key` is never
  serialized, and the only way to the bytes is a signed, five-minute ticket whose `nbf` *is* the
  cooldown.
- **A webhook that believes nothing** — signature, then a read of the resource back from MercadoPago
  with our own credential, then an idempotency key. With no secret configured it refuses everything.
- **Bilingual by override** — the row is `en` and a `translations` column holds the rest. Public reads
  take `?locale` and resolve it server-side. Only prose: a category key, a channel and a version
  number are the same fact in every language.
- **A translation drafted by Workers AI and written by a person** — `POST /admin/translate` answers
  with a string and writes nothing.

---

## 🛠 Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Cloudflare Workers (`nodejs_compat`) |
| Framework | Hono 4 + hono-openapi |
| Validation | valibot |
| Database | D1 (`franciscosolis_marketplace`) through Drizzle ORM |
| Object storage | R2 (`franciscosolis-app-releases`), no public access |
| Payments | MercadoPago Checkout Pro, over plain `fetch` |
| Email | Cloudflare Email Sending + `@franciscosolis/emails` (the voucher, and nothing else) |
| Machine translation | Workers AI + `@franciscosolis/translate` |
| View deduplication | The Cache API (`caches.default`) |
| Tests | Vitest inside `workerd` (`@cloudflare/vitest-pool-workers`) |

---

## 🚀 Getting Started

### 1. Create the databases and apply migrations

The D1 databases do not exist until somebody creates them, and their ids go into `wrangler.jsonc` —
the ones committed there are placeholders.

```bash
wrangler d1 create franciscosolis_marketplace
wrangler d1 create franciscosolis_marketplace_dev
cd apps/marketplace && pnpm run db:migrate:local
```

### 2. Register the console's client application

`/admin` is a 401 for everybody until `franciscosolis-marketplace` exists as a client application in
the auth database of each environment, with `marketplace:editor` granted to the editorial accounts.
That is the correct failure and an invisible one, so it is written down here.

### 3. Fill in the secrets

```bash
cp .dev.vars.example .dev.vars
```

Use a MercadoPago **test** credential locally, and keep `MERCADOPAGO_ENVIRONMENT=sandbox` beside it —
without that line a local preference hands the browser the *live* checkout URL and the provider's
test cards are refused there.

### 4. Run it

```bash
pnpm run dev   # :8794, inspector on :9235
```

Through the local gateway that is `http://localhost:8787/marketplace`.

---

## 📡 API

### Public

Unauthenticated, only ever `published` rows, and each takes an optional `?locale=en|es`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | Every closed vocabulary: tabs, link kinds, channels, categories, compatibility kinds, locales, pricing modes |
| `GET` | `/products` | Published products, without the tab bodies |
| `GET` | `/products/:slug` | One page: banner, tabs, links, category, Overview and Contact |
| `GET` | `/products/:slug/overview` | **The sidebar** — see the contract below |
| `GET` | `/products/:slug/releases` | Release notes, newest first. `?channel=nightly\|beta\|rc\|release\|all`, default `release` |
| `GET` | `/products/:slug/releases/:channel/:version` | **One release in full** — see the contract below |
| `GET` | `/products/:slug/releases/:channel/:version/files` | The builds attached to a release |
| `GET` | `/products/:slug/wiki`, `/wiki/:page` | The sidebar tree, and one page with its Markdown |
| `GET` | `/products/:slug/reviews` | **The Reviews tab** — see the contract below |
| `GET` | `/products/:slug/pricing` | What the product costs — the same answer for everybody |
| `POST` | `/products/:slug/views` | Counts one view. `204` whether or not it was deduplicated |

### Store and reviews (Bearer token from the **website**)

An access token minted for the website's client application, on the `MARKETPLACE_ACCOUNT_AUDIENCES`
list — never the editorial one.

| Method | Route | Token | Description |
|--------|-------|-------|-------------|
| `GET` | `/products/:slug/access` | optional | Whether *this* caller may download, and why not. `?channel` asks about one line |
| `POST` | `/products/:slug/files/:fileId/download` | optional | Mints a download link, with the cooldown baked in |
| `GET` | `/downloads/:ticket` | — | The bytes. `425` until the cooldown elapses, `410` once expired |
| `POST` | `/products/:slug/checkout` | required | Opens a MercadoPago payment and answers where to send the browser |
| `GET` | `/products/:slug/reviews/me` | optional | The caller's own review, and whether they may write one |
| `PUT` | `/products/:slug/reviews` | required | Writes or replaces the caller's review |
| `DELETE` | `/products/:slug/reviews` | required | Withdraws it |
| `POST` | `/products/:slug/reviews/:id/report` | required | Flags a review. One per person per review |
| `GET` | `/me/purchases`, `/me/purchases/:id` | required | The account's purchase history |
| `GET` | `/me/downloads`, `/me/vouchers` | required | What it downloaded, and the receipts issued to it |
| `POST` | `/payments/mercadopago/webhook` | signature | MercadoPago's notifications |

### Editorial (Bearer token from the **marketplace console**, with `marketplace:editor`)

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/admin/me`, `/admin/audit` | The caller, and the audit trail |
| `GET` `POST` | `/admin/products` | Every product in every state; create one |
| `POST` | `/admin/products/reorder` | Manual ordering |
| `GET` `PATCH` `DELETE` | `/admin/products/:id` | One product. `PATCH` takes `category` and `pre_release_requires_purchase` |
| `GET` `POST` | `/admin/products/:id/releases` | Release notes. `POST`/`PATCH` take `channel` and `resets_rating` |
| `GET` `PATCH` `DELETE` | `/admin/products/:id/releases/:releaseId` | One release |
| `GET` `POST` `PATCH` `DELETE` | `/admin/products/:id/releases/:releaseId/compatibility[/:entryId]` | What it runs on |
| `POST` | `…/compatibility/reorder` | Manual ordering |
| `GET` `POST` `PATCH` `DELETE` | `/admin/products/:id/wiki[/:pageId]`, `…/wiki/reorder` | The wiki |
| `GET` `POST` `PUT` `PATCH` `DELETE` | `/admin/products/:id/releases/:releaseId/files[/:fileId][/content]` | The builds |
| `GET` | `/admin/products/:id/reviews` | Every review, hidden ones included, with the reporter counts |
| `POST` | `…/reviews/:reviewId/hide`, `…/unhide` | Moderation |
| `DELETE` | `…/reviews/:reviewId` | Deletes one outright |
| `PUT` `DELETE` | `…/reviews/:reviewId/reply` | The owner's public answer |
| `GET` | `/admin/reviews/reports` | **The moderation queue, across every product** |
| `PATCH` | `/admin/reviews/reports/:id` | Dismiss or action one |
| `GET` | `/admin/products/:id/analytics` | Views and downloads per day |
| `GET` | `/admin/purchases` | Everything that ever came in, across every product |
| … | `/admin/products/:id/sales`, `…/vouchers` | The back office |
| `POST` | `/admin/translate` | One field, one locale, a draft. Writes nothing |

---

## 🖥 The front-end contract

Nothing in this repository renders HTML. These three responses are what the
[`franciscosolis.cl`](https://github.com/Im-Fran/franciscosolis.cl) front-end builds the sidebar, the
version detail view and the review form against, so they are written out here rather than left to be
read off the code.

### `GET /products/:slug/overview` — the sidebar

Cacheable for sixty seconds, the same panel for every visitor.

```jsonc
{
  "code": 200,
  "data": {
    "product": {
      "id": "…", "slug": "openbattery", "name": "OpenBattery", "tagline": "…",
      "icon_image_url": "…", "accent_color": "#A855F7",
      "category": { "key": "library", "name": "Libraries / APIs" }   // null when uncategorised
    },
    "pricing": {
      "mode": "paid", "currency": "CLP", "price": 4990, "suggested_amount": null,
      "minimum_amount": 500, "allows_skip": false, "requires_payment": true,
      "accepts_payment": true, "pre_release_requires_purchase": false
    },
    "stats": {
      "download_count": 2954,          // the headline number
      "purchase_count": 118,           // null when the product never took a payment
      "view_count": 41203,
      "first_released_at": "2020-04-07T00:00:00.000Z",
      "last_released_at":  "2021-11-28T00:00:00.000Z"
    },
    "rating": {
      "average": 4.0,                  // null, never 0, when nothing counts toward it
      "count": 4,
      "reset_at": null                 // when the current window opened, if a release reset it
    },
    "latest_version": {                // null when nothing is published on the stable line
      "id": "…", "version": "5.3.1", "channel": "release", "title": "…",
      "released_at": "2021-11-28T00:00:00.000Z",
      "published_at": "2021-11-28T00:00:00.000Z",
      "resets_rating": false,
      "download_count": 214,
      "view_count": 980,
      "purchase_count": 12,            // see the caveat below
      "rating": { "average": null, "count": 0 },
      "compatibility": [
        { "id": "…", "kind": "runtime", "name": "Java", "constraint": "17+", "optional": false, "position": 0 }
      ],
      "links": [], "locale": "en", "available_locales": ["en", "es"]
    },
    "channels": { "nightly": 240, "beta": 12, "rc": 3, "release": 41 }   // published, per line
  }
}
```

Three things to label correctly:

- **`stats.download_count` is the headline number** and `purchase_count` is beside it, not instead of
  it. A free product answers `null` for the second, because "0 purchases" is not a number anybody
  asked about.
- **`rating.average` is `null`, never `0`, when nothing counts.** Rendering a null as zero stars is
  the worst available mistake on a listing card.
- **`latest_version.purchase_count` is an approximation.** It is approved purchases *since that
  release was published* — "bought while this version was current". A purchase entitles the whole
  product and never names a release, so there is no exact answer; do not label it "bought this
  version".

### `GET /products/:slug/releases/:channel/:version` — the version detail

Cacheable, and carrying **no** per-caller access block on purpose. A shared cache keying only on the
URL would otherwise hand one buyer's `can_download: true` to everybody. For the per-person half, call
`GET /products/:slug/access?channel=…`, which is `no-store`.

```jsonc
{
  "code": 200,
  "data": {
    "id": "…", "product_id": "…", "version": "2.6.4", "channel": "release",
    "title": "…", "body": "…markdown…",
    "locale": "en", "available_locales": ["en", "es"],
    "released_at": "…", "published_at": "…", "updated_at": "…",
    "resets_rating": false,
    "links": [{ "kind": "github", "url": "…", "label": null }],
    "stats": { "view_count": 980, "download_count": 214 },
    "compatibility": [ /* this release's own list, ordered by position */ ],
    "files": [
      { "id": "…", "release_id": "…", "filename": "OpenBattery-2.6.4.jar",
        "content_type": "application/java-archive", "size": 90112345, "checksum": "…",
        "platform": "any", "label": "Paper 1.21", "position": 0,
        "download_count": 214, "uploaded_at": "…" }
    ],
    "requires_payment": true,
    "channel_requires_purchase": false   // is *this line* reserved for supporters
  }
}
```

### `GET /products/:slug/reviews` — the Reviews tab

The one public read that is **not** cached: a review published a second ago has to appear.

```jsonc
{
  "code": 200,
  "data": {
    "summary": {
      "average": 4.6, "count": 88,      // count = reviews the current average is over
      "total": 131,                     // total = every visible review, reset or not
      "reset_at": "2026-01-14T00:00:00.000Z",
      "distribution": { "1": 2, "2": 1, "3": 6, "4": 19, "5": 60 }
    },
    "reviews": [{
      "id": "…", "rating": 5, "title": "…", "body": "…",
      "author": { "id": "…", "name": "Fran S." },      // never an address
      "release": { "id": "…", "version": "2.6.4", "channel": "release" },  // null once deleted
      "counts_toward_rating": true,
      "edited": true,
      "reply": { "body": "…", "author_name": "OpenBattery", "created_at": "…", "updated_at": "…" },
      "created_at": "…", "updated_at": "…"
    }],
    "pagination": { "limit": 20, "offset": 0, "total": 131 }
  }
}
```

`GET /products/:slug/reviews/me` answers `{ review, eligibility }`, where `eligibility` is
`{ can_review, reason, via, anchor }`. `reason` is one of `not_authenticated`, `not_obtained` or
`no_release`, and `via` is `purchase` or `download` — both closed sets, so the empty state can be
worded without parsing a sentence.

The review form writes with `PUT /products/:slug/reviews` (`{ rating, title?, body? }`), which
creates or replaces. `403` means not eligible, `409` means the product has nothing published to
anchor a review to.

---

## 🧱 The product model

| Tab | What it is | Where it lives |
|-----|-----------|----------------|
| **Overview** | One centred Markdown document, with the sidebar beside it. Always present. | A column on the row |
| **Releases** | Release notes on four channels, newest release first. | `product_releases` |
| **Wiki** | Documentation with a sidebar, nested at most one level deep. | `product_wiki_pages` |
| **Reviews** | What the people who obtained it thought, with the owner's answers. | `product_reviews` |
| **Contact** | How to reach support, as one Markdown document. | A column on the row |

Overview and Contact are columns because there is never more than one of either; the other three are
tables because there are many. The editor's **reply** to a review is four columns on
`product_reviews` for exactly the same reason. That asymmetry is what the `source` field on a tab
definition tells a front-end.

Downloads hang off a **release** rather than off the product: `product_release_files` holds one row
per build, keyed to the release that published it, which makes "the archive of past versions" a
consequence of the changelog instead of a second list to keep in step with it.
`product_release_compatibility` hangs off a release for the same reason.

The money lives in three more tables. `purchases` is one row per payment, and an `approved` one *is*
the entitlement — there is no `entitlements` table. `payment_events` is the append-only log of every
provider notification acted on, and its unique `<payment>:<status>` key is what makes the webhook
idempotent. `download_events` is what "see your downloads" reads, and it is also what makes a review
eligible.

`product_daily_stats` holds one row per product, per release, per day. None of those five tables
carries a foreign key onto `products`: a payment, a download and a day's traffic all have to outlive
the page they were about.

Alongside them, `audit_logs` records every write. The whole schema lives in `src/db/schema.ts`, with
its migration generated by drizzle-kit into `migrations/0000_init.sql`.

---

## ⚙️ Configuration

All configuration lives in `wrangler.jsonc` under `vars`:

| Variable | Purpose |
|----------|---------|
| `AUTH_JWKS_URL` | Path the JWKS is read from, over the `AUTH` binding (the host is a placeholder) |
| `AUTH_ISSUER` | Expected `iss` claim; must match the auth Worker's issuer exactly |
| `MARKETPLACE_ALLOWED_AUDIENCES` | Client application ids whose tokens may write here — the console's own |
| `MARKETPLACE_ALLOWED_EMAIL_DOMAINS` | Email domains allowed to edit, matched on the full domain label |
| `MARKETPLACE_ACCOUNT_AUDIENCES` | Client ids whose tokens identify a *buyer or reviewer* — the website's. A separate list on purpose |
| `MARKETPLACE_PUBLIC_URL` | This Worker's public base URL, for the download links and the notification URL |
| `SITE_BASE_URL` | Where a buyer is returned to after checkout — a page on the website, never the API |
| `MERCADOPAGO_ENVIRONMENT` | `live` or `sandbox`: which account takes the money, which checkout URL is handed back, and what is stamped on every purchase |
| `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Sender of the vouchers and refund notices |
| `AI_TEXT_MODEL` | Workers AI model behind the translation drafts |

The editorial permission, `marketplace:editor`, is a **constant** in `src/lib/config.ts` rather than
a var — the string is a fact about the code, and a deployment that could rename it could also empty
it. `apps/support` does the same with `support:agent`.

Secrets, set with `wrangler secret put` and listed in `.dev.vars.example` for local work:

| Secret | Purpose |
|--------|---------|
| `MERCADOPAGO_ACCESS_TOKEN` | Creates preferences and reads payments back. Without it checkout answers 503 |
| `MERCADOPAGO_WEBHOOK_SECRET` | Verifies notifications. Without it every notification is refused |
| `DOWNLOAD_SIGNING_KEY` | HMAC key the download tickets are signed with |

In the MercadoPago dashboard, the webhook points at `/marketplace/payments/mercadopago/webhook` with
three events enabled: **Pagos (legacy)**, **Order (Mercado Pago)** and **Contracargos**. The first
two describe the same money in the provider's old and new models and are both accepted so that
retiring either one is a checkbox; the third is how a dispute arrives in the old model.

Bindings: `DB` (D1 `franciscosolis_marketplace`), `RELEASES` (R2 `franciscosolis-app-releases`, no
public access of its own), `AUTH` (service binding to the auth Worker, used only to read its
published JWKS), `AI` (Workers AI, used only by `POST /admin/translate`) and `EMAIL` (Cloudflare
Email Sending, used for the voucher and the refund notice and nothing else).

---

## 🌐 Deployment

```bash
cd apps/marketplace && pnpm run deploy
```

Migrations are not part of that: the repo's `Migrate` workflow applies them on a push to `dev` that
touches `migrations/`, and `pnpm run db:migrate:remote` is the manual fallback. See the root README
for the ordering caveat between the two.

The Worker must be deployed under the exact name `marketplace` for the gateway's `MARKETPLACE`
service binding to resolve, and it binds `AUTH`, so `auth` must be deployed first and `api` last. It
needs no route or custom domain of its own — it is reached through
`api.franciscosolis.cl/marketplace`.

See [CLAUDE.md](./CLAUDE.md) for the design decisions worth not re-deriving.

---

## 📄 License

Licensed under **GPL-3.0-only** — see [LICENSE](https://github.com/Im-Fran/api.franciscosolis.cl/blob/dev/LICENSE).

---

<div align="center">
Made with ☕ by <a href="https://franciscosolis.cl">Fran</a>
</div>
