import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_notifications`.
 *
 * Conventions, kept in line with the other stateful Workers:
 * - Primary keys are UUID strings generated outside the database. For a notification it is the
 *   producer's event id, which is what makes a queue redelivery a no-op (see `services/ingest.ts`).
 * - Timestamps are unix seconds (`integer` + `{ mode: 'timestamp' }`) defaulting to `unixepoch()`.
 * - People are keyed by the auth `sub`. There is no foreign key into the auth database — it is not
 *   reachable from here, and must not be — so `recipients` is this Worker's own copy of the little it
 *   needs to email somebody: an address, a name, a language.
 *
 * Nothing is ever purged on a schedule. Retention is indefinite by decision; a person deletes their
 * own notifications, and that is the only delete path there is.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}

/**
 * One account this Worker has heard of, with its preferences.
 *
 * Written from two directions, and both matter. A producer's event carries the address the account
 * had when it happened; a signed-in request carries the one on the token. Whichever is newer wins, so
 * an address changed in auth reaches the digest the next time either happens. `email` is nullable
 * because a producer may know an account id and nothing else — that account simply gets no email
 * until one of the two paths tells us where to send it.
 *
 * `categoryPreferences` is JSON rather than six boolean columns: it is only ever read and written
 * whole, and a new category is a registry entry in `lib/config.ts` rather than a migration. A key
 * missing from it means "on", so every existing row picks up a new category with the default.
 *
 * `lastDigestAt` is the high-water mark the next digest starts from. It is the only state the digest
 * keeps, and it is advanced in the same batch that marks the rows as emailed.
 */
const recipients = sqliteTable(
  'recipients',
  {
    userId: text('user_id').primaryKey(),
    email: text('email'),
    name: text('name'),
    locale: text('locale').notNull().default('en'),
    emailFrequency: text('email_frequency').notNull().default('daily'),
    categoryPreferences: text('category_preferences').notNull().default('{}'),
    lastDigestAt: integer('last_digest_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [index('recipients_frequency_idx').on(table.emailFrequency)],
)

/**
 * One notification in one person's inbox.
 *
 * `data` is the producer's flat parameter object and the text is rendered on read (`lib/catalog.ts`),
 * so a notification can be read in whichever language the reader has today.
 *
 * `emailStatus` is the digest's queue, and a column rather than a join because the digest query has
 * to be one indexed scan per recipient:
 * - `none` — never going out by email: the type is not emailable, or the recipient turned email off
 *   for the category, or their frequency is `never`, all as of when it arrived.
 * - `pending` — waiting for the next daily or weekly digest.
 * - `sent` — went out, immediately or in a digest. `emailedAt` says when.
 * - `skipped` — was pending, and the recipient read it on the site before the digest ran. A digest
 *   repeating what somebody has already seen is exactly the mail this Worker exists to not send.
 */
const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    category: text('category').notNull(),
    data: text('data').notNull().default('{}'),
    url: text('url'),
    readAt: integer('read_at', { mode: 'timestamp' }),
    emailStatus: text('email_status').notNull().default('none'),
    emailedAt: integer('emailed_at', { mode: 'timestamp' }),
    /** When the event happened, per its producer. Ordering uses `createdAt`, when it arrived here. */
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('notifications_user_created_idx').on(table.userId, table.createdAt, table.id),
    index('notifications_user_unread_idx').on(table.userId, table.readAt),
    index('notifications_user_email_idx').on(table.userId, table.emailStatus),
  ],
)

/**
 * One browser or device that asked to be pushed to.
 *
 * `endpoint` is unique across the table, not per account: it identifies a browser profile, and when
 * somebody signs out and another account signs in on the same browser, the subscription moves to
 * the account that registered it last. Leaving it on both would push one person's sign-in notices to
 * the other's screen.
 *
 * `p256dh` and `auth` are the browser's public key and shared secret for payload encryption
 * (RFC 8291). They are not credentials for anything here — they only let us encrypt *to* that
 * browser — but they are still never returned by the API, since nothing needs them back.
 */
const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    failureCount: integer('failure_count').notNull().default(0),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [index('push_subscriptions_user_idx').on(table.userId)],
)

export { notifications, pushSubscriptions, recipients }
