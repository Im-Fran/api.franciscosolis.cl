import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { labels, ticketLabels, ticketParticipants, tickets } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, MESSAGE_KIND, PAGINATION, PARTICIPANT_TAG, TICKET_PRIORITY, TICKET_STATUS } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { LOCALES } from '@/lib/locales'
import { parseReference } from '@/lib/references'
import { emailAddress, optionalEmail, paginationSchema, requiredText } from '@/lib/validation'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { sendParticipantAdded } from '@/services/email'
import { scheduleReplyNotifications } from '@/services/notifications'
import { notifyParticipantAdded, notifyTicketReply } from '@/services/notify'
import {
  addMessage,
  buildTimeline,
  findTicketById,
  listEvents,
  listMessages,
  listParticipants,
  listTicketLabels,
  listTickets,
  recordEvent,
  toAgentTicket,
  toLabel,
  toParticipant,
  toTicketSummary,
} from '@/services/tickets'
import type { TicketRow } from '@/services/tickets'

const app = new Hono<AppEnv>()

const ticketSchema = v.looseObject({ id: v.string(), reference: v.string(), subject: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(ticketSchema) })
const oneResponseSchema = v.object({ code: v.literal(200), data: ticketSchema })
const timelineResponseSchema = v.object({ code: v.literal(200), data: v.array(v.looseObject({ type: v.string() })) })

/** Loads `:id`, 404-ing on anything unknown. Also accepts a reference, because people paste those. */
const requireTicket = async (c: { env: AppEnv['Bindings']; req: { param: (k: string) => string | undefined } }) => {
  const id = c.req.param('id') ?? ''
  const db = getDb(c.env)

  // An id is a UUID and a reference is `FS-1042` or `1042`; they cannot be confused for each other,
  // so accepting both costs nothing and saves the console a lookup every time somebody pastes a
  // reference out of an email into the address bar.
  const number = parseReference(id)
  const ticket =
    number !== null
      ? ((await db.select().from(tickets).where(eq(tickets.number, number)).limit(1))[0] ?? null)
      : await findTicketById(db, id)

  if (!ticket) {
    throw new HTTPException(404, { message: 'Ticket not found' })
  }
  return ticket
}

const listQuerySchema = v.object({
  status: v.optional(v.picklist(TICKET_STATUS)),
  priority: v.optional(v.picklist(TICKET_PRIORITY)),
  assignee: v.optional(emailAddress),
  unassigned: v.optional(v.picklist(['true', 'false'])),
  requester: v.optional(emailAddress),
  label: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  ...paginationSchema.entries,
})

app.get(
  '/tickets',
  describeRoute({
    description:
      'The inbox: every ticket, filterable, most recently active first. `unassigned=true` is the queue nobody has picked up.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Tickets', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the support console' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const query = c.req.valid('query')
    const db = getDb(c.env)

    // A label is filtered by slug in the API, because that is what a saved filter and a console URL
    // can hold; the query underneath needs the id.
    let labelId: string | undefined
    if (query.label) {
      const [row] = await db.select({ id: labels.id }).from(labels).where(eq(labels.slug, query.label)).limit(1)
      if (!row) {
        return c.json({ code: 200, data: [] })
      }
      labelId = row.id
    }

    const rows = await listTickets(db, {
      status: query.status,
      priority: query.priority,
      assigneeEmail: query.assignee,
      unassigned: query.unassigned === 'true',
      requesterEmail: query.requester,
      labelId,
      search: query.q,
      limit: query.limit ?? PAGINATION.defaultLimit,
      offset: query.offset ?? 0,
    })

    return c.json({ code: 200, data: rows.map(toTicketSummary) })
  },
)

app.get(
  '/tickets/:id',
  describeRoute({
    description: 'One ticket in full, with its labels and everybody on it. Accepts an id or a reference.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The ticket', content: { 'application/json': { schema: resolver(oneResponseSchema) } } },
      404: { description: 'No such ticket' },
    },
  }),
  async (c) => {
    const ticket = await requireTicket(c)
    const db = getDb(c.env)
    const [participants, ticketLabelRows] = await Promise.all([
      listParticipants(db, ticket.id),
      listTicketLabels(db, ticket.id, ticket.locale as never),
    ])

    return c.json({
      code: 200,
      data: {
        ...toAgentTicket(ticket),
        labels: ticketLabelRows.map(toLabel),
        participants: participants.map(toParticipant),
      },
    })
  },
)

