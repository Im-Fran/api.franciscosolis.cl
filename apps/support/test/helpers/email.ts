import { env } from 'cloudflare:test'
import type { EmailMessage, EmailSender } from '@/env'

/**
 * A recorder in place of the Email Sending binding.
 *
 * Swapped in rather than stubbed at a higher level so the assertions are about what Cloudflare was
 * actually handed — the subject line, the recipient, the reply-to — and so a test can drive the
 * provider-failure path, which the real binding cannot be made to take on demand.
 */
type Recorded = EmailMessage

const captureEmail = () => {
  const sent: Recorded[] = []
  let next: { messageId: string } | Error = { messageId: '<queued@mail.franciscosolis.cl>' }

  const original = env.EMAIL
  ;(env as { EMAIL: EmailSender }).EMAIL = {
    send: async (message: EmailMessage) => {
      sent.push(message)
      if (next instanceof Error) {
        throw next
      }
      return next
    },
  }

  return {
    sent,
    /** Makes the next send — and every one after it — fail, for the retry and backoff paths. */
    failWith: (error: Error) => {
      next = error
    },
    succeedWith: (messageId: string) => {
      next = { messageId }
    },
    restore: () => {
      ;(env as { EMAIL: EmailSender }).EMAIL = original
    },
  }
}

export { captureEmail }
export type { Recorded }
