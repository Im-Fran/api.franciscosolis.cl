/**
 * Lifetimes and limits for the whole auth flow, in seconds unless stated otherwise.
 *
 * The short ones are deliberately short: an authorization code only has to survive a redirect plus
 * one HTTP call, and a magic link only has to survive a trip through a mail client.
 */
const TTL = {
  /** Access token. Short enough that a revoked role takes effect quickly without a DB lookup. */
  accessToken: 15 * 60,
  /** ID token. Consumed once, right after the exchange, so it does not need to outlive the access token. */
  idToken: 15 * 60,
  /** Refresh token. Rotated on every use, so this is the idle timeout of a session. */
  refreshToken: 30 * 24 * 60 * 60,
  /** Authorization code: redirect + one immediate exchange. */
  authorizationCode: 2 * 60,
  /** Magic link: long enough to switch to a mail app, short enough to be useless once leaked. */
  magicLink: 15 * 60,
  /** Redirect to an external provider and back. */
  oauthState: 10 * 60,
  /** A parked authorization request: how long the user has to pick a provider and authenticate. */
  authorizationRequest: 30 * 60,
  /** Invitation validity. */
  invitation: 7 * 24 * 60 * 60,
  /** Default grace period given to the previous secrets of a client when one is rotated. */
  clientSecretGrace: 7 * 24 * 60 * 60,
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

/**
 * How a client proves who it is at the token endpoint.
 *
 * `none` is a public client: it holds no secret, so PKCE is the only binding between the
 * authorization code and the process that asked for it. The other two carry the same secret in a
 * different envelope — the HTTP Basic header (RFC 6749 §2.3.1, the one the spec says clients SHOULD
 * use) or the request body. Both are offered because off-the-shelf relying parties disagree about
 * which one they send, and a client is pinned to exactly one so a leaked secret cannot be replayed
 * through the other.
 */
const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const
type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number]

/** Grants the token endpoint implements. A client may only use the ones listed on its own row. */
const GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials'] as const
type GrantType = (typeof GRANT_TYPES)[number]

/** The only `response_type` this server issues. Implicit and hybrid flows are deliberately absent. */
const RESPONSE_TYPE = 'code'

/**
 * Sign-in front-end used when `AUTH_LOGIN_URL` is not set.
 *
 * This Worker is an API and renders no pages, so the one step of an OAuth flow that has to put
 * something in front of the user is delegated: `GET /oauth/authorize` parks the request and
 * redirects here with its handle. The front-end reads `GET /oauth/authorize/:handle` for the
 * client name and the providers, and drives the same endpoints from there.
 */
const DEFAULT_LOGIN_URL = 'https://franciscosolis.cl/apps/auth'

/** Slug of the global role granted to bootstrap administrators on their first sign-in. */
const ADMIN_ROLE_SLUG = 'admin'

export {
  ADMIN_ROLE_SLUG,
  CLIENT_AUTH_METHODS,
  CODE_CHALLENGE_METHOD,
  DEFAULT_LOGIN_URL,
  GRANT_TYPES,
  MAGIC_LINK_RATE_LIMIT,
  PROVIDERS,
  RESPONSE_TYPE,
  TTL,
  USER_STATUS,
}
export type { ClientAuthMethod, GrantType, ProviderName, UserStatus }
