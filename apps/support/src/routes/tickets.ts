import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, TICKET_CREATION } from '@/lib/config'
import { LOCALES } from '@/lib/locales'
import { formatReference } from '@/lib/references'
import { emailAddress, requiredText } from '@/lib/validation'
import { requireTicketAccess } from '@/middleware/ticket-access'
import { getRequestContext, recordAudit } from '@/services/audit'
import { retryAfterSeconds, ticketsFromEmail, ticketsFromIp } from '@/services/rate-limit'
import {
  addMessage,
  buildTimeline,
  createTicket,
  listEvents,
  listMessages,
  listParticipants,
  listTicketLabels,
  recordEvent,
  ticketUrl,
  toLabel,
  toParticipant,
  toRequesterTicket,
} from '@/services/tickets'

const app = new Hono<AppEnv>()

const createSchema = v.object({
  subject: requiredText(BODY_LIMITS.subject),
  body: v.pipe(v.string(), v.trim(), v.minLength(TICKET_CREATION.minBodyLength), v.maxLength(BODY_LIMITS.message)),
  email: emailAddress,
  name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  locale: v.optional(v.picklist(LOCALES)),
  cc: v.optional(v.pipe(v.array(emailAddress), v.maxLength(10))),
  /**
   * A field no human ever fills in. Bots fill in every input they find, so a non-empty value here is
   * the cheapest possible signal — and it is answered with a normal-looking 201 carrying a reference
   * that was never created, because telling a bot it was detected only teaches it to stop filling it in.
   */
  website: v.optional(v.string()),
})

const createdResponseSchema = v.object({
  code: v.literal(201),
  data: v.object({
    reference: v.string(),
    status: v.string(),
    /** The link, secret and all. Returned once, here, because the person is standing in front of it. */
    url: v.string(),
  }),
})

const ticketResponseSchema = v.object({ code: v.literal(200), data: v.looseObject({ reference: v.string() }) })
const timelineResponseSchema = v.object({ code: v.literal(200), data: v.array(v.looseObject({ type: v.string() })) })

