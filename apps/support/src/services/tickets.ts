import { and, asc, desc, eq, gt, like, or, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import type { Database } from '@/db/client'
import {
  labels,
  ticketEvents,
  ticketLabels,
  ticketMessages,
  ticketParticipants,
  tickets,
  supportCounters,
} from '@/db/schema'
import type { Env } from '@/env'
import type { AuthorType, MessageKind, TicketEvent, TicketPriority, TicketStatus } from '@/lib/config'
import { PAGINATION } from '@/lib/config'
import { parseJson } from '@/lib/json'
import { DEFAULT_LOCALE, LABEL_TRANSLATABLE_FIELDS, localize, parseTranslations } from '@/lib/locales'
import { formatReference } from '@/lib/references'
import type { Locale } from '@/lib/locales'
import { buildReplyAddress, buildTicketUrl, generateSecret, sha256 } from '@/lib/tokens'

type TicketRow = typeof tickets.$inferSelect
type MessageRow = typeof ticketMessages.$inferSelect
type ParticipantRow = typeof ticketParticipants.$inferSelect
type EventRow = typeof ticketEvents.$inferSelect
type LabelRow = typeof labels.$inferSelect

type AttachmentMeta = {
  filename: string
  mime_type: string
  size: number
}

/**
 * Allocates the next ticket number.
 *
 * One statement, because that is the only shape SQLite makes atomic. `SELECT max(number) + 1`
 * followed by an insert looks equivalent and is not: two inbound emails delivered in the same second
 * — which is an ordinary Tuesday for a support inbox, not an exotic race — would both read the same
 * maximum and one of them would then violate the unique index.
 */
const nextTicketNumber = async (db: Database): Promise<number> => {
  const [row] = await db
    .update(supportCounters)
    .set({ value: sql`${supportCounters.value} + 1` })
    .where(eq(supportCounters.name, 'ticket'))
    .returning({ value: supportCounters.value })

  if (!row) {
    // The counter is seeded by `migrations/0001_seed.sql`. Its absence means the seed never ran, and
    // silently starting from 1 would collide with whatever numbers the database already holds.
    throw new Error('the ticket counter row is missing; has migrations/0001_seed.sql been applied?')
  }
  return row.value
}

/**
 * Allocates the next per-ticket message ordinal.
 *
 * Same reasoning as the ticket number, plus one of its own: `created_at` is `unixepoch()`, which is
 * whole seconds, so two messages posted in the same second have no defined order between them. The
 * deferred-notification digest is literally "every agent reply after the last one we sent", which
 * cannot be expressed against a key that has ties.
 */
const nextMessageSeq = async (db: Database, ticketId: string): Promise<number> => {
  const [row] = await db
    .update(tickets)
    .set({ lastMessageSeq: sql`${tickets.lastMessageSeq} + 1`, updatedAt: new Date() })
    .where(eq(tickets.id, ticketId))
    .returning({ seq: tickets.lastMessageSeq })

  if (!row) {
    throw new HTTPException(404, { message: 'Ticket not found' })
  }
  return row.seq
}

/** Appends a row to the ticket's activity feed. Never carries a message body — see `services/audit.ts`. */
const recordEvent = async (
  db: Database,
  input: {
    ticketId: string
    event: TicketEvent
    actorType?: AuthorType
    actorEmail?: string | null
    metadata?: Record<string, unknown>
  },
) => {
  await db.insert(ticketEvents).values({
    id: crypto.randomUUID(),
    ticketId: input.ticketId,
    event: input.event,
    actorType: input.actorType ?? 'system',
    actorEmail: input.actorEmail ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
  })
}

type CreateTicketInput = {
  subject: string
  bodyText: string
  bodyTextRaw?: string | null
  requesterEmail: string
  requesterName?: string | null
  requesterUserId?: string | null
  locale?: Locale
  source?: 'web' | 'email' | 'agent'
  priority?: TicketPriority
  ccEmails?: string[]
  attachments?: AttachmentMeta[]
  createdBy?: string | null
}

type CreatedTicket = {
  ticket: TicketRow
  /** The plaintext access secret. Returned exactly once — only its hash is stored. */
  accessToken: string
  firstMessage: MessageRow
}

/**
 * Opens a ticket.
 *
 * The two secrets are minted here and the plaintext access token is handed back to the caller
 * exactly once, to put in the confirmation email. After this function returns, nothing in the system
 * can recover it — only its SHA-256 is stored — which is the property that makes a database dump
 * useless for reading tickets.
 */
const createTicket = async (db: Database, env: Env, input: CreateTicketInput): Promise<CreatedTicket> => {
  const number = await nextTicketNumber(db)
  const accessToken = generateSecret()
  const now = new Date()
  const requesterEmail = input.requesterEmail.trim().toLowerCase()

  const ticket: TicketRow = {
    id: crypto.randomUUID(),
    number,
    subject: input.subject,
    status: 'new',
    priority: input.priority ?? 'normal',
    source: input.source ?? 'web',
    locale: input.locale ?? DEFAULT_LOCALE,
    requesterEmail,
    requesterName: input.requesterName ?? null,
    requesterUserId: input.requesterUserId ?? null,
    assigneeEmail: null,
    assigneeUserId: null,
    accessTokenHash: await sha256(accessToken),
    accessTokenRotatedAt: null,
    replyKey: generateSecret(),
    lastMessageSeq: 1,
    lastRequesterMessageAt: now,
    lastAgentMessageAt: null,
    firstResponseAt: null,
    solvedAt: null,
    closedAt: null,
    aiEnriched: false,
    aiModel: null,
    aiSummary: null,
    createdBy: input.createdBy ?? requesterEmail,
    updatedBy: input.createdBy ?? requesterEmail,
    createdAt: now,
    updatedAt: now,
  }

  const firstMessage: MessageRow = {
    id: crypto.randomUUID(),
    ticketId: ticket.id,
    // The opening message is seq 1, which is why the ticket is inserted with `lastMessageSeq: 1`
    // rather than 0 — the allocator above is for every message after this one.
    seq: 1,
    kind: 'reply',
    authorType: 'requester',
    authorEmail: requesterEmail,
    authorName: input.requesterName ?? null,
    authorUserId: input.requesterUserId ?? null,
    bodyText: input.bodyText,
    bodyTextRaw: input.bodyTextRaw ?? null,
    source: input.source === 'email' ? 'email' : 'web',
    attachmentsMeta: JSON.stringify(input.attachments ?? []),
    editedAt: null,
    createdAt: now,
  }

  const cc = [...new Set((input.ccEmails ?? []).map((email) => email.trim().toLowerCase()))].filter(
    (email) => email.length > 0 && email !== requesterEmail,
  )

  await db.insert(tickets).values(ticket)

  // Everything below is independent of everything else and none of it needs a returned value, so it
  // goes across as one D1 batch rather than five round trips. The two statements that *cannot* join
  // it are the counter and the seq allocator above: both are read-modify-write and the caller needs
  // what they returned.
  await db.batch([
    db.insert(ticketMessages).values(firstMessage),
    db.insert(ticketParticipants).values({
      id: crypto.randomUUID(),
      ticketId: ticket.id,
      email: requesterEmail,
      name: input.requesterName ?? null,
      userId: input.requesterUserId ?? null,
      role: 'requester',
      notifyEmail: true,
      lastNotifiedSeq: 1,
      lastReadSeq: 1,
      addedBy: null,
    }),
    ...cc.map((email) =>
      db.insert(ticketParticipants).values({
        id: crypto.randomUUID(),
        ticketId: ticket.id,
        email,
        role: 'cc',
        notifyEmail: true,
        lastNotifiedSeq: 1,
        addedBy: requesterEmail,
      }),
    ),
    db.insert(ticketEvents).values({
      id: crypto.randomUUID(),
      ticketId: ticket.id,
      event: 'created',
      actorType: 'requester',
      actorEmail: requesterEmail,
      metadata: JSON.stringify({ source: ticket.source, cc_count: cc.length }),
    }),
  ])

  return { ticket, accessToken, firstMessage }
}

const findTicketById = async (db: Database, id: string): Promise<TicketRow | null> => {
  const [row] = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1)
  return row ?? null
}

