import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { ticketNotifications, ticketParticipants, tickets } from '@/db/schema'
import type { Env } from '@/env'
import { NOTIFICATIONS } from '@/lib/config'
import { recordSystemAudit } from '@/services/audit'
import { sendReplyDigest } from '@/services/email'
import { findTicketById, listAgentRepliesAfter, recordEvent } from '@/services/tickets'
import type { TicketRow } from '@/services/tickets'

/**
 * The "tell them in thirty minutes, unless they came back" rule, in one file.
 *
 * The whole feature is an observation about attention: somebody who is reading the thread in a
 * browser does not need an email about a reply they are already looking at, and somebody who has
 * walked away does. So a reply does not send anything — it *schedules* something, and coming back
 * cancels it.
 *
 * Three decisions here are easy to get wrong and expensive to debug:
 *
 * 1. **A second reply inside the window does not extend the wait.** The insert is an
 *    `ON CONFLICT DO NOTHING` against a partial unique index, so the first reply's deadline stands
 *    and the digest simply grows. Extending would let a chatty agent — reply at T+0, T+25, T+50 —
 *    push the deadline out forever, and the person would never hear from us at all.
 * 2. **Cancelling is per recipient, not per ticket.** One watcher opening the thread must not
 *    silence the notice owed to the other three.
 * 3. **The race is resolved in favour of sending.** If a reply and the sweep happen at the same
 *    instant, either the cancel wins (nothing is sent) or the sweep wins (one redundant email).
 *    The cancel is scoped to `state = 'pending'` precisely so it can never yank a row out from under
 *    an in-flight send. An email too many is a mild annoyance; an email too few is a customer who
 *    thinks they were ignored.
 */

/**
 * Schedules the notice owed to everybody on a ticket after an agent replies in public.
 *
 * Who is skipped, and why it is read off rows rather than inferred: the author (obviously), anybody
 * with `notifyEmail` off, and agents. That last one is a stored decision made when the participant
 * was added — re-deriving it at send time by re-running the email-domain gate would couple this path
 * to the console's auth config and would mail an agent who happens to use a personal address.
 */
const scheduleReplyNotifications = async (db: Database, ticket: TicketRow, authorEmail: string | null) => {
  const recipients = await db
    .select()
    .from(ticketParticipants)
    .where(and(eq(ticketParticipants.ticketId, ticket.id), eq(ticketParticipants.notifyEmail, true)))

  const dueAt = new Date(Date.now() + NOTIFICATIONS.delaySeconds * 1000)
  const author = authorEmail?.toLowerCase() ?? null

  const rows = recipients
    .filter((participant) => participant.role !== 'agent' && participant.email !== author)
    .map((participant) => ({
      id: crypto.randomUUID(),
      ticketId: ticket.id,
      recipientEmail: participant.email,
      state: 'pending' as const,
      dueAt,
      // The digest window starts where this person's last notice ended, so a reply they were already
      // told about is not quoted at them twice.
      afterSeq: participant.lastNotifiedSeq,
    }))

  if (rows.length === 0) {
    return 0
  }

  // Written as SQL rather than through the query builder, and it has to be.
  //
  // The index this conflicts against is *partial* — `(ticket_id, recipient_email) WHERE state =
  // 'pending'` — and SQLite only recognises a partial index as a conflict target when the predicate
  // is repeated after the column list. Drizzle 0.45 has no way to express that: its
  // `onConflictDoNothing({ where })` emits the predicate after `DO NOTHING`, which is where the
  // clause for a `DO UPDATE` goes, and against a `DO NOTHING` it is simply a syntax error.
  //
  // Losing the partial index instead is not an option. It is the thing that makes "one pending
  // notice per person per ticket" true of the database rather than true of this function, and it is
  // what turns a second reply inside the window into a no-op instead of a second deadline.
  // Sequential rather than batched: `db.batch` in drizzle-d1 0.45 only accepts its own query
  // builders, not a raw `db.run(sql...)`, and a ticket has a handful of participants rather than
  // thousands — so the round trips are cheap and the alternative is losing the partial index.
  for (const row of rows) {
    await db.run(sql`
      insert into ${ticketNotifications} (id, ticket_id, recipient_email, state, due_at, after_seq)
      values (
        ${row.id},
        ${row.ticketId},
        ${row.recipientEmail},
        'pending',
        ${Math.floor(row.dueAt.getTime() / 1000)},
        ${row.afterSeq}
      )
      on conflict (ticket_id, recipient_email) where state = 'pending' do nothing
    `)
  }

  return rows.length
}

/** Called when somebody who is not an agent writes on the ticket: they are evidently reading it. */
const cancelNotificationsFor = async (
  db: Database,
  ticketId: string,
  recipientEmail: string,
  reason = 'author_replied',
) => {
  const cancelled = await db
    .update(ticketNotifications)
    .set({ state: 'cancelled', cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() })
    .where(
      and(
        eq(ticketNotifications.ticketId, ticketId),
        eq(ticketNotifications.recipientEmail, recipientEmail.toLowerCase()),
        // Scoped to `pending` on purpose: a row already claimed by the sweep is mid-send, and
        // flipping it here would strand it in a state nothing ever resolves.
        eq(ticketNotifications.state, 'pending'),
      ),
    )
    .returning({ id: ticketNotifications.id })

  return cancelled.length
}

