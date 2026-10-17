import type { Env } from '@/env'

/**
 * Everything this Worker emails goes through here: the notice that a contract is ending, and in-app
 * support requests. Bodies come from `@franciscosolis/emails`; this only hands them to Cloudflare
 * Email Sending, from the Worker's one configured sender.
 *
 * It throws on failure. Each caller decides what a failed send means — a support request answers the
 * device with an error so it can retry, the contract notice is retried by the next cron run.
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
