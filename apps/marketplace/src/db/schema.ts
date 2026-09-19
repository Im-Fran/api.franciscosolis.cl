import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_marketplace`.
 *
 * Conventions, kept in line with the auth and cms Workers:
 * - Primary keys are UUID v4 strings generated in the Worker, so a row can be referenced before it
 *   is written and ids never leak insertion order.
 * - Timestamps are unix seconds (`integer` + `{ mode: 'timestamp' }`) defaulting to `unixepoch()`.
 * - Editors are recorded by email rather than by a foreign key: accounts live in the auth database,
 *   which this Worker cannot reach, and an email is what an audit trail is read by.
 *
 * Unlike the CMS, this schema *does* use foreign keys. A release, a wiki page, a compatibility
 * entry or a review only means anything as part of one product, and a row orphaned by a deleted
 * product would be invisible to every route here while still occupying its slug.
 *
 * The exception is the financial and event half — `purchases`, `sale_vouchers`, `payment_events`,
 * `download_events`, `product_daily_stats` and `ai_requests` — which carries no foreign key at all.
 * A payment is a financial record, a download is something that happened and a daily total is a
 * fact about traffic; none of them may be erased by deleting the page they were made for. They
 * snapshot the slug, the version and the filename instead, which is what keeps them readable
 * afterwards.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}

/** Columns every editable row here carries, so the audit trail can name a person for any change. */
const authorship = {
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
}

/**
 * One standalone product page: a banner, a row of tabs and the content behind them.
 *
 * The Overview and Contact tabs are a single Markdown document each, so they are columns rather
 * than tables — there is never more than one of either, and splitting them out would buy a join for
 * nothing. Releases and Wiki are lists, and get a table apiece.
 */
const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  /** URL-safe identifier. This is what `/product/<slug>` on the website resolves. */
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  /** One line under the banner, e.g. "The ultimate styling solution for your server". */
  tagline: text('tagline'),
  /** Short plain-text blurb for listings and meta tags. */
  summary: text('summary'),
  /** `draft` | `published` | `archived`. Only `published` products are visible publicly. */
  status: text('status').notNull().default('draft'),
  /** Pinned products a listing may highlight. */
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  /** Manual ordering of the product list; lower comes first. */
  position: integer('position').notNull().default(0),
  /** Wide artwork rendered above the tab bar. */
  bannerImageUrl: text('banner_image_url'),
  /** Square mark, for listing cards and social previews. */
  iconImageUrl: text('icon_image_url'),
  /** Hex colour the page themes its accents with, e.g. `#A855F7`. */
  accentColor: text('accent_color'),
  /** JSON array of tab keys, in the order they are rendered. Validated against `src/lib/tabs.ts`. */
  tabs: text('tabs').notNull().default('["overview"]'),
  /** JSON array of `{ kind, url, label }` — the store, repository and community links. */
  links: text('links').notNull().default('[]'),
  /** The Overview tab: one centred Markdown document. Rendered by the website, never here. */
  overviewBody: text('overview_body'),
  /** The Contact tab, same shape. Links in the header cover the rest. */
  contactBody: text('contact_body'),
  /**
   * How the product is paid for: `free`, `donation` (pay what you like, skipping allowed) or
   * `paid` (a download needs an approved purchase). See `src/lib/pricing.ts`.
   */
  pricingMode: text('pricing_mode').notNull().default('free'),
  /** Price of a `paid` product, in whole CLP. Meaningless in the other two modes. */
  priceAmount: integer('price_amount'),
  /** Amount a `donation` product suggests, in whole CLP. A suggestion, never a floor. */
  suggestedAmount: integer('suggested_amount'),
  /**
   * Whether a pre-release build (`nightly`, `beta`, `rc`) needs an approved purchase.
   *
   * Only meaningful on a `paid` product — `describePricing` reports it as `false` in the other two
   * modes, the same nulling `price` gets, so a column kept through a mode change can never gate a
   * build on a product that is currently free. It gates the *download* and nothing else: the
   * release note, its links, its compatibility and its file listing stay public on every channel,
   * because hiding a nightly removes the very incentive the gate exists to create.
   */
  preReleaseRequiresPurchase: integer('pre_release_requires_purchase', { mode: 'boolean' })
    .notNull()
    .default(false),
  /** Key from the closed vocabulary in `src/lib/categories.ts`, or null. Structure, never prose. */
  category: text('category'),
  /** Page views, counted by `POST /products/:slug/views`. Approximate by design; see `lib/analytics.ts`. */
  viewCount: integer('view_count').notNull().default(0),
  /** Served downloads across every release. `download_events` is the exact record; this is the total. */
  downloadCount: integer('download_count').notNull().default(0),
  /** Locale → overrides for the prose fields; see `src/lib/locales.ts`. */
  translations: text('translations').notNull().default('{}'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('products_slug_unique').on(table.slug),
  index('products_status_position_idx').on(table.status, table.position),
  index('products_category_status_idx').on(table.category, table.status, table.position),
])