app.get(
  '/tickets/:id/timeline',
  describeRoute({
    description: 'The whole thread, internal notes included. This is the only route that returns them.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The thread', content: { 'application/json': { schema: resolver(timelineResponseSchema) } } },
      404: { description: 'No such ticket' },
    },
  }),
  async (c) => {
    const ticket = await requireTicket(c)
    const db = getDb(c.env)
    const [messages, events] = await Promise.all([listMessages(db, ticket.id), listEvents(db, ticket.id)])
    return c.json({ code: 200, data: buildTimeline(messages, events, true) })
  },
)

const patchSchema = v.object({
  subject: v.optional(requiredText(BODY_LIMITS.subject)),
  status: v.optional(v.picklist(TICKET_STATUS)),
  priority: v.optional(v.picklist(TICKET_PRIORITY)),
  locale: v.optional(v.picklist(LOCALES)),
  requester_name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
})

app.patch(
  '/tickets/:id',
  describeRoute({
    description:
      'Edits the ticket itself: its subject, where it is in the queue, how urgent it is, and which language it is being answered in. Every change lands on the timeline.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Ticket updated', content: { 'application/json': { schema: resolver(oneResponseSchema) } } },
      404: { description: 'No such ticket' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const ticket = await requireTicket(c)
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')
    const now = new Date()

    const status = body.status ?? (ticket.status as (typeof TICKET_STATUS)[number])
    await db
      .update(tickets)
      .set({
        subject: body.subject ?? ticket.subject,
        status,
        priority: body.priority ?? ticket.priority,
        locale: body.locale ?? ticket.locale,
        requesterName: body.requester_name === undefined ? ticket.requesterName : body.requester_name,
        // Stamped when the ticket first reaches each terminal state and then left alone: they record
        // when the thing happened, not when somebody last toggled a dropdown.
        solvedAt: status === 'solved' ? (ticket.solvedAt ?? now) : ticket.solvedAt,
        closedAt: status === 'closed' ? (ticket.closedAt ?? now) : ticket.closedAt,
        updatedBy: agent.email,
        updatedAt: now,
      })
      .where(eq(tickets.id, ticket.id))

    const changes: Array<Promise<unknown>> = []
    if (body.subject && body.subject !== ticket.subject) {
      changes.push(
        recordEvent(db, {
          ticketId: ticket.id,
          event: 'subject_changed',
          actorType: 'agent',
          actorEmail: agent.email,
          metadata: { from: ticket.subject, to: body.subject },
        }),
      )
    }
    if (body.status && body.status !== ticket.status) {
      changes.push(
        recordEvent(db, {
          ticketId: ticket.id,
          event: 'status_changed',
          actorType: 'agent',
          actorEmail: agent.email,
          metadata: { from: ticket.status, to: body.status },
        }),
      )
    }
    if (body.priority && body.priority !== ticket.priority) {
      changes.push(
        recordEvent(db, {
          ticketId: ticket.id,
          event: 'priority_changed',
          actorType: 'agent',
          actorEmail: agent.email,
          metadata: { from: ticket.priority, to: body.priority },
        }),
      )
    }
    await Promise.all(changes)

    await recordAudit(db, {
      event: 'ticket.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'tickets',
      resourceId: ticket.id,
      metadata: { status: body.status ?? null, priority: body.priority ?? null },
    })

    const updated = await findTicketById(db, ticket.id)
    return c.json({ code: 200, data: toAgentTicket(updated as TicketRow) })
  },
)

app.delete(
  '/tickets/:id',
  describeRoute({
    description:
      'Deletes a ticket and everything hanging off it. Audited, and not reversible — the ordinary way to finish with a ticket is to close it.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Ticket deleted' },
      404: { description: 'No such ticket' },
    },
  }),
  async (c) => {
    const ticket = await requireTicket(c)
    const db = getDb(c.env)
    await db.delete(tickets).where(eq(tickets.id, ticket.id))
    await recordAudit(db, {
      event: 'ticket.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'tickets',
      resourceId: ticket.id,
      metadata: { number: ticket.number },
    })
    return c.body(null, 204)
  },
)

const messageSchema = v.object({
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(BODY_LIMITS.message)),
  kind: v.optional(v.picklist(MESSAGE_KIND)),
})

