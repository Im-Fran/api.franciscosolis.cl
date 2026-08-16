import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_cms`.
 *
 * Conventions, kept in line with the auth Worker's schema:
 * - Primary keys are UUID v4 strings generated in the Worker, so a row can be referenced before
 *   it is written and ids never leak insertion order.
 * - Timestamps are unix seconds (`integer` + `{ mode: 'timestamp' }`) defaulting to `unixepoch()`.
 * - Editors are recorded by email rather than by a foreign key: accounts live in the auth
 *   database, which this Worker cannot reach, and an email is what an audit trail is read by.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}

/**
 * Every piece of landing-page content — projects, experience, skills, certifications and whatever
 * comes next — lives in this one table, discriminated by `collection`.
 *
 * The columns are the fields every collection shares; anything specific to one collection goes in
 * the `data` JSON blob, whose shape is validated per collection by the registry in
 * `src/lib/collections.ts`. Adding a collection is therefore a registry entry, not a migration.
 */
const contentEntries = sqliteTable('content_entries', {
  id: text('id').primaryKey(),
  /** Collection slug, e.g. `projects`. Must exist in the collection registry. */
  collection: text('collection').notNull(),
  /** URL-safe identifier, unique inside its collection. This is what the website looks entries up by. */
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  /** Short plain-text blurb for cards and listings. */
  summary: text('summary'),
  /** Long form body, Markdown. Rendered by the website, never by this Worker. */
  body: text('body'),
  /** `draft` | `published` | `archived`. Only `published` entries are visible publicly. */
  status: text('status').notNull().default('draft'),
  /** Pinned entries the website may highlight, e.g. featured projects. */
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  /** Manual ordering inside a collection; lower comes first. Ties break by `startedAt`, then title. */
  position: integer('position').notNull().default(0),
  /** Start of the period an entry covers (a job, a certification's issue date, a project's kickoff). */
  startedAt: integer('started_at', { mode: 'timestamp' }),
  /** End of that period. Null means "still ongoing" — a current job, a certification with no expiry. */
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  /** Canonical external link: repository, live site, credential verification URL. */
  url: text('url'),
  imageUrl: text('image_url'),
  /** JSON array of free-form tags. */
  tags: text('tags').notNull().default('[]'),
  /** JSON object with the collection-specific fields. Validated against the collection's schema. */
  data: text('data').notNull().default('{}'),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  ...timestamps,
}, (table) => [
  uniqueIndex('content_entries_collection_slug_unique').on(table.collection, table.slug),
  index('content_entries_collection_status_idx').on(table.collection, table.status, table.position),
])

/**
 * Legal pages of the landing site (privacy policy, terms, cookies…). Separate from
 * `content_entries` because they are documents rather than list items: they are addressed by slug,
 * they carry a version and an effective date, and only one of them is ever rendered at a time.
 */
const legalPages = sqliteTable('legal_pages', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  /** Short description of what the document covers, for listings and meta tags. */
  summary: text('summary'),
  /** Full document body, Markdown. */
  body: text('body').notNull(),
  status: text('status').notNull().default('draft'),
  /** Human-facing version label shown on the page, e.g. `2026-08` or `1.2`. */
  version: text('version'),
  /** Date the published text takes effect. May be in the future while the page is still a draft. */
  effectiveAt: integer('effective_at', { mode: 'timestamp' }),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  ...timestamps,
}, (table) => [
  uniqueIndex('legal_pages_slug_unique').on(table.slug),
])

/**
 * Reusable email bodies. `subject`, `html` and `text` are rendered with `{{ variable }}`
 * placeholders filled in at send time, so recurring mail does not have to be pasted by hand.
 */
const emailTemplates = sqliteTable('email_templates', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  subject: text('subject').notNull(),
  html: text('html'),
  text: text('text'),
  /** JSON array of the variable names the template expects. Missing ones are rejected at send time. */
  variables: text('variables').notNull().default('[]'),
  createdBy: text('created_by'),
  updatedBy: text('updated_by'),
  ...timestamps,
}, (table) => [
  uniqueIndex('email_templates_slug_unique').on(table.slug),
])

/**
 * One row per message handed to Cloudflare Email Sending, written before the send is attempted so
 * a failure leaves a trace instead of vanishing. The rendered body is kept: "what exactly did we
 * send that person" is the question this table exists to answer.
 */
const emailMessages = sqliteTable('email_messages', {
  id: text('id').primaryKey(),
  /** JSON array of recipient addresses. */
  toAddresses: text('to_addresses').notNull(),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name'),
  replyTo: text('reply_to'),
  subject: text('subject').notNull(),
  html: text('html'),
  text: text('text'),
  /** Slug of the template used, or null for an ad-hoc message. */
  templateSlug: text('template_slug'),
  /** `queued` while the send is in flight, then `sent` or `failed`. */
  status: text('status').notNull(),
  /** Message id returned by Cloudflare Email Sending, present only on a successful send. */
  messageId: text('message_id'),
  error: text('error'),
  sentBy: text('sent_by'),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('email_messages_created_at_idx').on(table.createdAt),
  index('email_messages_status_idx').on(table.status),
])

/** Append-only trail of every write an editor makes. Never updated, never deleted by the Worker. */
const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  /** Email of the editor who performed the action, taken from the verified access token. */
  actorEmail: text('actor_email'),
  actorId: text('actor_id'),
  /** Table the action touched, e.g. `content_entries`. */
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

export { auditLogs, contentEntries, emailMessages, emailTemplates, legalPages }