/**
 * One release note on a product's Releases tab.
 *
 * `releasedAt` rather than `publishedAt` is what the tab is ordered by: an editor writes the entry
 * when they write it, and says what day the release happened. The two are routinely different, and
 * a changelog ordered by when somebody got round to typing it is wrong.
 */
const productReleases = sqliteTable('product_releases', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  /** Human-facing version label shown in the badge, e.g. `2.6.4`. Unique per product *and channel*. */
  version: text('version').notNull(),
  /**
   * How finished this build is: `nightly` | `beta` | `rc` | `release`. See `src/lib/channels.ts`.
   *
   * A channel is not a status. `draft`/`published`/`archived` says whether anybody may see the
   * entry at all; the channel says how much they should trust it. Every release carries both, and
   * the public feed shows `release` only unless a `?channel` asks for more.
   */
  channel: text('channel').notNull().default('release'),
  /**
   * Whether publishing this release restarts the product's star rating, App Store style.
   *
   * It deletes nothing. Reviews anchored to earlier releases stay stored and stay readable; they
   * simply fall outside the window the current average is computed over. The window opens at
   * `MAX(published_at)` across the resetting releases — see `src/services/ratings.ts`, which is the
   * one place that expression is written.
   */
  resetsRating: integer('resets_rating', { mode: 'boolean' }).notNull().default(false),
  /** Views of this release's detail page. */
  viewCount: integer('view_count').notNull().default(0),
  /** Downloads served from this release's files. */
  downloadCount: integer('download_count').notNull().default(0),
  title: text('title').notNull(),
  /** The changelog itself, Markdown. */
  body: text('body'),
  status: text('status').notNull().default('draft'),
  /** The day the version shipped. What the tab sorts on, newest first. */
  releasedAt: integer('released_at', { mode: 'timestamp' }),
  /** JSON array of `{ kind, url, label }`: the GitHub release, the App Store, the Play Store. */
  links: text('links').notNull().default('[]'),
  translations: text('translations').notNull().default('{}'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [
  // The channel is part of the key: `1.4.0` can exist as an `rc` and later as a `release`, which is
  // the whole point of having channels, and it is why the public route addresses a release by
  // `/releases/:channel/:version` rather than by version alone.
  uniqueIndex('product_releases_product_channel_version_unique').on(table.productId, table.channel, table.version),
  index('product_releases_product_channel_released_idx').on(
    table.productId,
    table.channel,
    table.status,
    table.releasedAt,
  ),
  // Exists for exactly one query: the correlated `MAX(published_at)` subquery that opens the rating
  // window in `src/services/ratings.ts`. Ordered so that subquery is index-only.
  index('product_releases_rating_reset_idx').on(table.productId, table.status, table.resetsRating, table.publishedAt),
])

/**
 * One page of a product's Wiki tab.
 *
 * `parentId` is what makes the sidebar a tree rather than a list — a section with its own pages
 * under it, as `Overview → Commands` is in the reference design. It is deliberately only one level
 * deep by rule rather than by schema — `resolveParentId` in `src/services/wiki.ts` enforces it. A
 * self-referencing column cannot express a depth limit, and a sidebar that nests without bound
 * stops being navigable.
 */
const productWikiPages = sqliteTable('product_wiki_pages', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  /** Section this page hangs under, or null for a top-level entry in the sidebar. */
  parentId: text('parent_id'),
  /** URL-safe identifier, unique inside the product. `/product/<app>/wiki/<slug>`. */
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  /** Icon slug the website resolves (a Lucide/Phosphor name), not a URL. */
  icon: text('icon'),
  /** The page itself, Markdown. */
  body: text('body'),
  status: text('status').notNull().default('draft'),
  /** Manual ordering among its siblings; lower comes first. */
  position: integer('position').notNull().default(0),
  translations: text('translations').notNull().default('{}'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('product_wiki_pages_product_slug_unique').on(table.productId, table.slug),
  index('product_wiki_pages_product_position_idx').on(table.productId, table.status, table.position),
])

/**
 * One downloadable artifact attached to a release note on the Releases tab.
 *
 * The bytes live in R2 and nothing here ever hands out a bucket URL: a download is always served by
 * `GET /downloads/:ticket`, which is the only place the payment state of the product can be
 * consulted at all. `objectKey` is therefore an internal detail and is never serialized into a
 * response — see `toPublicReleaseFile` in `src/services/release-files.ts`.
 *
 * `productId` is carried beside `releaseId` even though the release already knows it. Every
 * public route here resolves a product first and a release second, and having the column means
 * the download path can check that a file belongs to the product in its URL with one read
 * instead of a join.
 */
const productReleaseFiles = sqliteTable('product_release_files', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  releaseId: text('release_id')
    .notNull()
    .references(() => productReleases.id, { onDelete: 'cascade' }),
  /** Key of the object in the `RELEASES` bucket. Internal: never serialized into a response. */
  objectKey: text('object_key').notNull(),
  /** Name the browser saves the file under. Unique within the release. */
  filename: text('filename').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  /** Size in bytes, measured when the bytes were stored rather than declared by the uploader. */
  size: integer('size').notNull().default(0),
  /** Lowercase hex SHA-256 of the object, so a download can be verified off-site. */
  checksum: text('checksum'),
  /** Which build this is, from the closed set in `src/lib/files.ts`. */
  platform: text('platform').notNull().default('any'),
  /** Short label for the button, e.g. "Installer" or "Paper 1.21". */
  label: text('label'),
  position: integer('position').notNull().default(0),
  status: text('status').notNull().default('draft'),
  /** Stamped when the bytes arrived. A row with no upload yet is metadata and answers 409. */
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }),
  /** Served downloads, counted for the editor. Not an audit trail — `download_events` is that. */
  downloadCount: integer('download_count').notNull().default(0),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('product_release_files_release_filename_unique').on(table.releaseId, table.filename),
  index('product_release_files_release_position_idx').on(table.releaseId, table.status, table.position),
  index('product_release_files_product_idx').on(table.productId),
])

