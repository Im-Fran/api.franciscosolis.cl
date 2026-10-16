import { env } from 'cloudflare:test'
import type { NotificationEvent } from '@/services/notify'

/**
 * The notifications queue, replaced by assignment with one that records what was published — the
 * same move `auth` and `marketplace` make. Its consumer is `apps/notifications`, which this suite
 * does not run, so the capture is the only place a published alert can be read back from.
 */
let published: NotificationEvent[] = []

const captureNotifications = () => {
  published = []
  ;(env as { NOTIFICATIONS_QUEUE: Queue<NotificationEvent> }).NOTIFICATIONS_QUEUE = {
    send: async (message: NotificationEvent) => {
      published.push(structuredClone(message))
    },
    sendBatch: async (messages: Iterable<MessageSendRequest<NotificationEvent>>) => {
      for (const message of messages) published.push(structuredClone(message.body))
    },
  } as unknown as Queue<NotificationEvent>
  return published
}

const publishedNotifications = () => published

export { captureNotifications, publishedNotifications }
