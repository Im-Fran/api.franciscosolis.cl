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

export { applications, applicationUpdates, applicationWikiPages, auditLogs }