/**
 * What one release runs on: an operating system, a runtime, a dependency, a piece of hardware.
 *
 * Attached to the **release** rather than to the product, because a release is exactly where
 * support is added and dropped — an update that starts requiring macOS 15 and stops supporting
 * 32-bit builds is the ordinary case, and a product-level list could not say either.
 *
 * A table rather than JSON on the row, which is the opposite of what `links` does, and the
 * difference is that this one is *queryable*. `src/lib/links.ts` calls JSON-on-the-row right for a
 * value "always read with it, always replaced wholesale"; "which releases still support Java 17" is
 * a question links never had to answer.
 *
 * `constraint_text` is spelled that way because `CONSTRAINT` is a SQLite reserved word. The API
 * field is `constraint`; the mapping lives in `src/lib/compatibility.ts` and nowhere else.
 *
 * `productId` is carried beside `releaseId` for the same reason `product_release_files` carries it:
 * every route resolves a product first and a release second.
 */
const productReleaseCompatibility = sqliteTable('product_release_compatibility', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  releaseId: text('release_id')
    .notNull()
    .references(() => productReleases.id, { onDelete: 'cascade' }),
  /** Closed vocabulary: `os` | `runtime` | `platform` | `dependency` | `hardware` | `architecture` | `other`. */
  kind: text('kind').notNull(),
  /** What it is, e.g. `macOS`, `Java`, `Paper`, `arm64`. Typed enough to group and filter on. */
  name: text('name').notNull(),
  /**
   * The requirement itself, e.g. `>= 14.0`, `17+`, `1.20–1.21`. Free text, and deliberately so:
   * this Worker fronts a Minecraft plugin and a mobile app equally well, exactly as a version label
   * does. Nothing here parses or compares it — comparing would need a semver the versions are not.
   */
  constraintText: text('constraint_text'),
  /** A recommendation rather than a requirement: "works better with", not "will not start without". */
  optional: integer('optional', { mode: 'boolean' }).notNull().default(false),
  position: integer('position').notNull().default(0),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('product_release_compatibility_release_kind_name_unique').on(table.releaseId, table.kind, table.name),
  index('product_release_compatibility_release_position_idx').on(table.releaseId, table.position),
  index('product_release_compatibility_kind_name_idx').on(table.kind, table.name),
])

