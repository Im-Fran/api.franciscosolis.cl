import type { AccessTokenClaims } from '@/lib/jwks'

/**
 * Cloudflare Email Sending binding (`send_email` in wrangler.jsonc). Declared locally instead of
 * relying on `@cloudflare/workers-types`, whose `SendEmail` type still describes the older raw-MIME
 * Email Routing binding rather than the structured `send()` of Email Sending. Same reasoning, and
 * the same shape, as `apps/cms/src/env.ts` and `apps/auth/src/env.ts`.
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
  replyTo?: string
  headers?: Record<string, string>
}

type EmailSender = {
  send(message: EmailMessage): Promise<{ messageId: string }>
}

/**
 * Workers AI and Vectorize, both hand-declared for the same reason as `EmailSender`: the shipped
 * types for these two bindings have historically lagged the runtime, and a narrow surface written
 * here is both accurate about what this Worker actually calls and self-documenting about what it
 * does not. Every call goes through `src/services/ai.ts` and `src/services/vectors.ts`, so this is
 * the complete list.
 */
type AiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

type VectorizeMatch = {
  id: string
  score: number
  metadata?: Record<string, unknown>
}

type VectorizeVector = {
  id: string
  values: number[]
  metadata?: Record<string, unknown>
}

type VectorizeBinding = {
  query(
    vector: number[],
    options?: {
      topK?: number
      returnMetadata?: boolean | 'none' | 'indexed' | 'all'
      filter?: Record<string, unknown>
    },
  ): Promise<{ matches: VectorizeMatch[] }>
  upsert(vectors: VectorizeVector[]): Promise<unknown>
  deleteByIds(ids: string[]): Promise<unknown>
}

type Env = {
  DB: D1Database
  /** Only ever asked for the JWKS. See `src/lib/jwks.ts` for why it is a binding and not a fetch. */
  AUTH: Fetcher
  EMAIL: EmailSender
  AI: AiBinding
  VECTORIZE: VectorizeBinding

  AUTH_JWKS_URL: string
  AUTH_ISSUER: string
  /**
   * Comma-separated client application ids whose tokens may act as a *support agent*.
   *
   * There are deliberately two audience lists in this Worker, which is new for this monorepo, and
   * they must not be merged. This one gates `/admin`; `SUPPORT_REQUESTER_AUDIENCES` below gates a
   * person reading their own ticket. Collapsing them into one would let a token minted for the
   * public website into the support console.
   */
  SUPPORT_ALLOWED_AUDIENCES: string
  /** Comma-separated client application ids a *requester* may present. Wider, and gates far less. */
  SUPPORT_REQUESTER_AUDIENCES: string
  /** Comma-separated email domains allowed to act as an agent. */
  SUPPORT_ALLOWED_EMAIL_DOMAINS: string
  /** Comma-separated addresses Email Routing delivers to this Worker. */
  SUPPORT_INBOX_ADDRESSES: string
  /** Domain the `reply+<key>@` envelope address lives on. */
  SUPPORT_REPLY_DOMAIN: string
  /** Base of the public ticket link: `<base>/<FS-1042>#k=<secret>`. */
  SUPPORT_TICKET_URL: string

  MAIL_FROM_EMAIL: string
  MAIL_FROM_NAME: string
  MAIL_REPLY_TO: string

  AI_TEXT_MODEL: string
  AI_EMBEDDING_MODEL: string
}

/** An authenticated support agent, set on the context by `requireAgent`. */
type Agent = {
  id: string
  email: string
  name: string | null
  picture: string | null
  sessionId: string
  applicationId: string
  roles: string[]
  permissions: string[]
  claims: AccessTokenClaims
}

type Variables = {
  agent: Agent
}

type AppEnv = {
  Bindings: Env
  Variables: Variables
}

export type {
  Agent,
  AiBinding,
  AppEnv,
  EmailAddress,
  EmailMessage,
  EmailSender,
  Env,
  Variables,
  VectorizeBinding,
  VectorizeMatch,
  VectorizeVector,
}
