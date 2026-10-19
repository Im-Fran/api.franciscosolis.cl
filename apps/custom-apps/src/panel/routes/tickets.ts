import { and, asc, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, companies, contractCycles, contracts, installations, ticketMessages, tickets, workLogs } from '@/db/schema'
import type { AppEnv } from '@/env'
import { SUPPORT, TICKET_STATUSES } from '@/lib/config'
import { paginationQuery, searchQuery } from '@/lib/validation'
import { validate } from '@/lib/validate'
import { auditRow, getActorContext, recordAudit } from '@/services/audit'
import { toWorkLog } from '@/services/contracts'
import { toTicket, unreadBy, type TicketRow } from '@/services/tickets'
import { assertId, dataSchema, jsonContent, likeTerm, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * The support inbox: tickets opened from inside clients' apps, their conversations, and who hears
 * about them. Replies are read back by the app that opened the ticket; nothing here sends mail.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

/** `active` is shorthand for what still needs somebody: `open` and `pending`. */
const STATUS_FILTERS = [...TICKET_STATUSES, 'active'] as const

const ticketSelection = {
  ticket: tickets,
  appName: apps.name,
  companyName: sql<string>`COALESCE(NULLIF(${companies.tradeName}, ''), ${companies.legalName})`,
  installationName: sql<string | null>`COALESCE(NULLIF(${installations.alias}, ''), NULLIF(${installations.hostname}, ''), ${installations.deviceId})`,
  minutes: sql<number>`(SELECT COALESCE(SUM(w.minutes), 0) FROM work_logs w WHERE w.ticket_id = "tickets"."id")`,
}

const ticketQuery = (db: Database) =>
  db
    .select(ticketSelection)
    .from(tickets)
    .innerJoin(apps, eq(apps.id, tickets.appId))
    .innerJoin(companies, eq(companies.id, tickets.companyId))
    .leftJoin(installations, eq(installations.id, tickets.installationId))

type TicketSelection = { ticket: TicketRow; appName: string; companyName: string; installationName: string | null; minutes: number }

const serialize = (row: TicketSelection, unread: number, messages?: (typeof ticketMessages.$inferSelect)[]) =>
  toTicket(row.ticket, { appName: row.appName, companyName: row.companyName, installationName: row.installationName, unread, minutes: Number(row.minutes), messages })

const loadTicket = async (db: Database, id: string) => {
  const [row] = await ticketQuery(db).where(eq(tickets.id, id)).limit(1)
  if (!row) throw notFound('Ticket')
  return row
}

app.get(
  '/tickets',
  describeRoute({
    description:
      'The support inbox, most recently active first: each ticket with its app, client and device, whose turn it is (`last_message_by`), how many of the requester\'s messages nobody opened yet (`unread`) and the minutes logged against it. `status=active` lists what still needs somebody.',
    tags: ['Support'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The tickets', content: jsonContent(listSchema(looseSchema)) }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      status: v.optional(v.picklist(STATUS_FILTERS)),
      app_id: v.optional(v.pipe(v.string(), v.uuid())),
      company_id: v.optional(v.pipe(v.string(), v.uuid())),
      installation_id: v.optional(v.pipe(v.string(), v.uuid())),
      search: searchQuery,
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const conditions: SQL[] = []
    if (query.status === 'active') conditions.push(inArray(tickets.status, ['open', 'pending']))
    else if (query.status) conditions.push(eq(tickets.status, query.status))
    if (query.app_id) conditions.push(eq(tickets.appId, query.app_id))
    if (query.company_id) conditions.push(eq(tickets.companyId, query.company_id))
    if (query.installation_id) conditions.push(eq(tickets.installationId, query.installation_id))
    if (query.search) {
      const term = likeTerm(query.search)
      const number = Number(query.search.replace(/^#/, ''))
      conditions.push(
        or(
          like(tickets.subject, term),
          like(tickets.requesterName, term),
          like(tickets.requesterEmail, term),
          ...(Number.isInteger(number) && number > 0 ? [eq(tickets.number, number)] : []),
        )!,
      )
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined
    const [rows, [total]] = await Promise.all([
      ticketQuery(db).where(where).orderBy(desc(tickets.lastMessageAt), desc(tickets.number)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(tickets).where(where),
    ])
    const unread = await unreadBy(db, rows.map((row) => row.ticket.id), 'requester')
    return c.json({ code: 200 as const, data: rows.map((row) => serialize(row, unread.get(row.ticket.id) ?? 0)), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

app.get(
  '/tickets/:ticketId',
  describeRoute({
    description: "One ticket: the whole conversation, the device's context when it was opened, and the work logged against it. Opening it marks the requester's messages as read.",
    tags: ['Support'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The ticket', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('ticketId'), 'Ticket')
    const db = getDb(c.env)
    const row = await loadTicket(db, id)
    await db.update(ticketMessages).set({ seenAt: new Date() }).where(and(eq(ticketMessages.ticketId, id), eq(ticketMessages.author, 'requester'), isNull(ticketMessages.seenAt)))
    const [messageRows, logs] = await Promise.all([
      db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id)).orderBy(asc(ticketMessages.createdAt), sql`rowid`),
      db
        .select({ log: workLogs, appName: apps.name, contractName: contracts.name, cycleStatus: contractCycles.status })
        .from(workLogs)
        .leftJoin(apps, eq(apps.id, workLogs.appId))
        .leftJoin(contracts, eq(contracts.id, workLogs.contractId))
        .leftJoin(contractCycles, eq(contractCycles.id, workLogs.cycleId))
        .where(eq(workLogs.ticketId, id))
        .orderBy(desc(workLogs.occurredOn), desc(workLogs.createdAt)),
    ])
    return c.json({
      code: 200 as const,
      data: {
        ...serialize(row, 0, messageRows),
        // The same shape the work log routes answer, so the panel can render and edit them alike.
        work_logs: logs.map((entry) => toWorkLog(entry.log, { ...entry, companyName: row.companyName, ticketNumber: row.ticket.number })),
      },
    })
  },
)

const replyStatuses = ['pending', 'resolved', 'closed'] as const

app.post(
  '/tickets/:ticketId/replies',
  describeRoute({
    description:
      "Answers a ticket. The app that opened it reads the answer on its next `GET /tickets/{id}` — `sync.support_unread` in its heartbeat tells it there is one. The ticket becomes `pending` (waiting on the requester) unless `status` says `resolved` or `closed`.",
    tags: ['Support'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Answered', content: jsonContent(dataSchema(looseSchema, 201)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', v.object({ message: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SUPPORT.maxMessageLength)), status: v.optional(v.picklist(replyStatuses), 'pending') })),
  async (c) => {
    const id = assertId(c.req.param('ticketId'), 'Ticket')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const admin = c.get('admin')
    const db = getDb(c.env)
    const before = await loadTicket(db, id)
    const now = new Date()
    const finished = body.status === 'resolved' || body.status === 'closed'
    await db.batch([
      // Answering is reading: whatever the requester wrote before the reply is no longer unread.
      db.update(ticketMessages).set({ seenAt: now }).where(and(eq(ticketMessages.ticketId, id), eq(ticketMessages.author, 'requester'), isNull(ticketMessages.seenAt))),
      db.insert(ticketMessages).values({ id: crypto.randomUUID(), ticketId: id, author: 'staff', authorName: admin.name, authorEmail: admin.email, body: body.message, createdAt: now }),
      db
        .update(tickets)
        .set({ status: body.status, lastMessageAt: now, lastMessageBy: 'staff', resolvedAt: finished ? now : null, resolvedBy: finished ? actor.actorEmail : null, updatedAt: now })
        .where(eq(tickets.id, id)),
      db.insert(auditLogs).values(auditRow({ event: 'ticket.replied', resourceType: 'ticket', resourceId: id, ...actor, metadata: { number: before.ticket.number, before: { status: before.ticket.status }, after: { status: body.status } } })),
    ])
    const after = await loadTicket(db, id)
    const messageRows = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id)).orderBy(asc(ticketMessages.createdAt), sql`rowid`)
    return c.json({ code: 201 as const, data: serialize(after, 0, messageRows) }, 201)
  },
)

app.patch(
  '/tickets/:ticketId',
  describeRoute({
    description: 'Changes a ticket\'s status or subject without writing to the requester. Resolving or closing records who did it; reopening clears it.',
    tags: ['Support'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', v.object({ status: v.optional(v.picklist(TICKET_STATUSES)), subject: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SUPPORT.maxSubjectLength))) })),
  async (c) => {
    const id = assertId(c.req.param('ticketId'), 'Ticket')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadTicket(db, id)
    const now = new Date()
    const finished = body.status === 'resolved' || body.status === 'closed'
    await db
      .update(tickets)
      .set({
        ...(body.subject !== undefined && { subject: body.subject }),
        ...(body.status !== undefined && { status: body.status, resolvedAt: finished ? now : null, resolvedBy: finished ? actor.actorEmail : null }),
        updatedAt: now,
      })
      .where(eq(tickets.id, id))
    if (body.status !== undefined && body.status !== before.ticket.status) {
      await recordAudit(db, { event: 'ticket.status_changed', resourceType: 'ticket', resourceId: id, ...actor, metadata: { number: before.ticket.number, before: { status: before.ticket.status }, after: { status: body.status } } })
    }
    return c.json({ code: 200 as const, data: serialize(await loadTicket(db, id), 0) })
  },
)

app.post(
  '/apps/:appId/support/assignee',
  describeRoute({
    description: "Takes over an app's support tickets: the caller's account is told about every new ticket and every message the requester adds, in the website's bell.",
    tags: ['Support'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Assigned' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const [before] = await db.select({ email: apps.supportAssigneeEmail }).from(apps).where(eq(apps.id, id)).limit(1)
    if (!before) throw notFound('App')
    await db.update(apps).set({ supportAssigneeId: actor.actorId, supportAssigneeEmail: actor.actorEmail, updatedAt: new Date(), updatedBy: actor.actorEmail }).where(eq(apps.id, id))
    await recordAudit(db, { event: 'app.updated', resourceType: 'app', resourceId: id, ...actor, metadata: { before: { support_assignee_email: before.email }, after: { support_assignee_email: actor.actorEmail } } })
    return c.json({ code: 200 as const, data: { app_id: id, support_assignee_email: actor.actorEmail } })
  },
)

/** For the work log: a ticket must belong to the company the entry is filed under. */
const assertTicketOfCompany = async (db: Database, ticketId: string, companyId: string) => {
  const [row] = await db.select({ companyId: tickets.companyId, number: tickets.number }).from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  if (!row || row.companyId !== companyId) throw new HTTPException(422, { message: 'ticket_id must be a ticket of the same company' })
  return row
}

export { assertTicketOfCompany }
export default app