/**
 * One person's review of one product.
 *
 * Three things about the shape are load-bearing.
 *
 * **One row per person per product**, enforced by the unique index rather than by a service. Editing
 * a review replaces it; there is no second opinion and no thread. That is what keeps the average an
 * average of people rather than of clicks, and it is the only structural mitigation against a free
 * product being rated by somebody who signed in twice.
 *
 * **`anchoredAt` is a snapshot, not a join.** It holds the `published_at` of the release the
 * reviewer had when they wrote — set on create and re-set on edit. It makes the rating window a
 * scalar timestamp comparison with no join to `product_releases` at all, and it survives the anchor
 * release being deleted, which `releaseId` (`ON DELETE set null`, so the review outlives the
 * version it was about) does not.
 *
 * **The editor's reply is four columns, not a table.** There is never more than one — the product's
 * owner answers a review or does not — and this schema already states the rule for that shape: the
 * Overview and Contact tabs are columns and the Releases and Wiki tabs are tables. Columns mean no
 * join on the public read, and "one reply" enforced by the shape rather than by an index somebody
 * can later relax.
 */
const productReviews = sqliteTable('product_reviews', {
  id: text('id').primaryKey(),
  productId: text('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  /** The release this review was written against. Null once that release is deleted. */
  releaseId: text('release_id').references(() => productReleases.id, { onDelete: 'set null' }),
  /** Version of the anchor release, snapshotted so the review still names it afterwards. */
  releaseVersion: text('release_version'),
  /** Channel of the anchor release, snapshotted for the same reason. */
  releaseChannel: text('release_channel'),
  /** `published_at` of the anchor release. The whole rating window turns on this one number. */
  anchoredAt: integer('anchored_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  /** `sub` of the account that wrote it. */
  userId: text('user_id').notNull(),
  /**
   * Verified address the account held. This is the *eligibility key* — `findActivePurchase` matches
   * a manual sale by address — and it is never serialized into a public response.
   */
  email: text('email').notNull(),
  /** Display name at write time. Accounts live in the auth database, which this Worker cannot read. */
  authorName: text('author_name'),
  /** 1–5. Bounded in valibot, not in SQLite: a CHECK constraint cannot be altered without a rebuild. */
  rating: integer('rating').notNull(),
  title: text('title'),
  body: text('body'),
  /** `visible` | `hidden`. A hidden review is invisible publicly and counts toward no average. */
  status: text('status').notNull().default('visible'),
  hiddenAt: integer('hidden_at', { mode: 'timestamp' }),
  hiddenBy: text('hidden_by'),
  hiddenReason: text('hidden_reason'),
  /** Denormalised count of `product_review_reports`, so the moderation queue sorts without a join. */
  reportCount: integer('report_count').notNull().default(0),
  /** The editor's public answer. One per review, editable; see the note above for why it is columns. */
  replyBody: text('reply_body'),
  /** Email of the editor who wrote it. Internal: the public shape renders a fixed display name. */
  replyBy: text('reply_by'),
  replyAt: integer('reply_at', { mode: 'timestamp' }),
  replyUpdatedAt: integer('reply_updated_at', { mode: 'timestamp' }),
  ...timestamps,
}, (table) => [
  uniqueIndex('product_reviews_product_user_unique').on(table.productId, table.userId),
  index('product_reviews_product_status_anchored_idx').on(table.productId, table.status, table.anchoredAt),
  index('product_reviews_release_idx').on(table.releaseId, table.status),
  index('product_reviews_user_created_idx').on(table.userId, table.createdAt),
  index('product_reviews_reports_idx').on(table.reportCount, table.status),
])

/**
 * Somebody flagging a review for an editor to look at.
 *
 * Unique per reporter per review, which is the difference between a queue and a click counter: a
 * review is not more reportable because one person pressed the button eight times.
 *
 * `productId` is carried so the queue can be filtered per product without a join, and the queue
 * itself — `GET /admin/reviews/reports` — is deliberately *not* nested under a product, exactly as
 * `GET /admin/purchases` is not: it answers "what needs moderating anywhere", which is the only
 * thing it is for.
 */
const productReviewReports = sqliteTable('product_review_reports', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => productReviews.id, { onDelete: 'cascade' }),
  productId: text('product_id').notNull(),
  reporterUserId: text('reporter_user_id').notNull(),
  reporterEmail: text('reporter_email').notNull(),
  /** Closed set: `spam` | `abuse` | `off_topic` | `not_a_review` | `personal_data` | `other`. */
  reason: text('reason').notNull(),
  note: text('note'),
  /** `open` | `dismissed` | `actioned`. */
  status: text('status').notNull().default('open'),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolvedBy: text('resolved_by'),
  resolutionNote: text('resolution_note'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('product_review_reports_review_reporter_unique').on(table.reviewId, table.reporterUserId),
  index('product_review_reports_status_created_idx').on(table.status, table.createdAt),
  index('product_review_reports_product_idx').on(table.productId, table.status),
])

/**
 * One day's views and downloads, per product and per release.
 *
 * **No foreign keys**, joining the `ai_requests` camp rather than the content one: how often a page
 * was looked at is a fact about traffic, and deleting the page must not rewrite it. The counters on
 * `products` and `product_releases` answer "how many in total"; this table is what a chart is drawn
 * from.
 *
 * **`releaseId` uses the empty string rather than NULL for the product-wide row**, and that is not
 * stylistic: SQLite treats NULLs as distinct inside a unique index, so `ON CONFLICT DO UPDATE` would
 * never match and every single event would insert a new row instead of incrementing one. The
 * sentinel is `ALL_RELEASES` in `src/lib/analytics.ts`, and nothing compares against it directly —
 * the same discipline `UNLINKED_USER_ID` gets in `src/lib/sales.ts`.
 */
const productDailyStats = sqliteTable('product_daily_stats', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  /** Release the event belonged to, or `ALL_RELEASES` (the empty string) for the product-wide row. */
  releaseId: text('release_id').notNull().default(''),
  /** `YYYY-MM-DD`, UTC. Text rather than a timestamp: it is a bucket label, not an instant. */
  day: text('day').notNull(),
  views: integer('views').notNull().default(0),
  downloads: integer('downloads').notNull().default(0),
  ...timestamps,
}, (table) => [
  uniqueIndex('product_daily_stats_day_unique').on(table.productId, table.releaseId, table.day),
  index('product_daily_stats_product_day_idx').on(table.productId, table.day),
])