const findTicketByNumber = async (db: Database, number: number): Promise<TicketRow | null> => {
  const [row] = await db.select().from(tickets).where(eq(tickets.number, number)).limit(1)
  return row ?? null
}

/**
 * Resolves a ticket from a presented access secret.
 *
 * The lookup is on the *hash*, which is uniquely indexed, so this is one index probe rather than a
 * fetch followed by a comparison. That is not only faster: comparing a stored secret to a presented
 * one in JavaScript leaks it a byte at a time through timing unless the comparison is written to be
 * constant-time, and an index lookup removes the question instead of answering it.
 */
const findTicketByAccessToken = async (db: Database, token: string): Promise<TicketRow | null> => {
  const [row] = await db.select().from(tickets).where(eq(tickets.accessTokenHash, await sha256(token))).limit(1)
  return row ?? null
}

const findTicketByReplyKey = async (db: Database, replyKey: string): Promise<TicketRow | null> => {
  const [row] = await db.select().from(tickets).where(eq(tickets.replyKey, replyKey)).limit(1)
  return row ?? null
}

const listParticipants = async (db: Database, ticketId: string): Promise<ParticipantRow[]> =>
  db.select().from(ticketParticipants).where(eq(ticketParticipants.ticketId, ticketId)).orderBy(asc(ticketParticipants.createdAt))

