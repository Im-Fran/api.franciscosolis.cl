import type { AuthenticatedActor } from '@/middleware/auth'

/** One recipient/sender of an email sent through Cloudflare Email Sending. */
type EmailAddress = {
  email: string
  name?: string
}

type EmailMessage = {
  to: string | EmailAddress | (string | EmailAddress)[]
  from: string | EmailAddress
  subject: string
  html?: string
  text?: string
  replyTo?: string | EmailAddress
  headers?: Record<string, string>
}

/**
 * Cloudflare Email Sending binding (`send_email` in wrangler.jsonc). Declared locally instead of
 * relying on `@cloudflare/workers-types`, whose `SendEmail` type still describes the older
 * raw-MIME Email Routing binding rather than the structured `send()` of Email Sending.
 */
type EmailSender = {
  send(message: EmailMessage): Promise<{ messageId: string }>
}

type Env = {
  /** D1 database `franciscosolis_auth`. */
  DB: D1Database
  /** Cloudflare Email Sending binding used for magic links and invitations. */
  EMAIL: EmailSender

  /** Public base URL of this Worker, e.g. `https://api.franciscosolis.cl/auth`. No trailing slash. */
  AUTH_PUBLIC_URL: string
  /**
   * Sign-in front-end `GET /oauth/authorize` hands the user to, with the parked request's handle
   * appended as `?request=`. This Worker renders no pages, so there is no in-Worker fallback:
   * unset means `DEFAULT_LOGIN_URL` from `lib/config.ts`.
   */
  AUTH_LOGIN_URL?: string
  /** Value of the `iss` claim on every access token. */
  AUTH_ISSUER: string
  MAIL_FROM_EMAIL: string
  MAIL_FROM_NAME: string

  /** Ed25519 private key as a JWK JSON string. Secret. */
  JWT_PRIVATE_KEY: string
  /** Optional JSON array of retired public JWKs still published in the JWKS after a rotation. */
  JWT_RETIRED_PUBLIC_KEYS?: string

  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

/** Values `requireAuth` puts on the Hono context for downstream handlers. */
type Variables = {
  actor: AuthenticatedActor
}

/** Shape every Hono instance in this Worker is parameterised with. */
type AppEnv = {
  Bindings: Env
  Variables: Variables
}

export type { AppEnv, EmailAddress, EmailMessage, EmailSender, Env, Variables }
