import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_pages`.
 *
 * Conventions, kept in line with the auth and cms Workers:
 * - Primary keys are UUID v4 strings generated in the Worker, so a row can be referenced before it
 *   is written and ids never leak insertion order.
 * - Timestamps are unix seconds (`integer` + `{ mode: 'timestamp' }`) defaulting to `unixepoch()`.
 * - Editors are recorded by email rather than by a foreign key: accounts live in the auth database,
 *   which this Worker cannot reach, and an email is what an audit trail is read by.
 *
 * Unlike the CMS, this schema *does* use foreign keys. An update or a wiki page only means anything
 * as part of one application, and a row orphaned by a deleted application would be invisible to
 * every route here while still occupying its slug.
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
 * One standalone application page: a banner, a row of tabs and the content behind them.
 *
 * The Overview and Contact tabs are a single Markdown document each, so they are columns rather
 * than tables — there is never more than one of either, and splitting them out would buy a join for
 * nothing. Updates and Wiki are lists, and get a table apiece.
 */
const applications = sqliteTable('applications', {
  id: text('id').primaryKey(),
  /** URL-safe identifier. This is what `/application/<slug>` on the website resolves. */
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  /** One line under the banner, e.g. "The ultimate styling solution for your server". */
  tagline: text('tagline'),
  /** Short plain-text blurb for listings and meta tags. */
  summary: text('summary'),
  /** `draft` | `published` | `archived`. Only `published` applications are visible publicly. */
  status: text('status').notNull().default('draft'),
  /** Pinned applications a listing may highlight. */
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  /** Manual ordering of the application list; lower comes first. */
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
   * How the application is paid for: `free`, `donation` (pay what you like, skipping allowed) or
   * `paid` (a download needs an approved purchase). See `src/lib/pricing.ts`.
   */
  pricingMode: text('pricing_mode').notNull().default('free'),
  /** Price of a `paid` application, in whole CLP. Meaningless in the other two modes. */
  priceAmount: integer('price_amount'),
  /** Amount a `donation` application suggests, in whole CLP. A suggestion, never a floor. */
  suggestedAmount: integer('suggested_amount'),
  /** Locale → overrides for the prose fields; see `src/lib/locales.ts`. */
  translations: text('translations').notNull().default('{}'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('applications_slug_unique').on(table.slug),
  index('applications_status_position_idx').on(table.status, table.position),
])

/**
 * One release note on an application's Updates tab.
 *
 * `releasedAt` rather than `publishedAt` is what the tab is ordered by: an editor writes the entry
 * when they write it, and says what day the release happened. The two are routinely different, and
 * a changelog ordered by when somebody got round to typing it is wrong.
 */
const applicationUpdates = sqliteTable('application_updates', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  /** Human-facing version label shown in the badge, e.g. `2.6.4`. Unique per application. */
  version: text('version').notNull(),
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
  uniqueIndex('application_updates_application_version_unique').on(table.applicationId, table.version),
  index('application_updates_application_released_idx').on(table.applicationId, table.status, table.releasedAt),
])

/**
 * One page of an application's Wiki tab.
 *
 * `parentId` is what makes the sidebar a tree rather than a list — a section with its own pages
 * under it, as `Overview → Commands` is in the reference design. It is deliberately only one level
 * deep by rule rather than by schema — `resolveParentId` in `src/services/wiki.ts` enforces it. A
 * self-referencing column cannot express a depth limit, and a sidebar that nests without bound
 * stops being navigable.
 */
const applicationWikiPages = sqliteTable('application_wiki_pages', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  /** Section this page hangs under, or null for a top-level entry in the sidebar. */
  parentId: text('parent_id'),
  /** URL-safe identifier, unique inside the application. `/application/<app>/wiki/<slug>`. */
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
  uniqueIndex('application_wiki_pages_application_slug_unique').on(table.applicationId, table.slug),
  index('application_wiki_pages_application_position_idx').on(table.applicationId, table.status, table.position),
])

/**
 * One downloadable artifact attached to a release note on the Updates tab.
 *
 * The bytes live in R2 and nothing here ever hands out a bucket URL: a download is always served by
 * `GET /downloads/:ticket`, which is the only place the payment state of the application can be
 * consulted at all. `objectKey` is therefore an internal detail and is never serialized into a
 * response — see `toPublicReleaseFile` in `src/services/release-files.ts`.
 *
 * `applicationId` is carried beside `updateId` even though the release already knows it. Every
 * public route here resolves an application first and a release second, and having the column means
 * the download path can check that a file belongs to the application in its URL with one read
 * instead of a join.
 */
const applicationReleaseFiles = sqliteTable('application_release_files', {
  id: text('id').primaryKey(),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  updateId: text('update_id')
    .notNull()
    .references(() => applicationUpdates.id, { onDelete: 'cascade' }),
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
  uniqueIndex('application_release_files_update_filename_unique').on(table.updateId, table.filename),
  index('application_release_files_update_position_idx').on(table.updateId, table.status, table.position),
  index('application_release_files_application_idx').on(table.applicationId),
])

/**
 * One payment taken for an application: a purchase of a paid one, or a donation to an optional-pay
 * one. An approved row is the entitlement — there is no second table saying so.
 *
 * Deriving access from the payment rather than from an `entitlements` row is deliberate: a refund is
 * a status change on the row that already exists, and an entitlement table would need the same
 * change applied twice, in the right order, from a webhook that can arrive more than once.
 *
 * **These are the only rows here with no foreign key onto `applications`, and that is the point.** A
 * payment is a financial record that has to outlive the page it was made for, so deleting an
 * application must not cascade into it. `applicationSlug` is snapshotted for the same reason: it is
 * what the row can still be read by once the application is gone.
 *
 * `userId` is the `sub` of the auth account that paid. It is never null: checkout requires a signed-in
 * account precisely so that a purchase has somewhere to live, which is why buying an application
 * creates an SSO account when the buyer has none.
 */
const purchases = sqliteTable('purchases', {
  id: text('id').primaryKey(),
  applicationId: text('application_id').notNull(),
  /** Snapshot of the slug at the time of payment; the row survives the application. */
  applicationSlug: text('application_slug').notNull(),
  /** `purchase` for a paid application, `donation` for an optional-pay one. */
  kind: text('kind').notNull().default('purchase'),
  /** `sub` claim of the account that paid. */
  userId: text('user_id').notNull(),
  /** Verified address the account held at the time, for the receipt and for support. */
  email: text('email').notNull(),
  /** `pending` | `in_process` | `approved` | `rejected` | `cancelled` | `refunded`. */
  status: text('status').notNull().default('pending'),
  /** What was charged, in whole units of `currency`. CLP has no minor unit. */
  amount: integer('amount').notNull(),
  currency: text('currency').notNull().default('CLP'),
  provider: text('provider').notNull().default('mercadopago'),
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
   * When the payer's bank took the money back. Kept apart from `refundedAt` for the same reason the
   * statuses are: a refund is ours, a chargeback is theirs, and only one of them comes with a fee and
   * a dispute deadline.
   */
  chargedBackAt: integer('charged_back_at', { mode: 'timestamp' }),
  /** MercadoPago's id for the dispute, so a support conversation can be traced to their console. */
  chargebackId: text('chargeback_id'),
  /** Free-form JSON. Must never carry a card detail, a provider token or an access token. */
  metadata: text('metadata'),
  ...timestamps,
}, (table) => [
  uniqueIndex('purchases_external_reference_unique').on(table.externalReference),
  index('purchases_application_user_idx').on(table.applicationId, table.userId, table.status),
  index('purchases_user_created_idx').on(table.userId, table.createdAt),
  index('purchases_payment_idx').on(table.paymentId),
  index('purchases_status_created_idx').on(table.status, table.createdAt),
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
  applicationId: text('application_id').notNull(),
  applicationSlug: text('application_slug').notNull(),
  updateId: text('update_id').notNull(),
  /** Version label of the release the file belonged to, snapshotted. */
  version: text('version').notNull(),
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
])

/** Append-only trail of every write an editor makes. Never updated, never deleted by the Worker. */
const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  /** Email of the editor who performed the action, taken from the verified access token. */
  actorEmail: text('actor_email'),
  actorId: text('actor_id'),
  /** Table the action touched, e.g. `applications`. */
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
 * is a fact about spend, not about the application page whose field happened to be translated, and
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
  applicationReleaseFiles,
  applications,
  applicationUpdates,
  applicationWikiPages,
  auditLogs,
  downloadEvents,
  paymentEvents,
  purchases,
}
