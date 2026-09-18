import { eq, inArray, or } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { emailMessages, inboundEmails, tickets } from '@/db/schema'
import type { Env } from '@/env'
import { INBOUND } from '@/lib/config'
import { readBody } from '@/lib/mime'
import { findReferenceInSubject, formatReference, stripReferenceTag } from '@/lib/references'
import { DEFAULT_LOCALE, isLocale } from '@/lib/locales'
import { parseReplyAddress, sha256 } from '@/lib/tokens'
import { extractFromEmail } from '@/services/ai'
import { recordSystemAudit } from '@/services/audit'
import { sendTicketReceived } from '@/services/email'
import { inboundFromSender } from '@/services/rate-limit'
import { cancelNotificationsFor } from '@/services/notifications'
import {
  addMessage,
  createTicket,
  findParticipant,
  findTicketByNumber,
  findTicketById,
  findTicketByReplyKey,
  recordEvent,
} from '@/services/tickets'
import type { AttachmentMeta, TicketRow } from '@/services/tickets'

/**
 * Turning an email into part of a conversation.
 *
 * The handler in `src/index.ts` is five lines; everything that decides anything is here, because
 * miniflare cannot dispatch an email event and a rule nobody can test is a rule nobody can trust.
 * This function takes a plain object, so the suite drives it with fixtures.
 */

type InboundMessage = {
  /** RFC `Message-ID`. Absent often enough that the idempotency key has a fallback. */
  messageId: string | null
  from: string
  /** Envelope recipient, which is where a `reply+<key>@` routing tag lives. */
  to: string
  subject: string | null
  text: string | null
  html: string | null
  date: string | null
  inReplyTo: string | null
  references: string[]
  attachments: AttachmentMeta[]
  rawSize: number
}

type MatchStrategy = 'reply_key' | 'in_reply_to' | 'references' | 'subject_tag' | 'new'

type IngestOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'created'; ticket: TicketRow; inboundId: string }
  | { outcome: 'appended'; ticket: TicketRow; inboundId: string }

const angleBracketIds = (values: string[]): string[] =>
  values.flatMap((value) => value.match(/<[^>]+>/g) ?? []).slice(0, 20)

/**
 * Which ticket this belongs to, in descending order of how much we trust the signal.
 *
 * 1. **The reply key.** A 256-bit token we minted, carried in the envelope address the sender's mail
 *    client filled in automatically. Nothing else comes close.
 * 2. **`In-Reply-To` / `References`**, matched against the ids of mail we sent. Strong, but only as
 *    reliable as the client's threading.
 * 3. **A `[FS-1042]` tag in the subject**, and *only* when the sender is already on that ticket.
 *    Without that condition it is a one-line forgery: anybody who guesses a reference could inject a
 *    message into a stranger's thread, which is the worst failure this file could have.
 * 4. Nothing matched — it is a new request.
 */
const matchThread = async (
  db: Database,
  message: InboundMessage,
): Promise<{ ticket: TicketRow | null; strategy: MatchStrategy }> => {
  const replyKey = parseReplyAddress(message.to)
  if (replyKey) {
    const ticket = await findTicketByReplyKey(db, replyKey)
    if (ticket) {
      return { ticket, strategy: 'reply_key' }
    }
  }

  const ids = angleBracketIds([message.inReplyTo ?? '', ...message.references])
  if (ids.length > 0) {
    const [sent] = await db
      .select({ ticketId: emailMessages.ticketId })
      .from(emailMessages)
      .where(or(inArray(emailMessages.rfcMessageId, ids), inArray(emailMessages.providerMessageId, ids)))
      .limit(1)

    if (sent?.ticketId) {
      const ticket = await findTicketById(db, sent.ticketId)
      if (ticket) {
        return { ticket, strategy: message.inReplyTo ? 'in_reply_to' : 'references' }
      }
    }
  }

  const tagged = findReferenceInSubject(message.subject)
  if (tagged !== null) {
    const ticket = await findTicketByNumber(db, tagged)
    // The condition that makes a subject tag safe to honour at all.
    if (ticket && (await findParticipant(db, ticket.id, message.from))) {
      return { ticket, strategy: 'subject_tag' }
    }
  }

  return { ticket: null, strategy: 'new' }
}

