import { eq } from 'drizzle-orm'
import {
  renderSupportParticipantAddedEmail,
  renderSupportTicketReceivedEmail,
  renderSupportTicketReplyEmail,
  resolveEmailLocale,
  type SupportReplyExcerpt,
} from '@franciscosolis/emails'
import type { Database } from '@/db/client'
import { emailMessages } from '@/db/schema'
import type { Env } from '@/env'
import { NOTIFICATIONS } from '@/lib/config'
import { formatReference } from '@/lib/references'
import { ticketReplyAddress, ticketUrl } from '@/services/tickets'
import type { MessageRow, TicketRow } from '@/services/tickets'

/**
 * Outgoing mail, logged the way `apps/cms` logs it: a row inserted `queued`, then updated to `sent`
 * with the provider's id or `failed` with the error. The reason is the same there and here — a
 * message that never arrived has to be distinguishable from one that was never attempted — but it
 * matters more in this Worker, because the *reply* to one of these is how half the conversation
 * comes back, and a lost send is a conversation that silently stops.
 *
 * Nothing in this file throws. Every caller is either finishing a request the person is waiting on
 * or running inside the cron sweep, and neither should turn a delivery problem into a 500.
 */

type EmailKind = 'ticket_received' | 'reply_digest' | 'participant_added' | 'access_link'

type SendInput = {
  kind: EmailKind
  ticketId: string | null
  to: string[]
  subject: string
  html: string
  text: string
  /**
   * Where a reply to this message should land. Defaults to `env.MAIL_REPLY_TO`, the generic
   * support address — a ticket-bound send overrides it with `ticketReplyAddress()` so the header
   * actually sent matches the `reply+<key>@` address the body text tells the recipient to use.
   */
  replyTo?: string
}

type SendResult = {
  id: string
  status: 'sent' | 'failed'
  messageId: string | null
  error: string | null
}

const sendEmail = async (db: Database, env: Env, input: SendInput): Promise<SendResult> => {
  const id = crypto.randomUUID()
  const from = { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME }
  const replyTo = input.replyTo ?? env.MAIL_REPLY_TO

  const base = {
    id,
    ticketId: input.ticketId,
    kind: input.kind,
    toAddresses: JSON.stringify(input.to),
    fromEmail: from.email,
    fromName: from.name,
    replyTo,
    subject: input.subject,
    html: input.html,
    text: input.text,
  }

  await db.insert(emailMessages).values({ ...base, status: 'queued' })

  try {
    const result = await env.EMAIL.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      // Deliberately not the sending address. `mail.franciscosolis.cl` sends and has no MX;
      // `franciscosolis.cl` is where Email Routing listens. A reply has to go to the second one or
      // it bounces, which would quietly remove the entire inbound half of this Worker. A
      // ticket-bound send narrows this further, to that ticket's own `reply+<key>@` address, so a
      // reply threads straight back onto it instead of falling through to the subject-tag match.
      replyTo,
    })

    await db
      .update(emailMessages)
      .set({ status: 'sent', providerMessageId: result.messageId, sentAt: new Date() })
      .where(eq(emailMessages.id, id))

    return { id, status: 'sent', messageId: result.messageId, error: null }
  } catch (error) {
    const message = (error as Error).message || 'Unknown error'
    await db.update(emailMessages).set({ status: 'failed', error: message }).where(eq(emailMessages.id, id))
    return { id, status: 'failed', messageId: null, error: message }
  }
}

/** The confirmation, carrying the only copy of the access link that ever leaves this system. */
const sendTicketReceived = async (db: Database, env: Env, ticket: TicketRow, accessToken: string) => {
  const replyTo = ticketReplyAddress(env, ticket)
  const rendered = await renderSupportTicketReceivedEmail({
    reference: formatReference(ticket.number),
    subject: ticket.subject,
    url: ticketUrl(env, ticket, accessToken),
    replyTo,
    locale: resolveEmailLocale(ticket.locale),
    brandName: env.MAIL_FROM_NAME,
  })

  return sendEmail(db, env, {
    kind: 'ticket_received',
    ticketId: ticket.id,
    to: [ticket.requesterEmail],
    replyTo,
    ...rendered,
  })
}

/**
 * The deferred digest.
 *
 * **It carries no access secret, and it cannot.** Only the SHA-256 of the ticket's secret is stored,
 * which is the property that makes a database dump useless for reading tickets — and the direct
 * consequence is that nothing running after the ticket was created can rebuild the deep link. The
 * alternatives were all worse: keeping the secret recoverable defeats the point, and minting a fresh
 * one on every notification would invalidate the link in the confirmation email somebody filed away.
 *
 * So the link here goes to the ticket page without a secret, and the email leans on the two things
 * that do work: the replies are quoted in full in the message itself, and replying to it lands on
 * the ticket. Somebody who wants the web view and no longer has their original link asks for a new
 * one through `POST /tickets/resend-link`.
 */
const sendReplyDigest = async (
  db: Database,
  env: Env,
  ticket: TicketRow,
  recipient: string,
  messages: MessageRow[],
) => {
  const excerpts: SupportReplyExcerpt[] = messages.slice(-NOTIFICATIONS.maxDigestMessages).map((message) => ({
    // Never the agent's own address: a requester needs to know support answered, not which
    // individual mailbox to write to directly and bypass the queue with.
    author: message.authorName ?? 'Support',
    body:
      message.bodyText.length > NOTIFICATIONS.excerptLength
        ? `${message.bodyText.slice(0, NOTIFICATIONS.excerptLength)}…`
        : message.bodyText,
  }))

  const replyTo = ticketReplyAddress(env, ticket)
  const rendered = await renderSupportTicketReplyEmail({
    reference: formatReference(ticket.number),
    subject: ticket.subject,
    url: `${env.SUPPORT_TICKET_URL.replace(/\/+$/, '')}/${formatReference(ticket.number)}`,
    replyTo,
    messages: excerpts,
    locale: resolveEmailLocale(ticket.locale),
    brandName: env.MAIL_FROM_NAME,
  })

  return sendEmail(db, env, {
    kind: 'reply_digest',
    ticketId: ticket.id,
    to: [recipient],
    replyTo,
    ...rendered,
  })
}

/** Sent to somebody newly put on a ticket, instead of back-filling them into the next digest. */
const sendParticipantAdded = async (db: Database, env: Env, ticket: TicketRow, recipient: string) => {
  const replyTo = ticketReplyAddress(env, ticket)
  const rendered = await renderSupportParticipantAddedEmail({
    reference: formatReference(ticket.number),
    subject: ticket.subject,
    url: `${env.SUPPORT_TICKET_URL.replace(/\/+$/, '')}/${formatReference(ticket.number)}`,
    replyTo,
    locale: resolveEmailLocale(ticket.locale),
    brandName: env.MAIL_FROM_NAME,
  })

  return sendEmail(db, env, {
    kind: 'participant_added',
    ticketId: ticket.id,
    to: [recipient],
    replyTo,
    ...rendered,
  })
}

export { sendEmail, sendParticipantAdded, sendReplyDigest, sendTicketReceived }
export type { EmailKind, SendInput, SendResult }
