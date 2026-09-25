import type { Account } from '@/middleware/account'
import type { Editor } from '@/middleware/auth'
import type { NotificationEvent } from '@/services/notify'

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
 * Cloudflare Email Sending binding (`send_email` in wrangler.jsonc). Declared locally for the same
 * reason `apps/cms` declares it: `@cloudflare/workers-types`' `SendEmail` still describes the older
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
  /** D1 database `franciscosolis_marketplace`. */
  DB: D1Database
  /** Service binding to the auth Worker. Used for one thing only: reading its published JWKS. */
  AUTH: Fetcher
  /** Workers AI. Used for one thing only: drafting a translation of a prose field. */
  AI: AiBinding
  /** R2 bucket `franciscosolis-app-releases`: the downloadable builds. No public access of its own. */
  RELEASES: R2Bucket
  /**
   * Cloudflare Email Sending binding, used for exactly one thing: the voucher.
   *
   * A sale that nobody can produce a receipt for is a support conversation with no evidence in it,
   * and for a cash or transfer sale the receipt is the *only* record the buyer ever gets. It is a
   * send-only binding — this Worker has no inbound mail and must not grow any; correspondence is
   * `apps/support`'s job and a ticket is where a reply belongs.
   */
  EMAIL: EmailSender
  /**
   * Producer half of the notifications queue, drained by `apps/notifications`. The shipped `Queue`
   * type describes this binding accurately, unlike `EMAIL`'s, so it is used as is — narrowed to the
   * one message shape the contract allows. Only `services/notify.ts` touches it.
   */
  NOTIFICATIONS_QUEUE: Queue<NotificationEvent>

  /** Path the JWKS is read from over `AUTH`. Access tokens are verified offline against it. */
  AUTH_JWKS_URL: string
  /** Expected `iss` claim of an access token. Must match the auth Worker's `AUTH_ISSUER`. */
  AUTH_ISSUER: string
  /** Comma-separated client application ids (`aud` claim) whose tokens are accepted here. */
  MARKETPLACE_ALLOWED_AUDIENCES: string
  /** Comma-separated email domains allowed to edit. The access gate. */
  MARKETPLACE_ALLOWED_EMAIL_DOMAINS: string
  /**
   * Comma-separated client application ids whose tokens identify a *buyer* rather than an editor.
   *
   * Deliberately a second list rather than an addition to `MARKETPLACE_ALLOWED_AUDIENCES`, for the same
   * reason `apps/support` keeps two: merging them would leave the email-domain check as the only
   * thing keeping a website token out of `/admin`. This list is wider — it is the public website —
   * and the routes it opens are a person's own purchases and their own downloads, nothing else.
   */
  MARKETPLACE_ACCOUNT_AUDIENCES: string

  /** Public base URL of this Worker through the gateway. What MercadoPago is told to notify. */
  MARKETPLACE_PUBLIC_URL: string
  /** Base URL of the website the buyer is returned to after checkout. */
  SITE_BASE_URL: string

  /** Address vouchers and refund notices are sent from. Must be one Cloudflare will accept. */
  MAIL_FROM_EMAIL: string
  /** Display name beside it, and the name the email footer signs off with. */
  MAIL_FROM_NAME: string

  /**
   * MercadoPago private access token. The credential that creates preferences and reads payments;
   * without it checkout answers 503 rather than pretending to work.
   */
  MERCADOPAGO_ACCESS_TOKEN: string
  /** Webhook signing secret from the MercadoPago dashboard. Notifications are refused without it. */
  MERCADOPAGO_WEBHOOK_SECRET: string
  /**
   * Which MercadoPago account this Worker is configured against: `live` or `sandbox`.
   *
   * `sandbox` on the development stack, `live` in production. It decides which checkout URL a
   * created preference is answered with, and it is stamped onto every purchase — so a payment taken
   * against the test account can never be mistaken for revenue, and a refund knows which account to
   * ask. Unset reads as `sandbox`, which is the side that cannot take real money.
   */
  MERCADOPAGO_ENVIRONMENT: string
  /** HMAC key the download tickets in `src/lib/downloads.ts` are signed with. */
  DOWNLOAD_SIGNING_KEY: string

  /** Workers AI text model behind the translation drafts. A var so a retired model is a deploy. */
  AI_TEXT_MODEL: string
}

/** Values the auth middlewares put on the Hono context for downstream handlers. */
type Variables = {
  editor: Editor
  /**
   * Set by `requireAccount`, and by `optionalAccount` when a usable buyer token was sent.
   *
   * Typed as possibly absent because of the second one: a download route runs for a signed-out
   * visitor too, and a non-optional type here would have every handler reading an `Account` that is
   * not there.
   */
  account: Account | undefined
}

/** Shape every Hono instance in this Worker is parameterised with. */
type AppEnv = {
  Bindings: Env
  Variables: Variables
}

export type { AiBinding, AppEnv, EmailAddress, EmailMessage, EmailSender, Env, Variables }