app.post(
  '/tickets/:id/messages',
  describeRoute({
    description:
      'Posts a reply or an internal note. A `reply` is part of the conversation and schedules the deferred email notice; a `note` never leaves the support team and schedules nothing.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Message posted' },
      404: { description: 'No such ticket' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', messageSchema),
  async (c) => {
    const ticket = await requireTicket(c)
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')
    const kind = body.kind ?? 'reply'

    const message = await addMessage(db, {
      ticketId: ticket.id,
      kind,
      authorType: 'agent',
      authorEmail: agent.email,
      authorName: agent.name,
      authorUserId: agent.id,
      bodyText: body.body,
      source: 'web',
    })

    if (kind === 'reply') {
      // A public reply starts the clock; an internal note is the team talking to itself and starts
      // nothing. Scheduling here rather than inside `addMessage` keeps the rule where it is legible:
      // the thing that decides whether somebody gets an email is the route that decided the message
      // was public.
      await scheduleReplyNotifications(db, ticket, agent.email)
      // The bell on the website, beside the email rather than instead of it. See `services/notify.ts`.
      await notifyTicketReply(c.env, ticket, { email: agent.email, name: agent.name, userId: agent.id })
    }

    await recordAudit(db, {
      event: 'message.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'ticket_messages',
      resourceId: message.id,
      metadata: { ticket_id: ticket.id, kind },
    })

    return c.json({ code: 201, data: { id: message.id, seq: message.seq, kind } }, 201)
  },
)

const assigneeSchema = v.object({ email: v.nullable(emailAddress) })

app.put(
  '/tickets/:id/assignee',
  describeRoute({
    description: 'Assigns the ticket to somebody, or clears the assignment with a null email.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Assignment updated' },
      404: { description: 'No such ticket' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', assigneeSchema),
  async (c) => {
    const ticket = await requireTicket(c)
    const { email } = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')

    await db
      .update(tickets)
      .set({
        assigneeEmail: email,
        assigneeUserId: null,
        // Picking a ticket up is what takes it out of the untouched pile.
        status: ticket.status === 'new' && email ? 'open' : ticket.status,
        updatedBy: agent.email,
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, ticket.id))

    if (email) {
      // The assignee becomes a participant so the console can show it on their list, but with
      // `notifyEmail` off: agents work the queue in the console and do not want a mailbox copy of
      // every thread they are on.
      await db
        .insert(ticketParticipants)
        .values({
          id: crypto.randomUUID(),
          ticketId: ticket.id,
          email,
          role: 'agent',
          notifyEmail: false,
          addedBy: agent.email,
        })
        .onConflictDoNothing({ target: [ticketParticipants.ticketId, ticketParticipants.email] })
    }

    await recordEvent(db, {
      ticketId: ticket.id,
      event: email ? 'assigned' : 'unassigned',
      actorType: 'agent',
      actorEmail: agent.email,
      metadata: { to: email },
    })
    await recordAudit(db, {
      event: 'ticket.assigned',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'tickets',
      resourceId: ticket.id,
      metadata: { assignee: email },
    })

    return c.json({ code: 200, data: { assignee_email: email } })
  },
)

const participantSchema = v.object({
  email: emailAddress,
  name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  tag: v.optional(v.nullable(v.picklist(PARTICIPANT_TAG))),
})

app.post(
  '/tickets/:id/participants',
  describeRoute({
    description:
      'Puts another person on the ticket so they see the thread and hear about replies. They are emailed a link of their own rather than back-filled into the next digest.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Participant added' },
      404: { description: 'No such ticket' },
      409: { description: 'That address is already on the ticket' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', participantSchema),
  async (c) => {
    const ticket = await requireTicket(c)
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')

    const row = {
      id: crypto.randomUUID(),
      ticketId: ticket.id,
      email: body.email,
      name: body.name ?? null,
      role: 'cc' as const,
      tag: body.tag ?? null,
      notifyEmail: true,
      // Starts at the current head, so being added mid-thread does not mail somebody a conversation
      // they were not part of when it happened. They get a "you were added" note with the link instead.
      lastNotifiedSeq: ticket.lastMessageSeq,
      addedBy: agent.email,
    }

    try {
      await db.insert(ticketParticipants).values(row)
    } catch (error) {
      throw asConflict(error, `${body.email} is already on this ticket`)
    }

    // Their own note with the link, rather than being back-filled into the next digest — that would
    // mail a stranger a conversation they were not part of when it happened. Awaited so the 201 is
    // not ahead of the thing it reports.
    await sendParticipantAdded(db, c.env, ticket, body.email)
    // Only reaches anybody whose address this Worker has seen signed in; see `resolveUserIdByEmail`.
    await notifyParticipantAdded(db, c.env, ticket, body.email)

    await recordEvent(db, {
      ticketId: ticket.id,
      event: 'participant_added',
      actorType: 'agent',
      actorEmail: agent.email,
      metadata: { email: body.email },
    })
    await recordAudit(db, {
      event: 'participant.added',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'ticket_participants',
      resourceId: row.id,
      metadata: { ticket_id: ticket.id, email: body.email },
    })

    return c.json({ code: 201, data: { id: row.id, email: row.email, role: row.role, tag: row.tag } }, 201)
  },
)

const participantTagSchema = v.object({ tag: v.nullable(v.picklist(PARTICIPANT_TAG)) })

app.patch(
  '/tickets/:id/participants/:participantId',
  describeRoute({
    description:
      "Sets or clears a participant's internal-only tag (`guest` or `interest`). Never sent to the requester's own view of the ticket.",
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Tag updated' },
      404: { description: 'No such ticket or participant' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', participantTagSchema),
  async (c) => {
    const ticket = await requireTicket(c)
    const { tag } = c.req.valid('json')
    const db = getDb(c.env)
    const [row] = await db
      .select()
      .from(ticketParticipants)
      .where(
        and(
          eq(ticketParticipants.ticketId, ticket.id),
          eq(ticketParticipants.id, c.req.param('participantId') ?? ''),
        ),
      )
      .limit(1)

    if (!row) {
      throw new HTTPException(404, { message: 'Participant not found' })
    }

    await db.update(ticketParticipants).set({ tag }).where(eq(ticketParticipants.id, row.id))

    await recordAudit(db, {
      event: 'participant.tagged',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'ticket_participants',
      resourceId: row.id,
      metadata: { ticket_id: ticket.id, email: row.email, tag },
    })

    return c.json({ code: 200, data: { id: row.id, tag } })
  },
)

app.delete(
  '/tickets/:id/participants/:participantId',
  describeRoute({
    description: 'Takes somebody off the ticket. The person who opened it cannot be removed.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Participant removed' },
      404: { description: 'No such ticket or participant' },
      409: { description: 'The requester cannot be removed from their own ticket' },
    },
  }),
  async (c) => {
    const ticket = await requireTicket(c)
    const db = getDb(c.env)
    const [row] = await db
      .select()
      .from(ticketParticipants)
      .where(
        and(
          eq(ticketParticipants.ticketId, ticket.id),
          eq(ticketParticipants.id, c.req.param('participantId') ?? ''),
        ),
      )
      .limit(1)

    if (!row) {
      throw new HTTPException(404, { message: 'Participant not found' })
    }
    if (row.role === 'requester') {
      throw new HTTPException(409, { message: 'The requester cannot be removed from their own ticket' })
    }

    await db.delete(ticketParticipants).where(eq(ticketParticipants.id, row.id))
    await recordEvent(db, {
      ticketId: ticket.id,
      event: 'participant_removed',
      actorType: 'agent',
      actorEmail: c.get('agent').email,
      metadata: { email: row.email },
    })
    await recordAudit(db, {
      event: 'participant.removed',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'ticket_participants',
      resourceId: row.id,
      metadata: { ticket_id: ticket.id, email: row.email },
    })

    return c.body(null, 204)
  },
)

app.post(
  '/tickets/:id/labels/:labelId',
  describeRoute({
    description: 'Puts a label on a ticket. Idempotent.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Label applied' },
      404: { description: 'No such ticket or label' },
    },
  }),
  async (c) => {
    const ticket = await requireTicket(c)
    const db = getDb(c.env)
    const labelId = c.req.param('labelId') ?? ''
    const [label] = await db.select().from(labels).where(eq(labels.id, labelId)).limit(1)
    if (!label) {
      throw new HTTPException(404, { message: 'Label not found' })
    }

    await db
      .insert(ticketLabels)
      .values({ ticketId: ticket.id, labelId, addedBy: c.get('agent').email })
      .onConflictDoNothing()

    await recordEvent(db, {
      ticketId: ticket.id,
      event: 'label_added',
      actorType: 'agent',
      actorEmail: c.get('agent').email,
      metadata: { slug: label.slug },
    })

    return c.body(null, 204)
  },
)

app.delete(
  '/tickets/:id/labels/:labelId',
  describeRoute({
    description: 'Takes a label off a ticket. Idempotent.',
    tags: ['Admin · Tickets'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Label removed' },
      404: { description: 'No such ticket' },
    },
  }),
  async (c) => {
    const ticket = await requireTicket(c)
    const db = getDb(c.env)
    const labelId = c.req.param('labelId') ?? ''

    await db.delete(ticketLabels).where(and(eq(ticketLabels.ticketId, ticket.id), eq(ticketLabels.labelId, labelId)))
    await recordEvent(db, {
      ticketId: ticket.id,
      event: 'label_removed',
      actorType: 'agent',
      actorEmail: c.get('agent').email,
      metadata: { label_id: labelId },
    })

    return c.body(null, 204)
  },
)

export default app
