import { env } from 'cloudflare:test'

/**
 * The `EMAIL` binding, replaced by assignment with one that records what was sent — the same move
 * `apps/marketplace` makes. `failEmail()` makes the next sends throw, for the paths that must
 * survive a mail outage.
 */
type SentEmail = { from: { email: string; name?: string }; to: string[]; subject: string; html: string; text: string; replyTo?: string }

let sent: SentEmail[] = []
let failing = false

const captureEmail = () => {
  sent = []
  failing = false
  ;(env as { EMAIL: SendEmail }).EMAIL = {
    send: async (message: SentEmail) => {
      if (failing) throw new Error('email binding failure (test)')
      sent.push(structuredClone(message))
      return { messageId: `test-${sent.length}` }
    },
  } as unknown as SendEmail
}

const sentEmails = () => sent
const failEmail = (value = true) => {
  failing = value
}

export { captureEmail, failEmail, sentEmails }
export type { SentEmail }
