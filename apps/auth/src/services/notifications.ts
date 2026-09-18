import type { AccountAccessEvent } from '@franciscosolis/emails'
import type { Env } from '@/env'
import type { ProviderName } from '@/lib/config'
import { describeUserAgent } from '@/lib/user-agent'
import { PROVIDER_REGISTRY } from '@/providers'
import { accountAccessTemplate, sendEmail } from '@/services/email'
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
const formatTimestamp = (date: Date) => {
  const formatted = new Intl.DateTimeFormat('en-GB', {
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
 * Emails the notice, and never throws.
 *
 * A notification that could not be delivered must not turn a completed sign-in into a 500 — the user
 * is mid-redirect with a valid authorization code by the time this runs, and failing here would lose
 * it. Same reasoning as `recordAudit`: this is a report about the flow, not a step of it.
 *
 * It is awaited rather than handed to `waitUntil` so that a delivery failure is logged against the
 * request that caused it, and because the Worker already blocks on an email send in the magic link
 * path — one binding call is not what makes a redirect slow.
 */
const notifyAccountAccess = async (env: Env, input: AccountAccessNotification) => {
  try {
    await sendEmail(
      env,
      input.user.email,
      await accountAccessTemplate({
        event: input.event,
        applicationName: input.applicationName,
        providerName: providerDisplayName(input.provider),
        occurredAt: formatTimestamp(input.occurredAt),
        device: describeUserAgent(input.userAgent),
        location: formatLocation({ country: input.country, city: input.city }),
        ipAddress: input.ip,
        brandName: env.MAIL_FROM_NAME,
      }),
    )
  } catch (error) {
    console.error('failed to send the account access notification', input.event, error)
  }
}

export { formatLocation, formatTimestamp, notifyAccountAccess, providerDisplayName }
export type { AccountAccessNotification }