/**
 * One payment taken for a product: a purchase of a paid one, or a donation to an optional-pay
 * one. An approved row is the entitlement — there is no second table saying so.
 *
 * Deriving access from the payment rather than from an `entitlements` row is deliberate: a refund is
 * a status change on the row that already exists, and an entitlement table would need the same
 * change applied twice, in the right order, from a webhook that can arrive more than once.
 *
 * **These are the only rows here with no foreign key onto `products`, and that is the point.** A
 * payment is a financial record that has to outlive the page it was made for, so deleting an
 * product must not cascade into it. `productSlug` is snapshotted for the same reason: it is
 * what the row can still be read by once the product is gone.
 *
 * `userId` is the `sub` of the auth account that paid, and it is never null: checkout requires a
 * signed-in account precisely so that a purchase has somewhere to live, which is why buying an
 * product creates an SSO account when the buyer has none.
 *
 * One case cannot supply it — a sale **recorded by hand**, for cash taken at a stand or a copy given
 * away, where the recipient may not have signed in yet and this Worker cannot ask whether an address
 * has an account. Those rows carry `UNLINKED_USER_ID` (the empty string, see `src/lib/sales.ts`)
 * rather than making the column nullable, and are found by their address instead — which is what
 * `findActivePurchase` already matches on. The sentinel is what keeps every migration on this table
 * purely additive: a `DROP TABLE`/rename rebuild races the production deploy (see the root
 * `CLAUDE.md`) and, for the length of it, every paid download would 404 rather than degrade.
 */