/**
 * A line appended to the body listing what came attached.
 *
 * Attachments are not stored — that needs a bucket, a moderation step and a gated download route,
 * which is a change of its own. Dropping them *silently* is the one genuinely unacceptable option,
 * because an agent would then be answering about a screenshot they have no idea exists.
 */
const attachmentNotice = (attachments: AttachmentMeta[], locale: string): string => {
  if (attachments.length === 0) {
    return ''
  }
  const list = attachments
    .map((file) => `${file.filename} (${Math.max(1, Math.round(file.size / 1024))} KB)`)
    .join(', ')

  return locale === 'es'
    ? `\n\n[Llegaron ${attachments.length} adjunto(s) que no se almacenan: ${list}. Pídelos por otra vía.]`
    : `\n\n[${attachments.length} attachment(s) were received but are not stored: ${list}. Ask for them another way.]`
}

const ingestEmail = async (db: Database, env: Env, message: InboundMessage): Promise<IngestOutcome> => {
  const from = message.from.trim().toLowerCase()
  const now = new Date()

  /*
   * Idempotency first, before anything is parsed or written.
   *
   * Email Routing retries, and a retried delivery without this key posts the same reply twice. The
   * unique index is over the *hash* because `Message-ID` is attacker-controlled unbounded text and
   * SQLite will happily index four kilobytes of it.
   *
   * The fallback for a message with no `Message-ID` is deliberately coarse rather than random: two
   * genuinely different messages that agree on sender, date, subject and byte count are the same
   * message, and a random key would turn every retry of a header-less message into a duplicate.
   */
  const messageIdHash = await sha256(
    message.messageId ?? `${from}|${message.date ?? ''}|${message.subject ?? ''}|${message.rawSize}`,
  )

  const [claim] = await db
    .insert(inboundEmails)
    .values({
      id: crypto.randomUUID(),
      messageIdHash,
      messageId: message.messageId?.slice(0, 998) ?? null,
      fromEmail: from,
      toEmail: message.to.trim().toLowerCase(),
      subject: message.subject?.slice(0, 500) ?? null,
      rawSize: message.rawSize,
      outcome: 'ignored',
      attachmentCount: message.attachments.length,
      receivedAt: now,
    })
    .onConflictDoNothing({ target: inboundEmails.messageIdHash })
    .returning({ id: inboundEmails.id })

  if (!claim) {
    return { outcome: 'duplicate' }
  }

  const finish = async (fields: Partial<typeof inboundEmails.$inferInsert>) => {
    await db.update(inboundEmails).set(fields).where(eq(inboundEmails.id, claim.id))
  }

  // Counted over this same table, so a refused message still spends the sender's quota. Somebody
  // hammering the inbox does not get it refunded because the first twenty were turned away.
  if ((await inboundFromSender(db, from, now)) > INBOUND.hourlyLimitPerSender) {
    await finish({ outcome: 'rejected', rejectReason: 'rate limited' })
    return { outcome: 'rejected', reason: 'Too many messages from this address' }
  }

  const { ticket: matched, strategy } = await matchThread(db, message)
  const body = readBody({ text: message.text, html: message.html })

  if (matched) {
    if (matched.status === 'spam') {
      await finish({ outcome: 'ignored', ticketId: matched.id, matchStrategy: strategy, rejectReason: 'ticket is spam' })
      return { outcome: 'ignored', reason: 'The ticket is marked as spam' }
    }

    const authorIsAgent = Boolean(
      (await findParticipant(db, matched.id, from))?.role === 'agent',
    )

    const posted = await addMessage(db, {
      ticketId: matched.id,
      kind: 'reply',
      authorType: authorIsAgent ? 'agent' : 'requester',
      authorEmail: from,
      bodyText: `${body.text}${attachmentNotice(message.attachments, matched.locale)}`,
      bodyTextRaw: body.raw,
      source: 'email',
      attachments: message.attachments,
    })

    if (!authorIsAgent) {
      // They answered, so whatever we were about to email them about, they have read.
      await cancelNotificationsFor(db, matched.id, from, 'author_replied_by_email')
    }
    if (matched.status === 'solved' || matched.status === 'closed') {
      await recordEvent(db, {
        ticketId: matched.id,
        event: 'reopened',
        actorType: authorIsAgent ? 'agent' : 'requester',
        actorEmail: from,
        metadata: { from: matched.status, via: 'email' },
      })
    }

    await finish({
      outcome: 'appended',
      ticketId: matched.id,
      ticketMessageId: posted.id,
      matchStrategy: strategy,
    })
    await recordSystemAudit(db, {
      event: 'email.inbound_ingested',
      actorEmail: from,
      resourceType: 'tickets',
      resourceId: matched.id,
      metadata: { strategy, reference: formatReference(matched.number), attachments: message.attachments.length },
    })

    return { outcome: 'appended', ticket: matched, inboundId: claim.id }
  }

  /*
   * A new ticket, built from the headers alone.
   *
   * The model runs afterwards (`enrichTicket`), never here. That ordering is the whole reason the
   * AI step cannot lose an email: the worst a model outage can do is leave a ticket with a plainer
   * subject line.
   */
  const subject = stripReferenceTag(message.subject?.trim() || '').slice(0, 120) ||
    body.text.split('\n')[0]?.slice(0, 120) ||
    'Support request'

  const { ticket, accessToken } = await createTicket(db, env, {
    subject,
    bodyText: `${body.text}${attachmentNotice(message.attachments, DEFAULT_LOCALE)}`,
    bodyTextRaw: body.raw,
    requesterEmail: from,
    source: 'email',
    attachments: message.attachments,
  })

  await finish({ outcome: 'created', ticketId: ticket.id, matchStrategy: strategy })
  await sendTicketReceived(db, env, ticket, accessToken)
  await recordSystemAudit(db, {
    event: 'email.inbound_ingested',
    actorEmail: from,
    resourceType: 'tickets',
    resourceId: ticket.id,
    metadata: { strategy: 'new', reference: formatReference(ticket.number), attachments: message.attachments.length },
  })

  return { outcome: 'created', ticket, inboundId: claim.id }
}

