import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * D1 schema for `franciscosolis_support`.
 *
 * Conventions, kept in line with the auth, cms and pages Workers:
 * - Primary keys are UUID v4 strings generated in the Worker, so a row can be referenced before it
 *   is written and ids never leak insertion order.
 * - Timestamps are unix seconds (`integer` + `{ mode: 'timestamp' }`) defaulting to `unixepoch()`.
 * - People are recorded by email rather than by a foreign key: accounts live in the auth database,
 *   which this Worker cannot reach, and an email is what a support thread is read by anyway.
 * - Anything that acts as a credential is stored only as a SHA-256 hash, as in `apps/auth`.
 *
 * Two things here have no precedent elsewhere in the monorepo and are load-bearing:
 *
 * - **Ticket numbers come from a counter table, not from `max() + 1`.** The concurrency that will
 *   actually hit this is two inbound emails delivered in the same second, which is an ordinary
 *   Tuesday for a support inbox rather than an exotic race.
 * - **Messages carry a monotonic `seq` as well as a timestamp.** `unixepoch()` is whole seconds, so
 *   two messages in the same second have no defined order — and the deferred-notification digest is
 *   defined as "everything after the last one we sent", which needs a total order to be correct.
 *
 * There is deliberately **no column for HTML anywhere on a ticket**. Inbound mail is the only
 * unauthenticated free text this monorepo stores, and not having the column is what makes it
 * structurally impossible for a later change to render it. See `src/lib/mime.ts`.
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
 * Monotonic counters, currently just the ticket number.
 *
 * A support system needs a short reference a person can read out loud and type into a subject line,
 * which a UUID is not. Allocation is one statement — `UPDATE support_counters SET value = value + 1
 * WHERE name = ? RETURNING value` — because that is atomic in SQLite, where `SELECT max() + 1`
 * followed by an insert is not.
 */
const supportCounters = sqliteTable('support_counters', {
  name: text('name').primaryKey(),
  value: integer('value').notNull(),
})

/**
 * One support request.
 *
 * Two independent secrets hang off this row, and conflating them is a real bug waiting to happen:
 *
 * - `accessTokenHash` is a *credential*. It is what lets somebody without an account read their own
 *   thread in a browser, it travels in the fragment of an emailed link, and it must be rotatable the
 *   day that link is forwarded to the wrong person.
 * - `replyKey` is *routing metadata*. It is baked into the `reply+<key>@` address that sits in every
 *   participant's mail client forever, and rotating it would break their reply button.
 *
 * Different lifetimes, therefore different columns.
 */
const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  /** Allocated from `support_counters`. Rendered to people as `FS-<number>`. */
  number: integer('number').notNull(),
  /** Editable by an agent; the inbound pipeline seeds it from the email's subject. */
  subject: text('subject').notNull(),
  /** `new` | `open` | `pending` | `on_hold` | `solved` | `closed` | `spam`. */
  status: text('status').notNull().default('new'),
  /** `low` | `normal` | `high` | `urgent`. */
  priority: text('priority').notNull().default('normal'),
  /** `web` | `email` | `agent` — how the ticket got here. */
  source: text('source').notNull().default('web'),
  /** Which language this thread is conducted in. Decides which copy the notification emails use. */
  locale: text('locale').notNull().default('en'),
  /** Always stored lowercased; it is compared against a token's `email` claim. */
  requesterEmail: text('requester_email').notNull(),
  requesterName: text('requester_name'),
  /**
   * The auth `sub`, once known. Null until either the ticket was opened with an access token or the
   * account holder claimed it — this Worker cannot look an address up in the auth database, so a
   * link is only ever made by a token arriving on a request. See `src/routes/me.ts`.
   */
  requesterUserId: text('requester_user_id'),
  assigneeEmail: text('assignee_email'),
  assigneeUserId: text('assignee_user_id'),
  /** SHA-256 of the per-ticket access secret. Uniquely indexed so resolution is one index probe. */
  accessTokenHash: text('access_token_hash').notNull(),
  accessTokenRotatedAt: integer('access_token_rotated_at', { mode: 'timestamp' }),
  /** Opaque token in the `reply+<key>@` envelope address. The strongest threading signal we have. */
  replyKey: text('reply_key').notNull(),
  /** High-water mark for `ticket_messages.seq`. Allocated with `UPDATE ... RETURNING`. */
  lastMessageSeq: integer('last_message_seq').notNull().default(0),
  lastRequesterMessageAt: integer('last_requester_message_at', { mode: 'timestamp' }),
  lastAgentMessageAt: integer('last_agent_message_at', { mode: 'timestamp' }),
  /** First public agent reply. The only response-time metric worth keeping on the row. */
  firstResponseAt: integer('first_response_at', { mode: 'timestamp' }),
  solvedAt: integer('solved_at', { mode: 'timestamp' }),
  closedAt: integer('closed_at', { mode: 'timestamp' }),
  /** Whether the Workers AI pass ran and what it produced. Kept so a bad summary is traceable. */
  aiEnriched: integer('ai_enriched', { mode: 'boolean' }).notNull().default(false),
  aiModel: text('ai_model'),
  aiSummary: text('ai_summary'),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('tickets_number_unique').on(table.number),
  uniqueIndex('tickets_access_token_hash_unique').on(table.accessTokenHash),
  uniqueIndex('tickets_reply_key_unique').on(table.replyKey),
  index('tickets_status_updated_idx').on(table.status, table.updatedAt),
  index('tickets_assignee_status_idx').on(table.assigneeEmail, table.status),
  index('tickets_requester_email_idx').on(table.requesterEmail),
  index('tickets_requester_user_idx').on(table.requesterUserId),
])

