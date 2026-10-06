import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { pushSubscriptions } from '@/db/schema'
import type { Env } from '@/env'
import { PUSH } from '@/lib/config'
import type { VapidKeys } from '@/lib/webpush'
import { loadVapidKeys, sendPush } from '@/lib/webpush'

/**
 * What a service worker receives. Deliberately the rendered text and a path, not the raw `data`:
 * the service worker shows a notification and nothing else, and every byte here is encrypted and
 * relayed by a third party that caps the payload at around 4 KB.
 */
type PushPayload = {
  id: string
  type: string
  title: string
  body: string
  /**
   * A path on the website, never an absolute URL. The service worker resolves it against its own
   * origin and refuses anything else, so a payload cannot turn a notification into an off-site link.
   */
  url: string
  tag: string
}

/**
 * Per-isolate memo of the imported key. Importing a JWK is cheap but not free, and a queue batch can
 * push to dozens of devices; the secret does not change without a deploy, which is a new isolate.
 */
let cachedKeys: { secret: string; keys: VapidKeys | null } | null = null

const getVapidKeys = async (env: Env): Promise<VapidKeys | null> => {
  const secret = env.VAPID_PRIVATE_KEY ?? ''
  if (cachedKeys?.secret !== secret) {
    cachedKeys = { secret, keys: await loadVapidKeys(secret) }
  }
  return cachedKeys.keys
}

/**
 * Pushes one payload to every device an account registered, and tidies up after the push services'
 * answers: a 404/410 deletes the subscription on the spot, a success resets its failure count, and
 * anything else counts towards `PUSH.maxFailures`.
 *
 * Never throws. A push is a courtesy on top of a notification that is already stored; a push service
 * having a bad day must not make the queue retry the whole event and insert nothing new but send
 * every *other* device the same push twice.
 */
const pushToUser = async (
  db: Database,
  env: Env,
  userId: string,
  payload: PushPayload,
  options: { urgency?: 'normal' | 'high'; topic?: string } = {},
): Promise<{ sent: number; removed: number; failed: number }> => {
  const result = { sent: 0, removed: 0, failed: 0 }
  const keys = await getVapidKeys(env)
  if (!keys) {
    return result
  }

  try {
    const targets = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all()
    const outcomes = await Promise.all(
      targets.map(async (target) => ({
        target,
        outcome: await sendPush(keys, target, payload, {
          ttl: PUSH.ttl,
          subject: env.VAPID_SUBJECT,
          jwtLifetime: PUSH.jwtLifetime,
          urgency: options.urgency,
          topic: options.topic,
        }),
      })),
    )

    const gone: string[] = []
    const failed: string[] = []
    const sent: string[] = []
    for (const { target, outcome } of outcomes) {
      if (outcome.outcome === 'sent') sent.push(target.id)
      else if (outcome.outcome === 'gone') gone.push(target.id)
      else failed.push(target.id)
    }

    if (gone.length > 0) {
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone))
    }
    if (sent.length > 0) {
      await db
        .update(pushSubscriptions)
        .set({ failureCount: 0, lastUsedAt: sql`(unixepoch())` })
        .where(inArray(pushSubscriptions.id, sent))
    }
    if (failed.length > 0) {
      await db
        .update(pushSubscriptions)
        .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
        .where(inArray(pushSubscriptions.id, failed))
      await db
        .delete(pushSubscriptions)
        .where(and(inArray(pushSubscriptions.id, failed), sql`${pushSubscriptions.failureCount} >= ${PUSH.maxFailures}`))
    }

    result.sent = sent.length
    result.removed = gone.length
    result.failed = failed.length
  } catch (error) {
    console.error('push fan-out failed', error instanceof Error ? error.message : error)
  }
  return result
}

type SubscriptionInput = {
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
}

/**
 * Registers a device, or moves it to this account if it was somebody else's (see the note on the
 * table: an endpoint is a browser profile, and the last account to register it is the one that
 * should be pushed to). Keeps at most `PUSH.maxSubscriptionsPerUser` per account by dropping the
 * least recently registered, so a browser that re-subscribes on every visit cannot grow a list.
 */
const registerSubscription = async (db: Database, userId: string, input: SubscriptionInput) => {
  const row = await db
    .insert(pushSubscriptions)
    .values({
      id: crypto.randomUUID(),
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent,
        failureCount: 0,
        updatedAt: sql`(unixepoch())`,
      },
    })
    .returning()
    .get()

  const all = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(desc(pushSubscriptions.updatedAt), desc(pushSubscriptions.createdAt))
    .all()
  const excess = all.slice(PUSH.maxSubscriptionsPerUser).map(({ id }) => id)
  if (excess.length > 0) {
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, excess))
  }

  return row
}

export { getVapidKeys, pushToUser, registerSubscription }
export type { PushPayload, SubscriptionInput }
