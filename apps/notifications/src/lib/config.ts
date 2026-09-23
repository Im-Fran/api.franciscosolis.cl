/**
 * The vocabularies and limits of the notifications service, in one place so the root route can
 * advertise them and the website builds its filters and its preferences form from the service
 * rather than from a copy that drifts.
 */

/** Seconds the JWKS is cached per isolate. Same value as every other consumer of the key set. */
const JWKS_CACHE_TTL = 3600

/**
 * The three things a notification can be about. A category is the unit of preference: somebody can
 * turn push off for the marketplace and keep it for their account, but not per individual type —
 * ten switches nobody understands are worse than three they do.
 */
const CATEGORIES = ['account', 'support', 'marketplace'] as const
type Category = (typeof CATEGORIES)[number]

/**
 * How often somebody wants email about what they were notified of.
 *
 * `daily` is the default, and deliberately so: the whole point of this Worker is to send less mail,
 * and a daily digest is the smallest change that still tells somebody about a sign-in they did not
 * make within a day. `weekly` would leave a security notice a week late for anybody who never
 * visited the preferences page.
 */
const EMAIL_FREQUENCIES = ['immediate', 'daily', 'weekly', 'never'] as const
type EmailFrequency = (typeof EMAIL_FREQUENCIES)[number]
const DEFAULT_EMAIL_FREQUENCY: EmailFrequency = 'daily'

/**
 * When digests go out: at `hour` in `timeZone`, daily; and on `weeklyDay` at the same hour, weekly.
 *
 * Santiago's wall clock rather than UTC, because the people reading these are there and Chile moves
 * its clocks twice a year. `weeklyDay` is the `Intl` short weekday name, which is what
 * `src/lib/time.ts` compares against.
 */
const DIGEST = {
  timeZone: 'America/Santiago',
  hour: 9,
  weeklyDay: 'Mon',
  /** Most notifications listed in one digest; the rest are summarised as a count and a link. */
  maxItems: 20,
  /** Recipients handled per cron run and per statement batch. */
  batchSize: 50,
} as const

const LOCALES = ['en', 'es'] as const
type Locale = (typeof LOCALES)[number]
const DEFAULT_LOCALE: Locale = 'en'

const PAGINATION = {
  defaultLimit: 20,
  maxLimit: 50,
} as const

const PUSH = {
  /**
   * Seconds a push service may hold a message for a device that is offline. A day: a notification
   * is still in the inbox after that, and a sign-in notice that turns up on a phone three days late
   * is noise rather than news.
   */
  ttl: 86_400,
  /** Registered devices per account. Beyond this the oldest is dropped rather than refusing a new one. */
  maxSubscriptionsPerUser: 10,
  /**
   * Consecutive failures (other than a definitive 404/410) before a subscription is dropped. A push
   * service that answers 5xx for a while is having a bad day; one that does it ten times running is
   * not coming back for that endpoint.
   */
  maxFailures: 10,
  /** Lifetime of the VAPID JWT. RFC 8292 caps it at 24 hours; twelve leaves slack for clock skew. */
  jwtLifetime: 12 * 3600,
} as const

export {
  CATEGORIES,
  DEFAULT_EMAIL_FREQUENCY,
  DEFAULT_LOCALE,
  DIGEST,
  EMAIL_FREQUENCIES,
  JWKS_CACHE_TTL,
  LOCALES,
  PAGINATION,
  PUSH,
}
export type { Category, EmailFrequency, Locale }
