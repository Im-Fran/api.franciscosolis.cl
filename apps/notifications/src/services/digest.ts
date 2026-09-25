import { and, asc, eq, exists, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { notifications, recipients } from '@/db/schema'
import type { Env } from '@/env'
import type { NotificationData } from '@/lib/catalog'
import { isNotificationType, renderCopy } from '@/lib/catalog'
import type { EmailFrequency } from '@/lib/config'
import { DIGEST } from '@/lib/config'
import { dueDigests } from '@/lib/time'
import { sendDigest, siteUrl } from '@/services/email'
import { toPreferences } from '@/services/recipients'

/**
 * The daily and weekly summaries — the part of this Worker that actually sends less mail.
 *
 * Run by the hourly cron. At every hour but the digest hour it does nothing (`dueDigests`). At the
 * digest hour it emails everybody who has something `pending`, grouped into one message each.
 *
 * Three rules, each of which is the reason for a line below:
 *
 * - **Only what has not been read.** A notification opened on the website before the digest runs is
 *   marked `skipped`, not listed: repeating what somebody already saw is the mail this exists to cut.
 * - **`immediate` recipients are in the daily run too.** Their notifications are only `pending` if
 *   the immediate send failed (`services/ingest.ts`), so the daily run is their retry, and without it
 *   a mail outage would lose them rather than delay them.
 * - **A run is idempotent per recipient.** `lastDigestAt` is written with the rows it covered, and a
 *   recipient digested within the guard window is not selected again — so a cron that fires twice in
 *   the hour, or a manual re-run, sends nothing twice.
 */

type Period = 'daily' | 'weekly'

const FREQUENCIES_FOR: Record<Period, EmailFrequency[]> = {
  daily: ['daily', 'immediate'],
  weekly: ['weekly'],
}

/** A recipient digested more recently than this is skipped by the run. Comfortably under a period. */
const GUARD_SECONDS: Record<Period, number> = {
  daily: 20 * 3600,
  weekly: 6 * 86_400,
}

/** Upper bound on recipients handled per run, so a runaway backlog cannot exhaust the invocation. */
const MAX_BATCHES = 40

type DigestRunResult = {
  periods: Period[]
  sent: number
  failed: number
  skippedRead: number
}

const formatWhen = (date: Date, locale: string) =>
  new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DIGEST.timeZone,
  }).format(date)

const parseData = (raw: string): NotificationData => {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * One recipient's digest. Answers whether an email went out; throws only if the send itself failed,
 * leaving every row `pending` for the next run.
 */
const digestRecipient = async (
  db: Database,
  env: Env,
  recipient: typeof recipients.$inferSelect,
  period: Period,
  now: Date,
): Promise<{ sent: boolean; skippedRead: number }> => {
  const skipped = await db
    .update(notifications)
    .set({ emailStatus: 'skipped' })
    .where(
      and(
        eq(notifications.userId, recipient.userId),
        eq(notifications.emailStatus, 'pending'),
        isNotNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id })
    .all()

  const pending = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, recipient.userId), eq(notifications.emailStatus, 'pending')))
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .all()

  if (pending.length === 0 || !recipient.email) {
    return { sent: false, skippedRead: skipped.length }
  }

  const { locale } = toPreferences(recipient)
  const listed = pending.slice(0, DIGEST.maxItems)
  const items = listed.map((row) => {
    const data = parseData(row.data)
    const copy = isNotificationType(row.type) ? renderCopy(row.type, data, locale) : { title: row.type, body: '' }
    return { ...copy, url: siteUrl(env, row.url), when: formatWhen(row.createdAt, locale) }
  })

  await sendDigest(env, {
    to: recipient.email,
    period,
    items,
    moreCount: pending.length - listed.length,
    locale,
  })

  // Only the rows that were in the snapshot above. Anything that arrived while the email was being
  // rendered waits for the next digest instead of being marked as sent without having been listed.
  const ids = pending.map((row) => row.id)
  for (let i = 0; i < ids.length; i += 90) {
    await db
      .update(notifications)
      .set({ emailStatus: 'sent', emailedAt: now })
      .where(inArray(notifications.id, ids.slice(i, i + 90)))
  }
  await db.update(recipients).set({ lastDigestAt: now }).where(eq(recipients.userId, recipient.userId))

  return { sent: true, skippedRead: skipped.length }
}

const runPeriod = async (db: Database, env: Env, period: Period, now: Date, result: DigestRunResult) => {
  const cutoff = new Date(now.getTime() - GUARD_SECONDS[period] * 1000)
  const failed: string[] = []

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const due = await db
      .select()
      .from(recipients)
      .where(
        and(
          inArray(recipients.emailFrequency, FREQUENCIES_FOR[period]),
          isNotNull(recipients.email),
          or(isNull(recipients.lastDigestAt), lt(recipients.lastDigestAt, cutoff)),
          failed.length > 0 ? notInArray(recipients.userId, failed) : undefined,
          exists(
            db
              .select({ one: sql`1` })
              .from(notifications)
              .where(and(eq(notifications.userId, recipients.userId), eq(notifications.emailStatus, 'pending'))),
          ),
        ),
      )
      .limit(DIGEST.batchSize)
      .all()

    if (due.length === 0) {
      return
    }

    let progressed = false
    for (const recipient of due) {
      try {
        const outcome = await digestRecipient(db, env, recipient, period, now)
        result.skippedRead += outcome.skippedRead
        if (outcome.sent) {
          result.sent += 1
        } else {
          // Everything pending had been read. Stamp the run so this recipient is not selected again.
          await db.update(recipients).set({ lastDigestAt: now }).where(eq(recipients.userId, recipient.userId))
        }
        progressed = true
      } catch (error) {
        result.failed += 1
        failed.push(recipient.userId)
        console.error('digest failed for a recipient', period, error instanceof Error ? error.message : error)
      }
    }
    if (!progressed) {
      return
    }
  }
}

const runDigests = async (db: Database, env: Env, now: Date, force?: Period[]): Promise<DigestRunResult> => {
  const periods = force ?? dueDigests(now)
  const result: DigestRunResult = { periods, sent: 0, failed: 0, skippedRead: 0 }
  // On a Monday both run. The frequency lists are disjoint, so nobody is in both and nobody gets two.
  for (const period of periods) {
    await runPeriod(db, env, period, now, result)
  }
  return result
}

export { digestRecipient, runDigests }
export type { DigestRunResult, Period }