const findParticipant = async (db: Database, ticketId: string, email: string): Promise<ParticipantRow | null> => {
  const [row] = await db
    .select()
    .from(ticketParticipants)
    .where(and(eq(ticketParticipants.ticketId, ticketId), eq(ticketParticipants.email, email.trim().toLowerCase())))
    .limit(1)
  return row ?? null
}

type AddMessageInput = {
  ticketId: string
  kind: MessageKind
  authorType: AuthorType
  authorEmail?: string | null
  authorName?: string | null
  authorUserId?: string | null
  bodyText: string
  bodyTextRaw?: string | null
  source?: 'web' | 'email' | 'api'
  attachments?: AttachmentMeta[]
}

/**
 * Appends a message and moves the ticket's clocks.
 *
 * `firstResponseAt` is stamped once, on the first public agent reply — an internal note is the team
 * talking to itself and is not a response to anybody. The status nudge from `new` to `open` on that
 * same event is what stops a ticket that has been answered from sitting in the "nobody has looked at
 * this" bucket.
 */
const addMessage = async (db: Database, input: AddMessageInput): Promise<MessageRow> => {
  const seq = await nextMessageSeq(db, input.ticketId)
  const now = new Date()
  const isPublicAgentReply = input.authorType === 'agent' && input.kind === 'reply'

  const message: MessageRow = {
    id: crypto.randomUUID(),
    ticketId: input.ticketId,
    seq,
    kind: input.kind,
    authorType: input.authorType,
    authorEmail: input.authorEmail?.trim().toLowerCase() ?? null,
    authorName: input.authorName ?? null,
    authorUserId: input.authorUserId ?? null,
    bodyText: input.bodyText,
    bodyTextRaw: input.bodyTextRaw ?? null,
    source: input.source ?? 'web',
    attachmentsMeta: JSON.stringify(input.attachments ?? []),
    editedAt: null,
    createdAt: now,
  }

  await db.insert(ticketMessages).values(message)

  if (isPublicAgentReply) {
    await db
      .update(tickets)
      .set({
        lastAgentMessageAt: now,
        firstResponseAt: sql`coalesce(${tickets.firstResponseAt}, ${Math.floor(now.getTime() / 1000)})`,
        status: sql`case when ${tickets.status} in ('new', 'closed', 'solved') then 'pending' else ${tickets.status} end`,
        updatedAt: now,
      })
      .where(eq(tickets.id, input.ticketId))
  } else if (input.authorType === 'requester') {
    await db
      .update(tickets)
      .set({
        lastRequesterMessageAt: now,
        // A requester writing on a ticket somebody had marked finished is reopening it. Leaving it
        // `solved` would hide a live conversation from every inbox filter the console has.
        status: sql`case when ${tickets.status} in ('solved', 'closed') then 'open' else ${tickets.status} end`,
        updatedAt: now,
      })
      .where(eq(tickets.id, input.ticketId))
  }

  return message
}

type ListFilters = {
  status?: TicketStatus
  priority?: TicketPriority
  assigneeEmail?: string
  unassigned?: boolean
  requesterEmail?: string
  labelId?: string
  search?: string
  limit?: number
  offset?: number
}

/**
 * The console's inbox query. Newest activity first, which is what an inbox means.
 *
 * The tie-break on `number` is not decoration. `updated_at` is `unixepoch()` — whole seconds — so
 * two tickets touched in the same second have no order between them, and a list without a total
 * order shuffles itself between two reads of the same page. `number` is monotonic and unique, so
 * adding it makes the ordering stable and also makes pagination safe: an unstable sort silently
 * drops and duplicates rows across an offset boundary.
 */