/**
 * One message on a ticket: a reply everybody on the thread can see, or an internal note only agents
 * can. The distinction is `kind`, and it is the one field in this table a bug in would be a data
 * breach rather than a glitch — hence the redaction living in one place, `toRequesterTimeline` in
 * `src/services/tickets.ts`, rather than in each route.
 *
 * `bodyText` is the trimmed message; `bodyTextRaw` keeps the untouched inbound body so a quoted-reply
 * trim that cut too much is recoverable rather than lost.
 */
const ticketMessages = sqliteTable('ticket_messages', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  /** Per-ticket ordinal from `tickets.lastMessageSeq`. The digest window is defined on this. */
  seq: integer('seq').notNull(),
  /** `reply` (visible to the requester) | `note` (internal to the support team). */
  kind: text('kind').notNull().default('reply'),
  /** `requester` | `agent` | `system`. */
  authorType: text('author_type').notNull(),
  authorEmail: text('author_email'),
  authorName: text('author_name'),
  authorUserId: text('author_user_id'),
  /** Plain text. Never HTML — see the note at the top of this file. */
  bodyText: text('body_text').notNull(),
  /** The inbound body before the quoted trail was trimmed. Null for messages written on the web. */
  bodyTextRaw: text('body_text_raw'),
  /** `web` | `email` | `api`. */
  source: text('source').notNull().default('web'),
  /** JSON `[{ filename, mime_type, size }]`. Metadata only: the bytes are not stored. */
  attachmentsMeta: text('attachments_meta').notNull().default('[]'),
  editedAt: integer('edited_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('ticket_messages_ticket_seq_unique').on(table.ticketId, table.seq),
  index('ticket_messages_ticket_created_idx').on(table.ticketId, table.createdAt),
])

/**
 * Everybody who should hear about a ticket: the requester, anyone put on copy, and the agents who
 * picked it up.
 *
 * `notifyEmail` is stored rather than inferred. Deciding at send time whether a recipient "looks
 * like an agent" would re-run the email-domain gate from a completely different part of the system,
 * and would mail an agent who signed up with a personal address. The decision is made once, when
 * the participant is added, and then it is a fact on a row.
 */