const purchases = sqliteTable('purchases', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  /** Snapshot of the slug at the time of payment; the row survives the product. */
  productSlug: text('product_slug').notNull(),
  /** `purchase` for a paid product, `donation` for an optional-pay one. */
  kind: text('kind').notNull().default('purchase'),
  /**
   * `sub` claim of the account that paid, or `UNLINKED_USER_ID` on a manual sale recorded before the
   * recipient had an account. Never null; see the note above for why the sentinel is preferred.
   */
  userId: text('user_id').notNull(),
  /** Verified address the account held at the time, for the receipt and for support. */
  email: text('email').notNull(),
  /** `pending` | `in_process` | `approved` | `rejected` | `cancelled` | `refunded`. */
  status: text('status').notNull().default('pending'),
  /** What was charged, in whole units of `currency`. CLP has no minor unit. */
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('CLP'),
  /** Which system holds the transaction: `mercadopago`, or `manual` for one recorded by hand. */
  provider: text('provider').notNull().default('mercadopago'),
  /**
   * What the payer actually did: `mercadopago`, `cash`, `bank_transfer`, `gift` or `other`.
   *
   * Kept apart from `provider` because the two answer different questions, and the second is the one
   * an accountant reconciles against: cash at a stand and a bank transfer are both `manual` and are
   * not the same fact. Only `mercadopago` can be produced by the Worker itself; the rest are what an
   * editor records, which is why a manual row is always visibly manual. See `src/lib/sales.ts`.
   */
  source: text('source').notNull().default('mercadopago'),
  /**
   * Which MercadoPago account took the money: `live` or `sandbox`.
   *
   * Stamped from `MERCADOPAGO_ENVIRONMENT` at the time rather than read from the configuration when
   * the row is displayed, because the configuration is the thing that changes. It is what keeps a
   * test payment out of a revenue total, and what stops a refund being attempted against the account
   * that never saw the payment — the provider answers 404 for the other environment's ids, which
   * looks exactly like a payment that never existed.
   */
  environment: text('environment').notNull().default('live'),
  /** Checkout Pro preference this purchase was started from. */
  preferenceId: text('preference_id'),
  /** MercadoPago payment id, once one exists. */
  paymentId: text('payment_id'),
  /**
   * Our own id for the payment, sent to MercadoPago as `external_reference` and echoed back on the
   * payment. Uniquely indexed: it is how a webhook finds the row it is about.
   */
  externalReference: text('external_reference').notNull(),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
  refundedAt: integer('refunded_at', { mode: 'timestamp' }),
  /**
   * How much went back, in whole units of `currency`.
   *
   * A column of its own rather than an edit to `amount`: a partial refund is a real case — a donor
   * refunded down to what they meant to give — and overwriting what was charged would misstate the
   * sale. Null on a row that was never refunded, and equal to `amount` on a total one.
   */
  refundedAmount: integer('refunded_amount'),
  /** Why the money went back, from the closed set in `src/lib/sales.ts`. `withdrawal` is statutory. */
  refundReason: text('refund_reason'),
  /** Email of the editor who issued the refund. Null for one that arrived from the provider's console. */
  refundedBy: text('refunded_by'),
  /** The provider's own id for the refund, so it can be traced to their console. */
  refundId: text('refund_id'),
  /**
   * When the payer's bank took the money back. Kept apart from `refundedAt` for the same reason the
   * statuses are: a refund is ours, a chargeback is theirs, and only one of them comes with a fee and
   * a dispute deadline.
   */
  chargedBackAt: integer('charged_back_at', { mode: 'timestamp' }),
  /** MercadoPago's id for the dispute, so a support conversation can be traced to their console. */
  chargebackId: text('chargeback_id'),
  /** Editor's note on a manual sale: which stand, which transfer, who the copy was given to. */
  note: text('note'),
  /** Email of the editor who recorded a manual sale. Null for one the provider's webhook created. */
  createdBy: text('created_by'),
  /** Free-form JSON. Must never carry a card detail, a provider token or an access token. */
  metadata: text('metadata'),
  ...timestamps,
}, (table) => [
  uniqueIndex('purchases_external_reference_unique').on(table.externalReference),
  index('purchases_product_user_idx').on(table.productId, table.userId, table.status),
  index('purchases_user_created_idx').on(table.userId, table.createdAt),
  index('purchases_payment_idx').on(table.paymentId),
  index('purchases_status_created_idx').on(table.status, table.createdAt),
  index('purchases_product_created_idx').on(table.productId, table.createdAt),
  index('purchases_email_idx').on(table.email),
])

