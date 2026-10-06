import type { RenderedEmail } from '@franciscosolis/emails'
import {
  renderAccountAccessEmail,
  renderNotificationDigestEmail,
  renderNotificationEmail,
  resolveEmailLocale,
} from '@franciscosolis/emails'
import type { DigestItem, DigestPeriod } from '@franciscosolis/emails'
import type { Env } from '@/env'
import type { Copy, NotificationData, NotificationType } from '@/lib/catalog'
import type { Locale } from '@/lib/config'

/** Where somebody changes how often they hear from us. Every email this Worker sends links to it. */
const PREFERENCES_PATH = '/account/notifications'

/**
 * Resolves a notification path against the website. Producers only ever send a path, and a value
 * that is not one (an absolute URL, a protocol-relative `//host`) is dropped rather than followed:
 * an email or a push is exactly where an open redirect would be most convincing.
 */
const siteUrl = (env: Env, path: string | null | undefined): string | null => {
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    return null
  }
  return `${env.SITE_URL.replace(/\/+$/, '')}${path}`
}

const sendRendered = async (env: Env, to: string, rendered: RenderedEmail) =>
  env.EMAIL.send({
    from: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
    to: [to],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  })

const text = (value: NotificationData[string] | undefined) =>
  value === null || value === undefined || value === '' ? null : String(value)

/**
 * The timestamp on an account-access notice, spelled out in UTC. Same format `apps/auth` used when
 * it sent this notice itself, and for the same reason: a reader checking "was that me" needs to know
 * which clock they are reading.
 */
const formatUtc = (date: Date, locale: Locale) =>
  `${new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`

type ImmediateInput = {
  to: string
  type: NotificationType
  data: NotificationData
  url: string | null
  copy: Copy
  locale: Locale
  occurredAt: Date
}

/**
 * One notification, now, for somebody whose frequency is `immediate`.
 *
 * The account-access notice keeps the template it always had — the detailed security notice, with
 * the device, the location and the IP laid out — because this Worker took over *sending* it, not
 * deciding what it says. Everything else goes out through the generic template with the catalog's
 * text.
 */
const sendImmediate = async (env: Env, input: ImmediateInput) => {
  if (input.type === 'account.sign_in' || input.type === 'account.authorization') {
    return sendRendered(
      env,
      input.to,
      await renderAccountAccessEmail({
        event: input.type === 'account.sign_in' ? 'sign_in' : 'authorization',
        applicationName: text(input.data.application_name) ?? '—',
        providerName: text(input.data.provider_name) ?? '—',
        occurredAt: formatUtc(input.occurredAt, input.locale),
        device: text(input.data.device),
        location: text(input.data.location),
        ipAddress: text(input.data.ip_address),
        locale: resolveEmailLocale(input.locale),
        brandName: env.MAIL_FROM_NAME,
      }),
    )
  }

  return sendRendered(
    env,
    input.to,
    await renderNotificationEmail({
      title: input.copy.title,
      body: input.copy.body,
      url: siteUrl(env, input.url),
      preferencesUrl: siteUrl(env, PREFERENCES_PATH)!,
      locale: resolveEmailLocale(input.locale),
      brandName: env.MAIL_FROM_NAME,
    }),
  )
}

type DigestInput = {
  to: string
  period: DigestPeriod
  items: DigestItem[]
  moreCount: number
  locale: Locale
}

const sendDigest = async (env: Env, input: DigestInput) =>
  sendRendered(
    env,
    input.to,
    await renderNotificationDigestEmail({
      period: input.period,
      items: input.items,
      moreCount: input.moreCount,
      inboxUrl: siteUrl(env, PREFERENCES_PATH)!,
      preferencesUrl: siteUrl(env, PREFERENCES_PATH)!,
      locale: resolveEmailLocale(input.locale),
      brandName: env.MAIL_FROM_NAME,
    }),
  )

export { PREFERENCES_PATH, sendDigest, sendImmediate, siteUrl }
export type { DigestInput, ImmediateInput }
