import type { Env } from '@/env'

/**
 * Publishing an event for `apps/notifications`, which files it in the recipient's bell on the
 * website, pushes it, and emails it immediately or in a digest as they chose.
 *
 * The message shape is a contract between two Workers that deploy independently, so it is written
 * down twice on purpose: here, as what this Worker promises to send, and in `apps/notifications`, as
 * what it accepts. Only the types this Worker produces are listed: alerts, for the account that
 * created the rule, and support tickets — a new one, or a new message on one — for the account the
 * app's tickets are assigned to.
 */
type NotificationType = 'custom_apps.alert_opened' | 'custom_apps.alert_resolved' | 'custom_apps.ticket_opened' | 'custom_apps.ticket_message'

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

/**
 * Queues one event, and never throws: the caller is the alert evaluator, and a notifications outage
 * must cost the bell, never the evaluation that found the problem. A rule with no recipient — one
 * created before an account was attached to it — publishes nothing, since the consumer files every
 * notification under a known `sub`.
 */
const publishNotification = async (env: Env, input: NotificationInput): Promise<boolean> => {
  if (!input.user.id) {
    return false
  }
  try {
    await env.NOTIFICATIONS_QUEUE.send(
      {
        version: 1,
        id: crypto.randomUUID(),
        type: input.type,
        user: input.user,
        occurred_at: (input.occurredAt ?? new Date()).toISOString(),
        data: input.data ?? {},
        url: input.url ?? null,
      },
      { contentType: 'json' },
    )
    return true
  } catch (error) {
    console.error('failed to publish a notification', input.type, error)
    return false
  }
}

export { publishNotification }
export type { NotificationData, NotificationEvent, NotificationInput, NotificationType }
