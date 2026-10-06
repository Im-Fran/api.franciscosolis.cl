import type { AccessTokenClaims } from '@/lib/jwks'

/**
 * Cloudflare Email Sending binding (`send_email` in wrangler.jsonc). Declared locally for the same
 * reason as every other Worker here: the shipped `SendEmail` type still describes the older raw-MIME
 * Email Routing binding rather than the structured `send()` of Email Sending.
 */
type EmailAddress = {
  email: string
  name?: string
}

type EmailMessage = {
  from: EmailAddress
  to: string[]
  subject: string
  html?: string
  text?: string
  headers?: Record<string, string>
}

type EmailSender = {
  send(message: EmailMessage): Promise<{ messageId: string }>
}

type Env = {
  DB: D1Database
  /** Only ever asked for the JWKS. See `src/lib/jwks.ts` for why it is a binding and not a fetch. */
  AUTH: Fetcher
  EMAIL: EmailSender

  AUTH_JWKS_URL: string
  AUTH_ISSUER: string
  /** Comma-separated client application ids whose tokens may read an inbox. */
  NOTIFICATIONS_ALLOWED_AUDIENCES: string
  /** Origin every notification path is resolved against, without a trailing slash. */
  SITE_URL: string
  /** `sub` claim of the VAPID JWT: a `mailto:` or `https:` contact for the push services. */
  VAPID_SUBJECT: string
  MAIL_FROM_EMAIL: string
  MAIL_FROM_NAME: string

  /**
   * The VAPID key pair as a P-256 private JWK (`d`, `x`, `y`). Secret, per environment.
   *
   * One secret rather than a secret plus a public-key var: the JWK already carries the public
   * point, so the public half is derived from it and the two can never be set out of step. Unset
   * means push is off — `GET /` advertises `vapid_public_key: null` and the website hides the
   * switch — rather than every delivery failing.
   */
  VAPID_PRIVATE_KEY?: string
}

/** The account a request is acting for, set on the context by `requireUser`. */
type User = {
  id: string
  email: string | null
  name: string | null
  claims: AccessTokenClaims
}

type Variables = {
  user: User
}

type AppEnv = {
  Bindings: Env
  Variables: Variables
}

export type { AppEnv, EmailAddress, EmailMessage, EmailSender, Env, User, Variables }
