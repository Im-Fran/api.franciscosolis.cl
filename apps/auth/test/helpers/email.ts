import { env } from 'cloudflare:test'
import type { EmailMessage } from '@/env'

/**
 * Captures what the Worker hands to the Cloudflare Email Sending binding.
 *
 * The binding does work under miniflare — it writes the message to a temp file and returns a
 * message id — but the magic link token only ever exists inside the email body, so the tests need
 * the message object itself rather than a side effect on disk.
 */
const captureEmails = () => {
  const sent: EmailMessage[] = []
  const original = env.EMAIL.send

  env.EMAIL.send = async (message: EmailMessage) => {
    sent.push(message)
    return { messageId: `test-${sent.length}` }
  }

  return {
    sent,
    /** The last message, or a clear failure instead of `undefined` sneaking into an assertion. */
    last(): EmailMessage {
      const message = sent.at(-1)
      if (!message) {
        throw new Error('no email was sent')
      }
      return message
    },
    restore() {
      env.EMAIL.send = original
    },
  }
}

/** Makes `env.EMAIL.send` reject, to exercise the paths that run before or after delivery. */
const failEmails = (message = 'delivery failed') => {
  const original = env.EMAIL.send
  env.EMAIL.send = async () => {
    throw new Error(message)
  }
  return { restore: () => { env.EMAIL.send = original } }
}

/** Pulls the callback URL out of the plain-text part of an email. */
const linkFrom = (message: EmailMessage): URL => {
  const match = /https?:\/\/\S+/.exec(message.text ?? '')
  if (!match) {
    throw new Error('the email carries no link')
  }
  return new URL(match[0])
}

const magicLinkTokenFrom = (message: EmailMessage): string => {
  const token = linkFrom(message).searchParams.get('token')
  if (!token) {
    throw new Error('the magic link carries no token')
  }
  return token
}

export { captureEmails, failEmails, linkFrom, magicLinkTokenFrom }