const listTickets = async (db: Database, filters: ListFilters): Promise<TicketRow[]> => {
  const conditions = [
    filters.status ? eq(tickets.status, filters.status) : undefined,
    filters.priority ? eq(tickets.priority, filters.priority) : undefined,
    filters.assigneeEmail ? eq(tickets.assigneeEmail, filters.assigneeEmail.toLowerCase()) : undefined,
    filters.unassigned ? sql`${tickets.assigneeEmail} is null` : undefined,
    filters.requesterEmail ? eq(tickets.requesterEmail, filters.requesterEmail.toLowerCase()) : undefined,
    filters.search
      ? or(
          like(tickets.subject, `%${filters.search}%`),
          like(tickets.requesterEmail, `%${filters.search}%`),
        )
      : undefined,
    filters.labelId
      ? sql`exists (select 1 from ${ticketLabels} where ${ticketLabels.ticketId} = ${tickets.id} and ${ticketLabels.labelId} = ${filters.labelId})`
      : undefined,
  ].filter(Boolean)

  return db
    .select()
    .from(tickets)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tickets.updatedAt), desc(tickets.number))
    .limit(filters.limit ?? PAGINATION.defaultLimit)
    .offset(filters.offset ?? 0)
}

/** Every label on a ticket, already localized. */
const listTicketLabels = async (db: Database, ticketId: string, locale: Locale): Promise<LabelRow[]> => {
  const rows = await db
    .select({ label: labels })
    .from(ticketLabels)
    .innerJoin(labels, eq(labels.id, ticketLabels.labelId))
    .where(eq(ticketLabels.ticketId, ticketId))
    .orderBy(asc(labels.position))
  return rows.map(({ label }) =>
    localize(label as never, parseTranslations(label.translations), locale, LABEL_TRANSLATABLE_FIELDS) as LabelRow,
  )
}

const listMessages = async (db: Database, ticketId: string): Promise<MessageRow[]> =>
  db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticketId)).orderBy(asc(ticketMessages.seq))

/** Agent replies the digest has not covered yet. The exact window the notification sweep sends. */
const listAgentRepliesAfter = async (db: Database, ticketId: string, afterSeq: number): Promise<MessageRow[]> =>
  db
    .select()
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, ticketId),
        gt(ticketMessages.seq, afterSeq),
        eq(ticketMessages.kind, 'reply'),
        eq(ticketMessages.authorType, 'agent'),
      ),
    )
    .orderBy(asc(ticketMessages.seq))

const listEvents = async (db: Database, ticketId: string): Promise<EventRow[]> =>
  db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId)).orderBy(asc(ticketEvents.createdAt))

const toIso = (value: Date | null) => (value ? value.toISOString() : null)

const toAttachments = (raw: string): AttachmentMeta[] => parseJson<AttachmentMeta[]>(raw, [])

/** A message as the support team sees it: everything, internal notes included. */
const toAgentMessage = (row: MessageRow) => ({
  id: row.id,
  seq: row.seq,
  kind: row.kind,
  author_type: row.authorType,
  author_email: row.authorEmail,
  author_name: row.authorName,
  body: row.bodyText,
  /** Present only when the message came in by email and something was trimmed off it. */
  has_quoted_text: row.bodyTextRaw !== null && row.bodyTextRaw !== row.bodyText,
  source: row.source,
  attachments: toAttachments(row.attachmentsMeta),
  edited_at: toIso(row.editedAt),
  created_at: toIso(row.createdAt),
})

/**
 * A message as the person who opened the ticket sees it.
 *
 * Two redactions, and they are the reason this function exists instead of a flag on the one above.
 * Internal notes are dropped by the caller before this is reached; what is dropped *here* is the
 * agent's own address — a requester needs to know somebody from support answered, not which
 * individual's mailbox to write to directly, and publishing staff addresses on every thread is how a
 * support queue gets bypassed.
 */
const toRequesterMessage = (row: MessageRow) => ({
  id: row.id,
  seq: row.seq,
  author_type: row.authorType,
  author_name: row.authorType === 'agent' ? (row.authorName ?? 'Support') : row.authorName,
  author_email: row.authorType === 'agent' ? null : row.authorEmail,
  body: row.bodyText,
  source: row.source,
  attachments: toAttachments(row.attachmentsMeta),
  edited_at: toIso(row.editedAt),
  created_at: toIso(row.createdAt),
})

const toEvent = (row: EventRow) => ({
  id: row.id,
  event: row.event,
  actor_type: row.actorType,
  actor_email: row.actorEmail,
  metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  created_at: toIso(row.createdAt),
})

const toParticipant = (row: ParticipantRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  notify_email: row.notifyEmail,
  created_at: toIso(row.createdAt),
})

const toLabel = (row: LabelRow) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  color: row.color,
})

