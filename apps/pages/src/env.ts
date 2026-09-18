import type { Editor } from '@/middleware/auth'

type Env = {
  /** D1 database `franciscosolis_pages`. */
  DB: D1Database
  /** Service binding to the auth Worker. Used for one thing only: reading its published JWKS. */
  AUTH: Fetcher

  /** Path the JWKS is read from over `AUTH`. Access tokens are verified offline against it. */
  AUTH_JWKS_URL: string
  /** Expected `iss` claim of an access token. Must match the auth Worker's `AUTH_ISSUER`. */
  AUTH_ISSUER: string
  /** Comma-separated client application ids (`aud` claim) whose tokens are accepted here. */
  PAGES_ALLOWED_AUDIENCES: string
  /** Comma-separated email domains allowed to edit. The access gate. */
  PAGES_ALLOWED_EMAIL_DOMAINS: string
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

export type { AppEnv, Env, Variables }
