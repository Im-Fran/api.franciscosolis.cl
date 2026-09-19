import type { Account } from '@/middleware/account'
import type { Editor } from '@/middleware/auth'

type Env = {
  /** D1 database `franciscosolis_pages`. */
  DB: D1Database
  /** Service binding to the auth Worker. Used for one thing only: reading its published JWKS. */
  AUTH: Fetcher
  /** R2 bucket `franciscosolis-app-releases`: the downloadable builds. No public access of its own. */
  RELEASES: R2Bucket

  /** Path the JWKS is read from over `AUTH`. Access tokens are verified offline against it. */
  AUTH_JWKS_URL: string
  /** Expected `iss` claim of an access token. Must match the auth Worker's `AUTH_ISSUER`. */
  AUTH_ISSUER: string
  /** Comma-separated client application ids (`aud` claim) whose tokens are accepted here. */
  PAGES_ALLOWED_AUDIENCES: string
  /** Comma-separated email domains allowed to edit. The access gate. */
  PAGES_ALLOWED_EMAIL_DOMAINS: string
  /**
   * Comma-separated client application ids whose tokens identify a *buyer* rather than an editor.
   *
   * Deliberately a second list rather than an addition to `PAGES_ALLOWED_AUDIENCES`, for the same
   * reason `apps/support` keeps two: merging them would leave the email-domain check as the only
   * thing keeping a website token out of `/admin`. This list is wider — it is the public website —
   * and the routes it opens are a person's own purchases and their own downloads, nothing else.
   */
  PAGES_ACCOUNT_AUDIENCES: string

  /** Public base URL of this Worker through the gateway. What MercadoPago is told to notify. */
  PAGES_PUBLIC_URL: string
  /** Base URL of the website the buyer is returned to after checkout. */
  SITE_BASE_URL: string

  /**
   * MercadoPago private access token. The credential that creates preferences and reads payments;
   * without it checkout answers 503 rather than pretending to work.
   */
  MERCADOPAGO_ACCESS_TOKEN: string
  /** Webhook signing secret from the MercadoPago dashboard. Notifications are refused without it. */
  MERCADOPAGO_WEBHOOK_SECRET: string
  /** HMAC key the download tickets in `src/lib/downloads.ts` are signed with. */
  DOWNLOAD_SIGNING_KEY: string
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

export type { AppEnv, Env, Variables }