/** The full record, for the console. */
const toAgentTicket = (row: TicketRow) => ({
  id: row.id,
  reference: formatReference(row.number),
  number: row.number,
  subject: row.subject,
  status: row.status,
  priority: row.priority,
  source: row.source,
  locale: row.locale,
  requester_email: row.requesterEmail,
  requester_name: row.requesterName,
  requester_user_id: row.requesterUserId,
  assignee_email: row.assigneeEmail,
  ai_summary: row.aiSummary,
  ai_enriched: row.aiEnriched,
  first_response_at: toIso(row.firstResponseAt),
  last_agent_message_at: toIso(row.lastAgentMessageAt),
  last_requester_message_at: toIso(row.lastRequesterMessageAt),
  solved_at: toIso(row.solvedAt),
  closed_at: toIso(row.closedAt),
  created_at: toIso(row.createdAt),
  updated_at: toIso(row.updatedAt),
})

/**
 * The same ticket as the requester sees it.
 *
 * Dropped: the assignee's address, the AI summary (it is the team's triage note about the person,
 * not a message to them), and every internal timestamp that only describes how the queue is being
 * worked. What is left is what somebody asked about and what has happened to it.
 */
const toRequesterTicket = (row: TicketRow) => ({
  reference: formatReference(row.number),
  subject: row.subject,
  status: row.status,
  priority: row.priority,
  locale: row.locale,
  requester_email: row.requesterEmail,
  requester_name: row.requesterName,
  created_at: toIso(row.createdAt),
  updated_at: toIso(row.updatedAt),
  solved_at: toIso(row.solvedAt),
  closed_at: toIso(row.closedAt),
})

/** Compact form for the inbox and for "my tickets". */
const toTicketSummary = (row: TicketRow) => ({
  id: row.id,
  reference: formatReference(row.number),
  subject: row.subject,
  status: row.status,
  priority: row.priority,
  requester_email: row.requesterEmail,
  assignee_email: row.assigneeEmail,
  updated_at: toIso(row.updatedAt),
})

/**
 * Messages and events, merged into the one list a thread view renders.
 *
 * They are separate tables because they are queried on different axes — the digest wants messages by
 * `seq`, the console wants activity by time — and merging them here rather than storing them
 * together is what keeps a timeline read from dragging every message body across for an event list.
 *
 * `internal` decides both which messages survive and how they are shaped, in one place. Every route
 * that returns a thread goes through this function; none of them re-implements the filter.
 */
const buildTimeline = (messages: MessageRow[], events: EventRow[], internal: boolean) => {
  const visible = internal ? messages : messages.filter((message) => message.kind === 'reply')

  const entries = [
    ...visible.map((message) => ({
      type: 'message' as const,
      at: message.createdAt?.getTime() ?? 0,
      seq: message.seq,
      data: internal ? toAgentMessage(message) : toRequesterMessage(message),
    })),
    ...events.map((event) => ({
      type: 'event' as const,
      at: event.createdAt?.getTime() ?? 0,
      seq: 0,
      data: toEvent(event),
    })),
  ]

  // Timestamps are whole seconds, so the tie-break on `seq` is what keeps a message and the event
  // announcing it from swapping places between two reads of the same thread.
  entries.sort((a, b) => a.at - b.at || a.seq - b.seq)
  return entries.map(({ type, data }) => ({ type, ...data }))
}

/** The link a requester follows. Only ever built at the moment a secret exists in memory. */
const ticketUrl = (env: Env, row: TicketRow, accessToken: string) =>
  buildTicketUrl(env.SUPPORT_TICKET_URL, formatReference(row.number), accessToken)

/** The address a reply to this ticket should come back to. */
const ticketReplyAddress = (env: Env, row: TicketRow) => buildReplyAddress(env.SUPPORT_REPLY_DOMAIN, row.replyKey)

export {
  addMessage,
  buildTimeline,
  createTicket,
  findParticipant,
  findTicketByAccessToken,
  findTicketById,
  findTicketByNumber,
  findTicketByReplyKey,
  listAgentRepliesAfter,
  listEvents,
  listMessages,
  listParticipants,
  listTicketLabels,
  listTickets,
  nextMessageSeq,
  nextTicketNumber,
  recordEvent,
  ticketReplyAddress,
  ticketUrl,
  toAgentMessage,
  toAgentTicket,
  toEvent,
  toLabel,
  toParticipant,
  toRequesterMessage,
  toRequesterTicket,
  toTicketSummary,
}
export type { AttachmentMeta, CreatedTicket, CreateTicketInput, EventRow, LabelRow, ListFilters, MessageRow, ParticipantRow, TicketRow }