const ticketParticipants = sqliteTable('ticket_participants', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  /** Lowercased. */
  email: text('email').notNull(),
  name: text('name'),
  userId: text('user_id'),
  /** `requester` | `agent` | `cc`. */
  role: text('role').notNull().default('cc'),
  /**
   * An internal-only classification an agent can put on a participant — `guest` for somebody
   * along for the ride, `interest` for somebody the team wants to keep an eye on. Never shown to
   * the requester's own view of the ticket: `toRequesterParticipant` in `src/services/tickets.ts`
   * drops it, the way `GET /tickets/:reference` already drops the agent role.
   */
  tag: text('tag'),
  notifyEmail: integer('notify_email', { mode: 'boolean' }).notNull().default(true),
  /** Highest `ticket_messages.seq` this person has already been emailed about. */
  lastNotifiedSeq: integer('last_notified_seq').notNull().default(0),
  /** Highest seq they have opened in the browser. Drives the unread badge in the console. */
  lastReadSeq: integer('last_read_seq').notNull().default(0),
  addedBy: text('added_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('ticket_participants_ticket_email_unique').on(table.ticketId, table.email),
  index('ticket_participants_email_idx').on(table.email),
])

/**
 * The label catalogue. Carries `translations` for the same reason help articles do: a Spanish
 * speaker being shown `Billing question` is precisely the bug the CMS's translation model exists to
 * prevent, and a label is rendered on the public thread view as well as in the console.
 */
const labels = sqliteTable('labels', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Hex colour the console and the thread view render the chip with, e.g. `#A855F7`. */
  color: text('color'),
  position: integer('position').notNull().default(0),
  translations: text('translations').notNull().default('{}'),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('labels_slug_unique').on(table.slug),
  index('labels_position_idx').on(table.position),
])

const ticketLabels = sqliteTable('ticket_labels', {
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  labelId: text('label_id')
    .notNull()
    .references(() => labels.id, { onDelete: 'cascade' }),
  addedBy: text('added_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  primaryKey({ columns: [table.ticketId, table.labelId] }),
  index('ticket_labels_label_idx').on(table.labelId),
])

/**
 * The activity feed, in the shape a GitHub issue shows it: who changed what, when.
 *
 * Messages deliberately do **not** live here. A polymorphic row carrying a 64 KB body would make
 * every timeline read drag the whole thread across, and the two are queried on different axes — the
 * digest wants messages by `seq`, the timeline wants events by time. `buildTimeline` in
 * `src/services/tickets.ts` merges them for display instead.
 */
const ticketEvents = sqliteTable('ticket_events', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  /** See `TICKET_EVENTS` in `src/lib/config.ts` for the closed vocabulary. */
  event: text('event').notNull(),
  /** `requester` | `agent` | `system`. */
  actorType: text('actor_type').notNull().default('system'),
  actorEmail: text('actor_email'),
  /** JSON. Never a message body — this table is exported to the console and bodies are personal. */
  metadata: text('metadata').notNull().default('{}'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('ticket_events_ticket_created_idx').on(table.ticketId, table.createdAt),
])

/**
 * The deferred-reply queue — the whole of the "tell them in 30 minutes unless they came back" rule.
 *
 * The partial unique index is what makes "one pending notice per person per ticket" an invariant of
 * the database rather than a convention in the service layer, and it is what lets a second agent
 * reply inside the window be an `ON CONFLICT DO NOTHING` instead of an extension of `dueAt`. That
 * distinction matters: extending would let a chatty agent push the notice out indefinitely and the
 * requester would never hear anything at all.
 */
const ticketNotifications = sqliteTable('ticket_notifications', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  recipientEmail: text('recipient_email').notNull(),
  /** `pending` | `sending` | `sent` | `cancelled` | `failed`. */
  state: text('state').notNull().default('pending'),
  dueAt: integer('due_at', { mode: 'timestamp' }).notNull(),
  /** The digest covers every agent reply with `seq > afterSeq`. */
  afterSeq: integer('after_seq').notNull().default(0),
  /** Highest seq actually included, filled in on send. */
  throughSeq: integer('through_seq'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /** When the sweep took the row. A row stuck here past `NOTIFICATIONS.reapAfterSeconds` is reaped. */
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
  cancelReason: text('cancel_reason'),
  ...timestamps,
}, (table) => [
  index('ticket_notifications_state_due_idx').on(table.state, table.dueAt),
  uniqueIndex('ticket_notifications_pending_unique')
    .on(table.ticketId, table.recipientEmail)
    .where(sql`state = 'pending'`),
  index('ticket_notifications_ticket_idx').on(table.ticketId),
])

/**
 * Every message Email Routing handed us, whether or not it became anything.
 *
 * Its first job is idempotency: Email Routing retries, and without a unique key a retried delivery
 * would post the same reply twice. Its second is forensics — "why did this email not show up" is the
 * question a support system gets asked about itself, and the answer has to be in the database.
 *
 * The raw `Message-ID` is attacker-controlled unbounded text, so the unique index is over its
 * SHA-256 rather than over the header itself.
 */
const inboundEmails = sqliteTable('inbound_emails', {
  id: text('id').primaryKey(),
  messageIdHash: text('message_id_hash').notNull(),
  /** The raw header, truncated, so a human reading this table can recognise it. */
  messageId: text('message_id'),
  fromEmail: text('from_email').notNull(),
  toEmail: text('to_email').notNull(),
  subject: text('subject'),
  rawSize: integer('raw_size').notNull().default(0),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  ticketMessageId: text('ticket_message_id'),
  /** `reply_key` | `in_reply_to` | `references` | `subject_tag` | `new`. */
  matchStrategy: text('match_strategy'),
  /** `created` | `appended` | `duplicate` | `rejected` | `ignored` | `failed`. */
  outcome: text('outcome').notNull(),
  rejectReason: text('reject_reason'),
  attachmentCount: integer('attachment_count').notNull().default(0),
  /** Null until the enrichment pass runs; false if the model failed and the heuristics stood. */
  aiOk: integer('ai_ok', { mode: 'boolean' }),
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('inbound_emails_message_id_hash_unique').on(table.messageIdHash),
  index('inbound_emails_from_received_idx').on(table.fromEmail, table.receivedAt),
  index('inbound_emails_ticket_idx').on(table.ticketId),
])

/**
 * Outbound mail, logged the same way `apps/cms` logs it: a row inserted `queued`, then updated to
 * `sent` with the provider's id or `failed` with the error, so a message that never arrived can be
 * told apart from one that was never attempted.
 *
 * Both id columns are indexed because they are threading keys: a reply's `In-Reply-To` is matched
 * against them to find the ticket it belongs to.
 */
const emailMessages = sqliteTable('email_messages', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  /** `ticket_received` | `reply_digest` | `participant_added` | `status_changed` | `access_link`. */
  kind: text('kind').notNull(),
  toAddresses: text('to_addresses').notNull(),
  fromEmail: text('from_email').notNull(),
  fromName: text('from_name'),
  replyTo: text('reply_to'),
  subject: text('subject').notNull(),
  html: text('html'),
  text: text('text'),
  /** `queued` | `sent` | `failed`. */
  status: text('status').notNull().default('queued'),
  /** Whatever `env.EMAIL.send()` returned. Not necessarily the RFC `Message-ID` the client echoes. */
  providerMessageId: text('provider_message_id'),
  /** The `Message-ID` we asked for, when we were able to set one. */
  rfcMessageId: text('rfc_message_id'),
  error: text('error'),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('email_messages_ticket_idx').on(table.ticketId),
  index('email_messages_provider_id_idx').on(table.providerMessageId),
  index('email_messages_rfc_id_idx').on(table.rfcMessageId),
  index('email_messages_created_idx').on(table.createdAt),
])