/**
 * One voucher: the receipt for a sale, as the buyer was sent it.
 *
 * It is a row rather than a rendering because the *document* is the thing that matters. A receipt
 * somebody was emailed in March has to still say in December what it said then, including for a sale
 * whose product page has since been deleted and whose price has since changed — so the amount,
 * the address and the product's slug are snapshotted here rather than read back through the
 * purchase.
 *
 * It is never edited and never deleted, for the same reason: every copy already in an inbox would
 * become a forgery of the row. Correcting one means voiding it and issuing the next, which is what
 * `status` is for and why there is no third state.
 *
 * No foreign keys, exactly like `purchases` — a receipt outlives the page it was written for.
 */
const saleVouchers = sqliteTable('sale_vouchers', {
  id: text('id').primaryKey(),
  /** Human-facing number, e.g. `FS-2026-000042`. Allocated per year; see `src/lib/sales.ts`. */
  number: text('number').notNull(),
  /** Sale this is the receipt for. */
  purchaseId: text('purchase_id').notNull(),
  productId: text('product_id').notNull(),
  /** Snapshot of the slug, so the voucher still names its product once the page is gone. */
  productSlug: text('product_slug').notNull(),
  /** Snapshot of the product's name at issue time, because the receipt printed it. */
  productName: text('product_name').notNull(),
  /** Address the voucher was issued to. Snapshotted: correcting the sale's address re-issues. */
  email: text('email').notNull(),
  /** `purchase` or `donation`, copied from the sale. */
  kind: text('kind').notNull().default('purchase'),
  /** What the voucher states was paid, in whole units of `currency`. Zero for a gift. */
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('CLP'),
  /** How the money arrived, copied from the sale. The receipt prints it. */
  source: text('source').notNull().default('mercadopago'),
  /** `issued` | `void`. */
  status: text('status').notNull().default('issued'),
  /** Language the voucher was rendered in, so a re-send reads the same as the original. */
  locale: text('locale').notNull().default('en'),
  /** Editor who issued it, or null when the webhook issued it on approval. */
  issuedBy: text('issued_by'),
  issuedAt: integer('issued_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  voidedAt: integer('voided_at', { mode: 'timestamp' }),
  voidedBy: text('voided_by'),
  voidReason: text('void_reason'),
  /**
   * How many times it has been emailed, and where it went last.
   *
   * Counted rather than logged as rows: "did this reach them, and when did we last try" is the whole
   * question a support conversation asks, and a table of sends for a document that is always the same
   * document would be a log nobody reads. The failure of a send is not recorded here at all — it is
   * returned to the editor, who is looking at the screen.
   */
  sentCount: integer('sent_count').notNull().default(0),
  lastSentAt: integer('last_sent_at', { mode: 'timestamp' }),
  lastSentTo: text('last_sent_to'),
  ...timestamps,
}, (table) => [
  uniqueIndex('sale_vouchers_number_unique').on(table.number),
  index('sale_vouchers_purchase_idx').on(table.purchaseId),
  index('sale_vouchers_product_issued_idx').on(table.productId, table.status, table.issuedAt),
  index('sale_vouchers_email_idx').on(table.email),
])

/**
 * Append-only log of every provider notification acted on, and the idempotency guard for them.
 *
 * MercadoPago retries a notification until it is answered with a 2xx, and it sends several for one
 * payment as the payment moves through its states. `eventId` is composed as `<payment id>:<status>`
 * rather than taken from the notification body, so a retry of the *same* transition collapses onto
 * the unique index while a genuine `pending → approved` still gets through.
 */
const paymentEvents = sqliteTable('payment_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('mercadopago'),
  /** `<payment id>:<status>` — see above. Unique per provider. */
  eventId: text('event_id').notNull(),
  /** Notification topic as the provider sent it, e.g. `payment`. */
  topic: text('topic'),
  paymentId: text('payment_id'),
  purchaseId: text('purchase_id'),
  status: text('status'),
  /** The provider's own payload, trimmed to the fields acted on. Never the raw request headers. */
  payload: text('payload'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('payment_events_provider_event_unique').on(table.provider, table.eventId),
  index('payment_events_purchase_idx').on(table.purchaseId),
])

/**
 * One served download, which is what "see your downloads" reads.
 *
 * No foreign keys, for the same reason `purchases` has none: a download is something that happened,
 * and retiring a release note must not rewrite the history of the people who downloaded it. The
 * filename and version are snapshotted so a row still says what was downloaded afterwards.
 */
const downloadEvents = sqliteTable('download_events', {
  id: text('id').primaryKey(),
  fileId: text('file_id').notNull(),
  productId: text('product_id').notNull(),
  productSlug: text('product_slug').notNull(),
  releaseId: text('release_id').notNull(),
  /** Version label of the release the file belonged to, snapshotted. */
  version: text('version').notNull(),
  /** Channel the build came from, snapshotted: a download of a beta still says so once it is gone. */
  channel: text('channel').notNull().default('release'),
  filename: text('filename').notNull(),
  /** Account that downloaded, or null for an anonymous download of a free or optional-pay build. */
  userId: text('user_id'),
  /** Purchase the download was served against, when there was one. */
  purchaseId: text('purchase_id'),
  /** Whether this download was served immediately (paid) or after the cooldown. */
  paid: integer('paid', { mode: 'boolean' }).notNull().default(false),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('download_events_user_created_idx').on(table.userId, table.createdAt),
  index('download_events_file_idx').on(table.fileId),
  // Review eligibility: "has this account ever downloaded this product". One indexed read, no join.
  index('download_events_product_user_idx').on(table.productId, table.userId),
])

/** Append-only trail of every write an editor makes. Never updated, never deleted by the Worker. */
const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  /** Email of the editor who performed the action, taken from the verified access token. */
  actorEmail: text('actor_email'),
  actorId: text('actor_id'),
  /** Table the action touched, e.g. `products`. */
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** Free-form JSON payload. Must never carry a token or a secret. */
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('audit_logs_created_at_idx').on(table.createdAt),
  index('audit_logs_actor_email_idx').on(table.actorEmail),
])

