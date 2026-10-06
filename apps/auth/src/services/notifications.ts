import { resolveEmailLocale } from '@franciscosolis/emails'
import type { AccountAccessEvent, EmailLocale } from '@franciscosolis/emails'
import type { Env } from '@/env'
import type { ProviderName } from '@/lib/config'
import { describeUserAgent } from '@/lib/user-agent'
import { PROVIDER_REGISTRY } from '@/providers'
import { accountAccessTemplate, sendEmail } from '@/services/email'
import { publishNotification } from '@/services/notify'
import type { User } from '@/services/users'

/**
 * Telling an account holder that their account was just used.
 *
 * Two things reach an application: a fresh sign-in, and an authorization granted from the browser's
 * existing SSO session — the "Authorize" button, or `prompt=none` answered straight away. The second
 * one is the reason this exists at all. It needs no credential and produces no email of its own, so
 * without a notice the only record that a new application was let in would be an audit row the user
 * cannot see.
 */

/**
 * The timestamp, in UTC and spelled out.
 *
 * UTC rather than the account's own zone because there is nothing here that knows one: `users.locale`
 * is a language, not a region, and a wrong zone in a security notice is worse than an explicit one —
 * a reader comparing "was I awake then" needs to know which clock they are reading.
 */
const formatTimestamp = (date: Date, locale: EmailLocale = 'en') => {
  const formatted = new Intl.DateTimeFormat(locale === 'es' ? 'es-CL' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)
  return `${formatted} UTC`
}

/**
 * City and country as one line.
 *
 * The country arrives as an ISO 3166-1 alpha-2 code from Cloudflare's edge, which is not what
 * somebody scanning an email recognises, so it is expanded where the runtime can — `Intl.DisplayNames`
 * is present in `workerd`. Two of its answers are deliberately not used: `fallback: 'code'` hands
 * back an unassigned code as itself rather than inventing a name for it, and `Unknown Region`, which
 * CLDR really does return for `ZZ`, is worse than the code in a line a reader is checking against
 * their own memory. A structurally invalid code throws, and is caught for the same reason.
 */
const UNKNOWN_REGION_NAME = 'Unknown Region'

const formatLocation = (location: { country: string | null; city: string | null }) => {
  if (!location.country && !location.city) {
    return null
  }

  let country = location.country
  if (country) {
    try {
      const name = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }).of(country)
      country = !name || name === UNKNOWN_REGION_NAME ? country : name
    } catch {
      // A code that is not even shaped like a region: keep what the edge sent.
    }
  }

  return [location.city, country].filter(Boolean).join(', ')
}

/**
 * Where a notice about access points on the website: the page listing the account's sessions, which
 * is also where somebody who does not recognise one goes to close it.
 */
const ACCOUNT_SESSIONS_PATH = '/account/sessions'

/** How the user proved who they were, as the sign-in screen names it. */
const providerDisplayName = (provider: string) =>
  PROVIDER_REGISTRY.find((descriptor) => descriptor.name === provider)?.displayName ?? provider

type AccountAccessNotification = {
  event: AccountAccessEvent
  user: User
  applicationName: string
  provider: ProviderName | string
  /** When the access happened. For a sign-in that is the authentication, not the moment this runs. */
  occurredAt: Date
  ip: string | null
  userAgent: string | null
  country: string | null
  city: string | null
}

/**
 * The notice itself, delivered by `apps/notifications` when the queue takes it and by this Worker
 * when it does not. Never throws.
 *
 * Handing it to the notifications Worker is what lets the account holder choose how they hear about
 * it — straight away, in a daily or weekly digest, or only in the site's notification list — instead
 * of every sign-in being an email whether they want one or not. The details are rendered here rather
 * than there because this is the only place that has the raw request: the consumer receives
 * "Chrome on macOS" and "Santiago, Chile", the same strings the email always carried, and never a
 * user agent or a country code it would have to learn to format the same way.
 *
 * **The email is the fallback, not a second copy.** A security notice is the one notification here
 * that must not be lost to an outage, so when the queue refuses the event the notice goes out the
 * way it always did. When the queue accepts it, it is not also emailed from here: the consumer owns
 * that decision, and doing both would mean somebody who picked "weekly" still gets an email per
 * sign-in. The residual gap — the queue accepted it and the consumer then failed on every retry — is
 * logged by the consumer, and it is the trade a queue is for: five retries with backoff against an
 * email that was attempted exactly once.
 *
 * A notification that could not be delivered must not turn a completed sign-in into a 500 — the user
 * is mid-redirect with a valid authorization code by the time this runs, and failing here would lose
 * it. Same reasoning as `recordAudit`: this is a report about the flow, not a step of it.
 *
 * It is awaited rather than handed to `waitUntil` so that a failure is logged against the request
 * that caused it, and because the Worker already blocks on an email send in the magic link path —
 * one binding call is not what makes a redirect slow.
 */
const notifyAccountAccess = async (env: Env, input: AccountAccessNotification) => {
  const providerName = providerDisplayName(input.provider)
  const device = describeUserAgent(input.userAgent)
  const location = formatLocation({ country: input.country, city: input.city })

  const queued = await publishNotification(env, {
    type: input.event === 'sign_in' ? 'account.sign_in' : 'account.authorization',
    user: { id: input.user.id, email: input.user.email, name: input.user.name, locale: input.user.locale },
    occurredAt: input.occurredAt,
    // Nulls rather than "Unknown": the consumer localises the placeholder, and "Unknown" is English.
    data: {
      application_name: input.applicationName,
      provider_name: providerName,
      device,
      location,
      ip_address: input.ip,
    },
    url: ACCOUNT_SESSIONS_PATH,
  })
  if (queued) {
    return
  }

  const locale = resolveEmailLocale(input.user.locale)
  try {
    await sendEmail(
      env,
      input.user.email,
      await accountAccessTemplate({
        event: input.event,
        applicationName: input.applicationName,
        providerName,
        occurredAt: formatTimestamp(input.occurredAt, locale),
        device,
        location,
        ipAddress: input.ip,
        locale,
        brandName: env.MAIL_FROM_NAME,
      }),
    )
  } catch (error) {
    console.error('failed to send the account access notification', input.event, error)
  }
}

export { formatLocation, formatTimestamp, notifyAccountAccess, providerDisplayName }
export type { AccountAccessNotification }
