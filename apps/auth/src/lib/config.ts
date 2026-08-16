/**
 * Lifetimes and limits for the whole auth flow, in seconds unless stated otherwise.
 *
 * The short ones are deliberately short: an authorization code only has to survive a redirect plus
 * one HTTP call, and a magic link only has to survive a trip through a mail client.
 */
const TTL = {
  /** Access token. Short enough that a revoked role takes effect quickly without a DB lookup. */
  accessToken: 15 * 60,
  /** Refresh token. Rotated on every use, so this is the idle timeout of a session. */
  refreshToken: 30 * 24 * 60 * 60,
  /** Authorization code: redirect + one immediate exchange. */
  authorizationCode: 2 * 60,
  /** Magic link: long enough to switch to a mail app, short enough to be useless once leaked. */
  magicLink: 15 * 60,
  /** Redirect to an external provider and back. */
  oauthState: 10 * 60,
  /** Invitation validity. */
  invitation: 7 * 24 * 60 * 60,
} as const

/** Throttling for magic link requests, applied per email address. */
const MAGIC_LINK_RATE_LIMIT = {
  /** Requests allowed inside the window before the endpoint starts refusing. */
  max: 5,
  windowSeconds: 15 * 60,
} as const

/** Providers this Worker can authenticate with. Stored verbatim in `identities.provider`. */
const PROVIDERS = ['magic_link', 'google'] as const
type ProviderName = (typeof PROVIDERS)[number]

/** Only S256 is accepted; `plain` offers no protection against an intercepted authorization code. */
const CODE_CHALLENGE_METHOD = 'S256'

const USER_STATUS = ['active', 'disabled'] as const
type UserStatus = (typeof USER_STATUS)[number]

/** Slug of the global role granted to bootstrap administrators on their first sign-in. */
const ADMIN_ROLE_SLUG = 'admin'

export { ADMIN_ROLE_SLUG, CODE_CHALLENGE_METHOD, MAGIC_LINK_RATE_LIMIT, PROVIDERS, TTL, USER_STATUS }
export type { ProviderName, UserStatus }