/**
 * Every call this Worker makes to Workers AI, and the meter beside it.
 *
 * Not bookkeeping for its own sake: Workers AI is billed per neuron and there is no per-Worker
 * spend cap, so without a log the first sign of a runaway loop in the editor is the invoice. The
 * same table is the rate limiter's index — `translationsByEditor` counts rows here rather than
 * keeping a counter of its own.
 *
 * No foreign key, unlike almost everything else in this schema, and deliberately: a metered call
 * is a fact about spend, not about the product page whose field happened to be translated, and
 * it has to survive that page being deleted.
 */
const aiRequests = sqliteTable('ai_requests', {
  id: text('id').primaryKey(),
  /** `translate` is the only kind today. Kept open so a second use does not need a migration. */
  kind: text('kind').notNull(),
  model: text('model').notNull(),
  actorEmail: text('actor_email'),
  inputChars: integer('input_chars').notNull().default(0),
  outputChars: integer('output_chars').notNull().default(0),
  durationMs: integer('duration_ms').notNull().default(0),
  ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('ai_requests_created_idx').on(table.createdAt),
  index('ai_requests_actor_created_idx').on(table.actorEmail, table.createdAt),
  index('ai_requests_kind_created_idx').on(table.kind, table.createdAt),
])

export {
  aiRequests,
  auditLogs,
  downloadEvents,
  paymentEvents,
  productDailyStats,
  productReleaseCompatibility,
  productReleaseFiles,
  productReleases,
  productReviewReports,
  productReviews,
  products,
  productWikiPages,
  purchases,
  saleVouchers,
}
