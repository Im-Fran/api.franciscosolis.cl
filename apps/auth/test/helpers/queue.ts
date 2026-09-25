import { env } from 'cloudflare:test'
import type { NotificationEvent } from '@/services/notify'

/**
 * Captures what the Worker publishes onto the notifications queue.
 *
 * Miniflare does simulate the producer binding declared in `wrangler.jsonc`, but this Worker is not
 * the consumer, so a message sent there goes nowhere a test can read it back from. Replacing the
 * binding by assignment is the same move `captureEmails` makes with `EMAIL`, and it reaches the
 * Worker behind `SELF` for the same reason: both run in this isolate and read the same `env`.
 *
 * The replacement is a whole object rather than a patched `send`, so `sendBatch` is covered too and
 * nothing a test forgot to stub can reach the simulated binding and pass by saying nothing.
 */
const captureNotifications = () => {
  const sent: NotificationEvent[] = []
  const mutable = env as unknown as Record<string, unknown>
  const original = mutable.NOTIFICATIONS_QUEUE

  mutable.NOTIFICATIONS_QUEUE = {
    async send(message: NotificationEvent) {
      sent.push(message)
    },
    async sendBatch(messages: Iterable<{ body: NotificationEvent }>) {
      for (const message of messages) {
        sent.push(message.body)
      }
    },
  }

  return {
    sent,
    /** Every event of one type, oldest first. */
    ofType(type: NotificationEvent['type']) {
      return sent.filter((event) => event.type === type)
    },
    restore() {
      mutable.NOTIFICATIONS_QUEUE = original
    },
  }
}

/** Makes every publish reject, which is what an unreachable queue looks like to the producer. */
const failNotifications = (message = 'queue unavailable') => {
  const mutable = env as unknown as Record<string, unknown>
  const original = mutable.NOTIFICATIONS_QUEUE
  const reject = async () => {
    throw new Error(message)
  }
  mutable.NOTIFICATIONS_QUEUE = { send: reject, sendBatch: reject }
  return {
    restore: () => {
      mutable.NOTIFICATIONS_QUEUE = original
    },
  }
}

export { captureNotifications, failNotifications }