app.post(
  '/tickets',
  describeRoute({
    description:
      'Opens a support ticket. Public and unauthenticated: anybody with an email address can ask for help. The response carries the only copy of the ticket link — the same link is emailed to the address given.',
    tags: ['Tickets'],
    responses: {
      201: { description: 'Ticket opened', content: { 'application/json': { schema: resolver(createdResponseSchema) } } },
      400: { description: 'The body failed validation' },
      429: { description: 'Too many tickets from this address or address block' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const now = new Date()
    const { ip, userAgent } = getRequestContext(c)

    if (body.website !== undefined && body.website.trim().length > 0) {
      // Answered as if it worked. See the note on the field above.
      return c.json({ code: 201, data: { reference: formatReference(0), status: 'new', url: '' } }, 201)
    }

    const [fromIp, fromEmail] = await Promise.all([
      ip ? ticketsFromIp(db, ip, now) : Promise.resolve(0),
      ticketsFromEmail(db, body.email, now),
    ])
    if (fromIp >= TICKET_CREATION.hourlyLimitPerIp || fromEmail >= TICKET_CREATION.hourlyLimitPerEmail) {
      // Answered rather than dropped: a person who genuinely opened three tickets deserves to know
      // why the fourth did not go through, and `Retry-After` tells them when to come back.
      c.header('Retry-After', String(retryAfterSeconds(now)))
      throw new HTTPException(429, { message: 'Too many tickets opened recently. Try again shortly.' })
    }

    const { ticket, accessToken } = await createTicket(db, c.env, {
      subject: body.subject,
      bodyText: body.body,
      requesterEmail: body.email,
      requesterName: body.name ?? null,
      locale: body.locale,
      source: 'web',
      ccEmails: body.cc,
    })

    await recordAudit(db, {
      event: 'ticket.created',
      actorEmail: ticket.requesterEmail,
      resourceType: 'tickets',
      resourceId: ticket.id,
      ip,
      userAgent,
      metadata: { source: 'web', reference: formatReference(ticket.number) },
    })

    return c.json(
      {
        code: 201,
        data: {
          reference: formatReference(ticket.number),
          status: ticket.status,
          url: ticketUrl(c.env, ticket, accessToken),
        },
      },
      201,
    )
  },
)

// Everything below is scoped to one ticket and goes through the same gate. Note that no literal
// segment lives under `/tickets/` — `/tickets/resend-link` and friends would have to be registered
// *before* this parametric route, and keeping them out entirely avoids the ordering trap.
app.use('/tickets/:reference/*', requireTicketAccess)
app.use('/tickets/:reference', requireTicketAccess)

app.get(
  '/tickets/:reference',
  describeRoute({
    description:
      'One ticket, for the person who opened it or anybody on copy. Reached with the secret from the emailed link, or with an access token whose verified email is on the ticket.',
    tags: ['Tickets'],
    responses: {
      200: { description: 'The ticket', content: { 'application/json': { schema: resolver(ticketResponseSchema) } } },
      404: { description: 'No such ticket, or the caller is not entitled to it' },
    },
  }),
  async (c) => {
    const { ticket, level } = c.get('ticketAccess')
    const db = getDb(c.env)
    const [participants, ticketLabelRows] = await Promise.all([
      listParticipants(db, ticket.id),
      listTicketLabels(db, ticket.id, ticket.locale as never),
    ])

    return c.json({
      code: 200,
      data: {
        ...toRequesterTicket(ticket),
        access_level: level,
        labels: ticketLabelRows.map(toLabel),
        participants: participants.filter((row) => row.role !== 'agent').map(toParticipant),
      },
    })
  },
)

app.get(
  '/tickets/:reference/timeline',
  describeRoute({
    description:
      'The conversation: every reply, plus the status changes around them. Internal notes are never included here, whoever is asking.',
    tags: ['Tickets'],
    responses: {
      200: { description: 'The thread', content: { 'application/json': { schema: resolver(timelineResponseSchema) } } },
      404: { description: 'No such ticket, or the caller is not entitled to it' },
    },
  }),
  async (c) => {
    const { ticket } = c.get('ticketAccess')
    const db = getDb(c.env)
    const [messages, events] = await Promise.all([listMessages(db, ticket.id), listEvents(db, ticket.id)])
    // `internal: false` unconditionally. This route answers the requester's view of their own
    // thread, and an agent reading it here gets the same redaction — the console reads
    // `/admin/tickets/:id/timeline` when it wants the notes.
    return c.json({ code: 200, data: buildTimeline(messages, events, false) })
  },
)

const replySchema = v.object({
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(BODY_LIMITS.message)),
})

app.post(
  '/tickets/:reference/messages',
  describeRoute({
    description:
      'Adds a reply to the thread. Posting cancels any deferred notification still waiting to be sent to this author — they are evidently reading it.',
    tags: ['Tickets'],
    responses: {
      201: { description: 'Reply posted' },
      404: { description: 'No such ticket, or the caller is not entitled to it' },
      409: { description: 'The ticket is closed' },
      400: { description: 'The body failed validation' },
    },
  }),
  validator('json', replySchema),
  async (c) => {
    const { ticket, level, actorEmail, actorName, actorUserId } = c.get('ticketAccess')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    if (ticket.status === 'spam') {
      // Indistinguishable from a ticket that does not exist, on purpose.
      throw new HTTPException(404, { message: 'Ticket not found' })
    }

    const message = await addMessage(db, {
      ticketId: ticket.id,
      kind: 'reply',
      authorType: level === 'agent' ? 'agent' : 'requester',
      authorEmail: actorEmail,
      authorName: actorName,
      authorUserId: actorUserId,
      bodyText: body.body,
      source: 'web',
    })

    await recordEvent(db, {
      ticketId: ticket.id,
      event: ticket.status === 'solved' || ticket.status === 'closed' ? 'reopened' : 'status_changed',
      actorType: level === 'agent' ? 'agent' : 'requester',
      actorEmail,
      metadata: { seq: message.seq },
    })

    return c.json({ code: 201, data: { seq: message.seq, created_at: message.createdAt?.toISOString() ?? null } }, 201)
  },
)

export default app