/** A section of the help centre. */
const helpCategories = sqliteTable('help_categories', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  /** Icon key the website maps to a glyph. Free text; the website owns the mapping. */
  icon: text('icon'),
  status: text('status').notNull().default('draft'),
  position: integer('position').notNull().default(0),
  translations: text('translations').notNull().default('{}'),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('help_categories_slug_unique').on(table.slug),
  index('help_categories_status_position_idx').on(table.status, table.position),
])

/**
 * One help article.
 *
 * `categoryId` is `set null` rather than `cascade` on purpose: deleting a section must not silently
 * take its documentation with it. That is a footgun a console eventually fires.
 *
 * `vectorIds` records the Vectorize ids this article actually wrote. Re-indexing deletes exactly
 * those before upserting the new set — recomputing the list from the current chunk count would miss
 * the trailing chunks of an article that got shorter, and leave them answering searches forever.
 */
const helpArticles = sqliteTable('help_articles', {
  id: text('id').primaryKey(),
  categoryId: text('category_id').references(() => helpCategories.id, { onDelete: 'set null' }),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  /** Markdown, rendered by the website. */
  body: text('body'),
  status: text('status').notNull().default('draft'),
  position: integer('position').notNull().default(0),
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  /** JSON array of free-text tags. */
  tags: text('tags').notNull().default('[]'),
  translations: text('translations').notNull().default('{}'),
  /** JSON array of the Vectorize ids currently holding this article's chunks. */
  vectorIds: text('vector_ids').notNull().default('[]'),
  searchIndexedAt: integer('search_indexed_at', { mode: 'timestamp' }),
  /** Explicit thumbs up/down. Deliberately not a view counter: see `help_article_feedback`. */
  helpfulYes: integer('helpful_yes').notNull().default(0),
  helpfulNo: integer('helpful_no').notNull().default(0),
  publishedAt: integer('published_at', { mode: 'timestamp' }),
  ...authorship,
  ...timestamps,
}, (table) => [
  uniqueIndex('help_articles_slug_unique').on(table.slug),
  index('help_articles_status_position_idx').on(table.status, table.position),
  index('help_articles_category_position_idx').on(table.categoryId, table.position),
])

