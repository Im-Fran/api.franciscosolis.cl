import type { Editor } from '@/middleware/auth'

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

/**
 * The Workers AI binding, narrowed to the one method this Worker calls.
 *
 * Written out here rather than taken from `@cloudflare/workers-types`, whose types for this binding
 * have historically lagged the runtime. Every call goes through `src/services/ai.ts`, so this is
 * the complete surface.
 */
type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

type Env = {
  /** D1 database `franciscosolis_cms`. */
  DB: D1Database
  /** Cloudflare Email Sending binding, sending from the `mail.franciscosolis.cl` domain. */
  EMAIL: EmailSender
  /** Service binding to the auth Worker. Used for one thing only: reading its published JWKS. */
  AUTH: Fetcher
  /** Workers AI. Used for one thing only: drafting a translation of a prose field. */
  AI: AiBinding

  /** Path the JWKS is read from over `AUTH`. Access tokens are verified offline against it. */
  AUTH_JWKS_URL: string
  /** Expected `iss` claim of an access token. Must match the auth Worker's `AUTH_ISSUER`. */
  AUTH_ISSUER: string
  /** Comma-separated client application ids (`aud` claim) whose tokens are accepted here. */
  CMS_ALLOWED_AUDIENCES: string
  /** Comma-separated email domains allowed into the CMS. The access gate. */
  CMS_ALLOWED_EMAIL_DOMAINS: string

  MAIL_FROM_EMAIL: string
  MAIL_FROM_NAME: string
  /** Comma-separated addresses an editor may send as. Subset of `allowed_sender_addresses`. */
  MAIL_ALLOWED_SENDERS: string

  /** Workers AI text model behind the translation drafts. A var so a retired model is a deploy. */
  AI_TEXT_MODEL: string
}

/** Values `requireEditor` puts on the Hono context for downstream handlers. */
type Variables = {
  editor: Editor
}

/** Shape every Hono instance in this Worker is parameterised with. */
type AppEnv = {
  Bindings: Env
  Variables: Variables
}

export type { AiBinding, AppEnv, EmailAddress, EmailMessage, EmailSender, Env, Variables }
