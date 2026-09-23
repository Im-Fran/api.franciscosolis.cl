import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import type { Database } from '@/db/client'
import { notifications } from '@/db/schema'
import type { Env } from '@/env'
import type { NotificationData, NotificationType } from '@/lib/catalog'
import { categoryOf, isEmailable, isNotificationType, renderCopy } from '@/lib/catalog'
import { PREFERENCES_PATH, sendImmediate } from '@/services/email'
import { pushToUser } from '@/services/push'
import { getRecipient, toPreferences, upsertRecipient } from '@/services/recipients'

/**
 * The queue consumer's work, one event at a time.
 *
 * This is the only way a notification is created. Producers — `auth`, `support`, `marketplace` —
 * put a `NotificationEvent` on the queue and move on; nothing they do waits on this Worker, and
 * nothing this Worker does can fail a sign-in or a payment.
 *
 * The event id is the notification's primary key, and that is the whole idempotency story: Queues
 * deliver at least once, a redelivered event hits the primary key, inserts nothing, and — because
 * every side effect below is gated on the insert having happened — pushes and emails nothing either.
 */

const scalar = v.union([v.string(), v.number(), v.boolean(), v.null()])

const eventSchema = v.object({
  version: v.literal(1),
  id: v.pipe(v.string(), v.minLength(8), v.maxLength(64)),
  type: v.string(),
  user: v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    email: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(320)))),
    name: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200)))),
    locale: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(16)))),
  }),
  occurred_at: v.pipe(v.string(), v.isoTimestamp()),
  data: v.pipe(
    v.record(v.string(), scalar),
    v.check((data) => Object.keys(data).length <= 20, 'too many data keys'),
  ),
  url: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(512)))),
})

type NotificationEvent = v.InferOutput<typeof eventSchema>

/**
 * What became of one message. `invalid` is acknowledged and dropped: a malformed event will be just
 * as malformed on the fifth retry. `retry` is for the one case that can fix itself — a type this
 * deploy does not know yet, which is a producer deployed ahead of this Worker.
 */
type IngestOutcome = 'created' | 'duplicate' | 'invalid' | 'retry'

/** Strings in `data` are capped, so a producer bug cannot put a ticket body in a push payload. */
const MAX_DATA_STRING = 300

const clampData = (data: Record<string, string | number | boolean | null>): NotificationData =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === 'string' && value.length > MAX_DATA_STRING ? `${value.slice(0, MAX_DATA_STRING - 1)}…` : value,
    ]),
  )

/** Security notices wake a phone; news does not. */
const urgencyFor = (type: NotificationType) => (categoryOf(type) === 'account' ? 'high' : 'normal')

const ingestEvent = async (db: Database, env: Env, raw: unknown): Promise<IngestOutcome> => {
  const parsed = v.safeParse(eventSchema, raw)
  if (!parsed.success) {
    console.error('dropping a malformed notification event', JSON.stringify(v.flatten(parsed.issues)))
    return 'invalid'
  }
  const event: NotificationEvent = parsed.output
  if (!isNotificationType(event.type)) {
    console.error('notification event of an unknown type, retrying', event.type)
    return 'retry'
  }
  const type = event.type
  const category = categoryOf(type)
  const data = clampData(event.data)
  const url = event.url && event.url.startsWith('/') && !event.url.startsWith('//') ? event.url : null

  await upsertRecipient(db, {
    userId: event.user.id,
    email: event.user.email,
    name: event.user.name,
    locale: event.user.locale,
  })
  const recipient = await getRecipient(db, event.user.id)
  const preferences = toPreferences(recipient)
  const channels = preferences.categories[category]

  // Decided once, as of arrival: changing a preference later affects what arrives later, not what
  // is already waiting — the same way unsubscribing from a newsletter does not recall the last one.
  const wantsEmail =
    isEmailable(type) && channels.email && preferences.email_frequency !== 'never' && Boolean(recipient?.email)
  const emailStatus = wantsEmail ? 'pending' : 'none'

  const inserted = await db
    .insert(notifications)
    .values({
      id: event.id,
      userId: event.user.id,
      type,
      category,
      data: JSON.stringify(data),
      url,
      emailStatus,
      occurredAt: new Date(event.occurred_at),
    })
    .onConflictDoNothing({ target: notifications.id })
    .returning({ id: notifications.id })
    .all()

  if (inserted.length === 0) {
    return 'duplicate'
  }

  const copy = renderCopy(type, data, preferences.locale)

  if (channels.push) {
    await pushToUser(
      db,
      env,
      event.user.id,
      {
        id: event.id,
        type,
        title: copy.title,
        body: copy.body,
        url: url ?? PREFERENCES_PATH,
        tag: `${type}:${event.id}`,
      },
      // One pending push per category: a phone that comes back online after a burst gets the latest
      // of each kind rather than all of them. Topics are capped at 32 url-safe characters.
      { urgency: urgencyFor(type), topic: category },
    )
  }

  // Sent after the row exists and marked sent only once the binding accepted it. A failure leaves
  // the row `pending`, and the next daily run — which covers `immediate` recipients too, for exactly
  // this — picks it up, so a mail outage delays an immediate email rather than losing it.
  if (wantsEmail && preferences.email_frequency === 'immediate' && recipient?.email) {
    try {
      await sendImmediate(env, {
        to: recipient.email,
        type,
        data,
        url,
        copy,
        locale: preferences.locale,
        occurredAt: new Date(event.occurred_at),
      })
      await db
        .update(notifications)
        .set({ emailStatus: 'sent', emailedAt: new Date() })
        .where(eq(notifications.id, event.id))
    } catch (error) {
      console.error('immediate notification email failed; left for the next digest', type, error)
    }
  }

  return 'created'
}

/**
 * The `queue` handler's body. Each message is acknowledged or retried on its own, so one bad event
 * never takes the rest of its batch down with it — and an unexpected error (D1 unavailable, say)
 * retries just that message with the queue's own backoff.
 */
const consumeBatch = async (db: Database, env: Env, batch: MessageBatch<unknown>) => {
  const counts: Record<IngestOutcome | 'error', number> = { created: 0, duplicate: 0, invalid: 0, retry: 0, error: 0 }
  for (const message of batch.messages) {
    try {
      const outcome = await ingestEvent(db, env, message.body)
      counts[outcome] += 1
      if (outcome === 'retry') {
        message.retry({ delaySeconds: 60 })
      } else {
        message.ack()
      }
    } catch (error) {
      counts.error += 1
      console.error('notification event failed, retrying', error instanceof Error ? error.message : error)
      message.retry({ delaySeconds: 30 })
    }
  }
  return counts
}

export { consumeBatch, eventSchema, ingestEvent }
export type { IngestOutcome, NotificationEvent }
