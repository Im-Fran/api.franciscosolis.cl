import type { Env } from '@/env'

/**
 * Everything this Worker emails goes through here — which is one message: the notice to a client that
 * a contract is ending. The body comes from `@franciscosolis/emails`; this only hands it to
 * Cloudflare Email Sending, from the Worker's one configured sender.
 *
 * It throws on failure, and the cron leaves the notice unsent so its next run retries.
 */

type OutgoingEmail = {
  to: string[]
  subject: string
  html: string
  text: string
  replyTo?: string | null
}

const sendMail = (env: Env, message: OutgoingEmail) =>
  env.EMAIL.send({
    from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  })

/** A Santiago calendar day (`YYYY-MM-DD`) as the recipient's language writes it. */
const formatMailDay = (day: string, locale: 'en' | 'es') => {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  // Noon UTC is the same calendar day in Santiago whatever the offset, so no time zone shifts it.
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, date, 12)),
  )
}

export { formatMailDay, sendMail }
export type { OutgoingEmail }
