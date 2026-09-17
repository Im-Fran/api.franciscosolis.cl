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

/**
 * Permission slugs this Worker's own routes guard themselves with.
 *
 * The catalog is editable at runtime because a permission is also how another service describes a
 * capability of its own — they travel in the access token, so `apps/cms` can be given one without
 * a migration here. These are different: deleting one does not take a capability away, it
 * takes the guard off nothing and locks the administration API out of its own catalog. They are
 * refused a delete for that reason, and the list has to be kept in step with `requirePermission`.
 */
const GUARDED_PERMISSIONS = [
  'users:read',
  'users:write',
  'roles:read',
  'roles:write',
  'invitations:read',
  'invitations:write',
  'applications:read',
  'applications:write',
  'sessions:read',
  'sessions:revoke',
  'audit:read',
  'avatars:read',
  'avatars:review',
] as const

/**
 * What an uploaded avatar may be.
 *
 * The three formats are the ones every browser both encodes and renders; GIF and SVG are absent on
 * purpose — an animated avatar is a nuisance a reviewer cannot un-approve fast enough, and SVG is a
 * document with scripts in it, which is the one thing an image served from our own origin must not
 * be. The ceiling is small because this is a 512-pixel circle: anything larger is a photo that was
 * never resized, not a picture that needs the room.
 */
const AVATAR_UPLOAD = {
  maxBytes: 2 * 1024 * 1024,
  contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
  /** How long a browser may cache an approved avatar. It is immutable: a new one is a new id. */
  cacheSeconds: 365 * 24 * 60 * 60,
} as const

/**
 * Lifecycle of an uploaded avatar. `superseded` is what a row becomes when a newer upload or a
 * newer approval displaces it, which is how "one pending and one approved per user" stays true
 * without deleting the trail of what was reviewed.
 */
const AVATAR_STATUS = ['pending', 'approved', 'rejected', 'superseded'] as const
type AvatarStatus = (typeof AVATAR_STATUS)[number]

/** Slug of the global role granted to bootstrap administrators on their first sign-in. */
const ADMIN_ROLE_SLUG = 'admin'

export {
  ADMIN_ROLE_SLUG,
  AVATAR_STATUS,
  AVATAR_UPLOAD,
  CLIENT_AUTH_METHODS,
  CODE_CHALLENGE_METHOD,
  DEFAULT_LOGIN_URL,
  GRANT_TYPES,
  GUARDED_PERMISSIONS,
  MAGIC_LINK_RATE_LIMIT,
  PROVIDERS,
  RESPONSE_TYPE,
  TTL,
  USER_STATUS,
}
export type { AvatarStatus, ClientAuthMethod, GrantType, ProviderName, UserStatus }
