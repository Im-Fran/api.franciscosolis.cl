import type { Env } from '@/env'

/**
 * Everything this Worker emails goes through here: the notice to a client that a contract is ending,
 * and the mail around a scheduled maintenance — the approval request, the confirmation, the reminder,
 * and how it ended. The body comes from `@franciscosolis/emails`; this only hands it to Cloudflare
 * Email Sending, from the Worker's one configured sender.
 *
 * It throws on failure; each caller decides what a failure means (the cron leaves a contract notice
 * unsent so its next run retries).
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

const SANTIAGO = 'America/Santiago'

const dateFormat = (locale: 'en' | 'es') =>
  new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: SANTIAGO })
const timeFormat = (locale: 'en' | 'es') => new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: SANTIAGO })

/** An instant as the recipient reads it, on Santiago's clock: "martes, 3 de noviembre de 2026, 02:00". */
const formatMailInstant = (date: Date, locale: 'en' | 'es') => `${dateFormat(locale).format(date)}, ${timeFormat(locale).format(date)}`

/**
 * A window on Santiago's clock, saying so: "martes, 3 de noviembre de 2026, 02:00–04:00 (hora de
 * Santiago)", or both ends in full when it runs past midnight.
 */
const formatMailWindow = (start: Date, end: Date, locale: 'en' | 'es') => {
  const zone = locale === 'es' ? '(hora de Santiago)' : '(Santiago time)'
  const sameDay = dateFormat(locale).format(start) === dateFormat(locale).format(end)
  return sameDay
    ? `${formatMailInstant(start, locale)}–${timeFormat(locale).format(end)} ${zone}`
    : `${formatMailInstant(start, locale)} – ${formatMailInstant(end, locale)} ${zone}`
}

/** Just the time of day on Santiago's clock, "04:00". */
const formatMailTime = (date: Date, locale: 'en' | 'es') => timeFormat(locale).format(date)

export { formatMailDay, formatMailInstant, formatMailTime, formatMailWindow, sendMail }
export type { OutgoingEmail }
