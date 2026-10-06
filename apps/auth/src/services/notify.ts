import type { Env } from '@/env'

/**
 * Publishing an event for `apps/notifications`, which turns it into an in-site notification, a push
 * and — depending on the account's preferences — an email or a line in a digest.
 *
 * The message shape is a contract between two Workers that deploy independently, so it is written
 * down twice on purpose: here, as what this Worker promises to send, and in `apps/notifications`,
 * as what it accepts. `version` is what lets the consumer tell a future shape apart from this one
 * instead of guessing from which fields happen to be present.
 *
 * Only the types this Worker produces are listed. The consumer knows the whole catalog; a producer
 * that could name a `marketplace.*` type would only be a producer able to send one by mistake.
 */
type NotificationType =
  | 'account.sign_in'
  | 'account.authorization'
  | 'account.avatar_approved'
  | 'account.avatar_rejected'

/** Flat on purpose: the consumer interpolates these into a localised title and body, nothing more. */
type NotificationData = Record<string, string | number | boolean | null>

type NotificationEvent = {
  version: 1
  /**
   * Idempotency key. A queue delivers at least once, so the consumer treats a second message with
   * the same id as a no-op — which only works because the id is minted here, once, before the send,
   * rather than by the consumer on arrival.
   */
  id: string
  type: NotificationType
  /** The account the notification is for. `id` is the `sub` this Worker puts on its tokens. */
  user: { id: string; email?: string | null; name?: string | null; locale?: string | null }
  /** ISO 8601. When the thing happened, which is not necessarily when it is published. */
  occurred_at: string
  data: NotificationData
  /** A path on the website, starting with `/`, or null when there is nowhere useful to send them. */
  url?: string | null
}

type NotificationInput = {
  type: NotificationType
  user: NotificationEvent['user']
  data?: NotificationData
  url?: string | null
  /** Defaults to now. */
  occurredAt?: Date
}

/** Builds the message without sending it, so a batch and a single send cannot drift apart. */
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
 * Every caller is the tail of something that already happened — a sign-in with a code minted, an
 * avatar already approved — so a queue that is down must cost a notification, not the request. The
 * answer says whether the event was accepted, because one caller cannot afford to lose it silently:
 * the account-access notice falls back to emailing directly when this answers `false`.
 *
 * An event without an account is refused here rather than at each call site. The consumer keys every
 * row by `user.id`; an event for nobody would be dead-lettered on arrival, and dropping it before the
 * send keeps it out of the queue's metrics as well.
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

export { buildNotificationEvent, publishNotification }
export type { NotificationData, NotificationEvent, NotificationInput, NotificationType }