/**
 * Puts back any row a previous sweep claimed and never finished.
 *
 * Without this, one isolate dying mid-send leaves a row in `sending` forever and that person never
 * hears about that ticket again — a silent, permanent, single-recipient outage, which is the worst
 * shape a bug can have.
 */
const reapStuckNotifications = async (db: Database, now: Date) => {
  const cutoff = new Date(now.getTime() - NOTIFICATIONS.reapAfterSeconds * 1000)
  const reaped = await db
    .update(ticketNotifications)
    .set({ state: 'pending', claimedAt: null, updatedAt: now })
    .where(and(eq(ticketNotifications.state, 'sending'), lte(ticketNotifications.claimedAt, cutoff)))
    .returning({ id: ticketNotifications.id })

  return reaped.length
}

type SweepResult = {
  reaped: number
  claimed: number
  sent: number
  cancelled: number
  failed: number
}

/**
 * One pass of the cron.
 *
 * Claiming is a single `UPDATE ... WHERE id IN (SELECT ... LIMIT n) RETURNING *`, which is what makes
 * two overlapping runs safe: whichever gets there first moves the rows out of `pending`, and the
 * other finds nothing. Each row is then handled in its own try/catch, because one undeliverable
 * address must not abandon the other forty-nine in the batch.
 */
const sweepNotifications = async (db: Database, env: Env, now: Date): Promise<SweepResult> => {
  const result: SweepResult = { reaped: 0, claimed: 0, sent: 0, cancelled: 0, failed: 0 }

  result.reaped = await reapStuckNotifications(db, now)

  const due = db
    .select({ id: ticketNotifications.id })
    .from(ticketNotifications)
    .where(and(eq(ticketNotifications.state, 'pending'), lte(ticketNotifications.dueAt, now)))
    .orderBy(asc(ticketNotifications.dueAt))
    .limit(NOTIFICATIONS.batchSize)

  const claimed = await db
    .update(ticketNotifications)
    .set({
      state: 'sending',
      claimedAt: now,
      attempts: sql`${ticketNotifications.attempts} + 1`,
      updatedAt: now,
    })
    .where(inArray(ticketNotifications.id, due))
    .returning()

  result.claimed = claimed.length

  for (const row of claimed) {
    try {
      const ticket = await findTicketById(db, row.ticketId)
      const messages = ticket ? await listAgentRepliesAfter(db, ticket.id, row.afterSeq) : []

      // The self-healing path, and it covers every race at once: if the ticket went away, was marked
      // spam, or the replies this notice was about have already been covered, there is nothing to
      // say and the row is retired for the price of one query.
      if (!ticket || ticket.status === 'spam' || messages.length === 0) {
        await db
          .update(ticketNotifications)
          .set({
            state: 'cancelled',
            cancelledAt: now,
            cancelReason: !ticket ? 'ticket_gone' : ticket.status === 'spam' ? 'ticket_spam' : 'no_new_messages',
            updatedAt: now,
          })
          .where(eq(ticketNotifications.id, row.id))
        result.cancelled += 1
        continue
      }

      const sent = await sendReplyDigest(db, env, ticket, row.recipientEmail, messages)
      const throughSeq = messages[messages.length - 1]!.seq

      if (sent.status === 'sent') {
        await db.batch([
          db
            .update(ticketNotifications)
            .set({ state: 'sent', throughSeq, sentAt: now, updatedAt: now })
            .where(eq(ticketNotifications.id, row.id)),
          db
            .update(ticketParticipants)
            .set({ lastNotifiedSeq: throughSeq })
            .where(
              and(
                eq(ticketParticipants.ticketId, ticket.id),
                eq(ticketParticipants.email, row.recipientEmail),
              ),
            ),
        ])
        await recordEvent(db, {
          ticketId: ticket.id,
          event: 'notification_sent',
          actorType: 'system',
          metadata: { to: row.recipientEmail, through_seq: throughSeq, messages: messages.length },
        })
        result.sent += 1
        continue
      }

      await failNotification(db, row.id, row.attempts, sent.error ?? 'send failed', now)
      result.failed += 1
    } catch (error) {
      await failNotification(db, row.id, row.attempts, (error as Error).message ?? 'unknown error', now)
      result.failed += 1
    }
  }

  if (result.sent > 0 || result.failed > 0) {
    await recordSystemAudit(db, {
      event: 'notification.sent',
      actorEmail: 'cron',
      resourceType: 'ticket_notifications',
      metadata: { ...result },
    })
  }

  return result
}

/**
 * Backs a failed send off exponentially and gives up after `maxAttempts`.
 *
 * `attempts` was already incremented by the claim, so the delay is `60 * 2^attempts` seconds: one
 * minute, two, four, eight. Giving up is a state, not a deletion — `failed` rows are what
 * `GET /admin/notifications` exists to show.
 */
const failNotification = async (db: Database, id: string, attempts: number, error: string, now: Date) => {
  const exhausted = attempts >= NOTIFICATIONS.maxAttempts
  await db
    .update(ticketNotifications)
    .set({
      state: exhausted ? 'failed' : 'pending',
      claimedAt: null,
      dueAt: exhausted ? undefined : new Date(now.getTime() + 60_000 * 2 ** attempts),
      lastError: error,
      updatedAt: now,
    })
    .where(eq(ticketNotifications.id, id))
}

export {
  cancelNotificationsFor,
  reapStuckNotifications,
  scheduleReplyNotifications,
  sweepNotifications,
}
export type { SweepResult }
