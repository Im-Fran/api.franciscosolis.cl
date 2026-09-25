import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { ticketParticipants, tickets } from '@/db/schema'
import type { Env } from '@/env'
import { formatReference } from '@/lib/references'
import type { TicketRow } from '@/services/tickets'

/**
 * Publishing an event for `apps/notifications`, which turns it into an in-site notification and a
 * push on the website.
 *
 * **It never emails anything on this Worker's behalf, and that is what makes it additive.** Every
 * mail this Worker sends — the receipt, the thirty-minute digest, "you were added" — keeps being sent
 * from here, exactly as before; the notifications Worker knows both support types as not emailable,
 * so the account holder reads the reply once in their inbox and sees it once in the bell, and never
 * gets it twice. Nothing in `services/email.ts` or `services/notifications.ts` changed for this.
 *
 * The message shape is a contract between two Workers that deploy independently, so it is written
 * down twice on purpose: here, as what this Worker promises to send, and in `apps/notifications`, as
 * what it accepts. Only the types this Worker produces are listed.
 */
type NotificationType = 'support.ticket_reply' | 'support.participant_added'

type NotificationData = Record<string, string | number | boolean | null>

type NotificationEvent = {
  version: 1
  /** Idempotency key, minted here once so a redelivered message is a no-op on the consumer. */
  id: string
  type: NotificationType
  /** The account the notification is for. `id` is the auth `sub`. */
  user: { id: string; email?: string | null; name?: string | null; locale?: string | null }
  /** ISO 8601. */
  occurred_at: string
  data: NotificationData
  /** A path on the website, starting with `/`, or null. */
  url?: string | null
}

type NotificationInput = {
  type: NotificationType
  user: NotificationEvent['user']
  data?: NotificationData
  url?: string | null
  occurredAt?: Date
}

const buildNotificationEvent = (input: NotificationInput): NotificationEvent => ({
  version: 1,
  id: crypto.randomUUID(),
  type: input.type,
  user: input.user,
  occurred_at: (input.occurredAt ?? new Date()).toISOString(),
  data: input.data ?? {},
  url: input.url ?? null,
})

/**
 * Queues one event, and never throws.
 *
 * Every caller has already written the reply or the participant, and has already sent — or
 * scheduled — the email that is the real notice. A queue that is down must cost the bell, not the
 * request: the answer says whether the event was accepted and nobody here needs to act on it.
 *
 * An event for nobody is refused here: the consumer keys every row by `user.id`, and this Worker
 * only learns one when a token arrives on a request (see `requesterUserId` in `db/schema.ts`).
 */
const publishNotification = async (env: Env, input: NotificationInput): Promise<boolean> => {
  if (!input.user.id) {
    return false
  }
  try {
    await env.NOTIFICATIONS_QUEUE.send(buildNotificationEvent(input), { contentType: 'json' })
    return true
  } catch (error) {
    console.error('failed to publish a notification', input.type, error)
    return false
  }
}

/** The ticket's page on the website. No secret on it: the bell is for a signed-in account. */
const ticketPath = (ticket: TicketRow) => `/tickets/${formatReference(ticket.number)}`

/**
 * Tells the requester's account that the team answered.
 *
 * Only the *requester*, and only when their account is known. The cc'd participants are addresses,
 * not accounts, and the thirty-minute digest already reaches them by email. The requester is the one
 * person this Worker may have linked to an account — by opening the ticket signed in, or by claiming
 * it under `/me` — and an event without that link would have nobody to land on.
 *
 * Skipped when the author *is* the requester, compared by account and by address: an agent who files
 * a ticket for themselves and then answers it does not need to be told they did.
 *
 * Published immediately rather than on the thirty-minute clock, deliberately. The delay exists so an
 * inbox is not flooded while a conversation is live; the bell is not an inbox, and a notification
 * that shows up half an hour after the reply is on the page it links to is simply stale.
 */
const notifyTicketReply = async (
  env: Env,
  ticket: TicketRow,
  author: { email: string | null; name: string | null; userId: string | null },
) => {
  if (!ticket.requesterUserId) {
    return false
  }
  const authorEmail = author.email?.toLowerCase() ?? null
  if (author.userId === ticket.requesterUserId || authorEmail === ticket.requesterEmail) {
    return false
  }

  return publishNotification(env, {
    type: 'support.ticket_reply',
    user: {
      id: ticket.requesterUserId,
      email: ticket.requesterEmail,
      name: ticket.requesterName,
      locale: ticket.locale,
    },
    data: {
      reference: formatReference(ticket.number),
      subject: ticket.subject,
      author_name: author.name,
    },
    url: ticketPath(ticket),
  })
}

/**
 * The account behind an address, as far as this Worker has ever been told.
 *
 * This Worker cannot look an address up in the auth database — it has no binding for that, and must
 * not grow one — so the only evidence it holds is a token that once arrived carrying both: a ticket
 * opened or claimed while signed in (`tickets.requester_user_id`), or a participant row stamped from
 * one (`ticket_participants.user_id`). Either means auth itself asserted that `sub` owned that
 * address. Anything less — a name that looks similar, an address nobody ever signed in with — is not
 * evidence, and the answer is null.
 */
const resolveUserIdByEmail = async (db: Database, email: string): Promise<string | null> => {
  const address = email.toLowerCase()
  const [asRequester, asParticipant] = await db.batch([
    db
      .select({ userId: tickets.requesterUserId })
      .from(tickets)
      .where(and(eq(tickets.requesterEmail, address), isNotNull(tickets.requesterUserId)))
      .orderBy(desc(tickets.updatedAt))
      .limit(1),
    db
      .select({ userId: ticketParticipants.userId })
      .from(ticketParticipants)
      .where(and(eq(ticketParticipants.email, address), isNotNull(ticketParticipants.userId)))
      .orderBy(desc(ticketParticipants.createdAt))
      .limit(1),
  ])
  return asRequester[0]?.userId ?? asParticipant[0]?.userId ?? null
}

/**
 * Tells somebody's account they were put on a ticket — only if there is an account to tell.
 *
 * The "you were added" email has already gone out by the time this runs, and it is the notice that
 * matters: it carries the link. This is the bell beside it, and for the many people put on copy who
 * never signed in anywhere it is correctly nothing at all. Never throws: the lookup is the only part
 * that could, and a participant who has been added must not become a 500.
 */
const notifyParticipantAdded = async (db: Database, env: Env, ticket: TicketRow, email: string) => {
  try {
    const userId = await resolveUserIdByEmail(db, email)
    if (!userId) {
      return false
    }
    return await publishNotification(env, {
      type: 'support.participant_added',
      user: { id: userId, email: email.toLowerCase(), locale: ticket.locale },
      data: { reference: formatReference(ticket.number), subject: ticket.subject },
      url: ticketPath(ticket),
    })
  } catch (error) {
    console.error('failed to notify an added participant', error)
    return false
  }
}

export { buildNotificationEvent, notifyParticipantAdded, notifyTicketReply, publishNotification, resolveUserIdByEmail }
export type { NotificationData, NotificationEvent, NotificationInput, NotificationType }