/**
 * One thumbs up or down on an article.
 *
 * Deduplicated by a per-day fingerprint of the caller rather than by a cookie, so a refresh does not
 * inflate the count. There is deliberately **no view counter** anywhere near an article: incrementing
 * a row on every public read turns a cacheable GET into a D1 write, which is the textbook way to run
 * a small database out of budget.
 */
const helpArticleFeedback = sqliteTable('help_article_feedback', {
  id: text('id').primaryKey(),
  articleId: text('article_id')
    .notNull()
    .references(() => helpArticles.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull().default('en'),
  helpful: integer('helpful', { mode: 'boolean' }).notNull(),
  comment: text('comment'),
  /** SHA-256 of client IP + user agent + the day. Coarse on purpose; it is a dedupe key, not an id. */
  fingerprintHash: text('fingerprint_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex('help_article_feedback_article_fingerprint_unique').on(table.articleId, table.fingerprintHash),
  index('help_article_feedback_article_created_idx').on(table.articleId, table.createdAt),
])

/**
 * Searches that found nothing useful.
 *
 * Only written when the result count is at or below `HELP_SEARCH.logResultThreshold`. One write per
 * public search would be indefensible write amplification for a search box; one write per *failed*
 * search is the "what are people asking that nobody has written up" report, which is the only reason
 * to log searches at all.
 */
const helpSearchQueries = sqliteTable('help_search_queries', {
  id: text('id').primaryKey(),
  term: text('term').notNull(),
  locale: text('locale').notNull().default('en'),
  resultCount: integer('result_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('help_search_queries_created_idx').on(table.createdAt),
])

/**
 * Every call made to Workers AI.
 *
 * Workers AI is metered per neuron and there is no per-Worker spend cap, so without this table the
 * first sign of a runaway loop in a front-end is the invoice. It doubles as the rate limiter's
 * index — `(actorEmail, createdAt)` is exactly the query the assistant's hourly cap runs.
 */
const aiRequests = sqliteTable('ai_requests', {
  id: text('id').primaryKey(),
  /** `assist` | `email_extract` | `embed`. */
  kind: text('kind').notNull(),
  model: text('model').notNull(),
  actorEmail: text('actor_email'),
  ticketId: text('ticket_id'),
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

/**
 * The audit trail, as in the cms and pages Workers.
 *
 * One difference here: `email()` and `scheduled()` have no Hono context, so `recordSystemAudit` in
 * `src/services/audit.ts` writes rows with no IP and no user agent. Message bodies never go in
 * `metadata` — this table is read out in the console and the bodies are somebody's personal data.
 */
const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  actorEmail: text('actor_email'),
  actorId: text('actor_id'),
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),
  metadata: text('metadata').notNull().default('{}'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => [
  index('audit_logs_created_idx').on(table.createdAt),
  index('audit_logs_actor_idx').on(table.actorEmail),
  index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
])

export {
  aiRequests,
  auditLogs,
  emailMessages,
  helpArticleFeedback,
  helpArticles,
  helpCategories,
  helpSearchQueries,
  inboundEmails,
  labels,
  supportCounters,
  ticketEvents,
  ticketLabels,
  ticketMessages,
  ticketNotifications,
  ticketParticipants,
  tickets,
}