/**
 * The second pass over a ticket opened by email: ask the model what it is about and tidy the row.
 *
 * Runs in `waitUntil` after `ingestEmail` has already committed. Everything it touches is cosmetic —
 * subject, locale, priority, summary — so a failure is invisible to the person who wrote in.
 */
const enrichTicket = async (db: Database, env: Env, ticketId: string, inboundId: string, body: string) => {
  const ticket = await findTicketById(db, ticketId)
  if (!ticket) {
    return
  }

  const extraction = await extractFromEmail(db, env, {
    subject: ticket.subject,
    body,
    from: ticket.requesterEmail,
    ticketId,
  })

  if (!extraction) {
    await db.update(inboundEmails).set({ aiOk: false }).where(eq(inboundEmails.id, inboundId))
    return
  }

  await db
    .update(tickets)
    .set({
      subject: extraction.subject,
      locale: isLocale(extraction.language) ? extraction.language : ticket.locale,
      priority: extraction.priority,
      requesterName: ticket.requesterName ?? extraction.contact_name ?? null,
      aiSummary: extraction.summary,
      aiEnriched: true,
      aiModel: env.AI_TEXT_MODEL,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, ticketId))

  await db.update(inboundEmails).set({ aiOk: true }).where(eq(inboundEmails.id, inboundId))
}

export { enrichTicket, ingestEmail, matchThread }
export type { InboundMessage, IngestOutcome, MatchStrategy }
