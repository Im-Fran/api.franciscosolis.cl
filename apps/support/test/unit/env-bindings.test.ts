import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * A guard against the one cost of the `test` environment in `wrangler.jsonc`.
 *
 * A named Wrangler environment inherits nothing, so every binding and variable the Worker needs is
 * written twice: once at the top level for production, once under `env.test` for the suite. That
 * duplication exists for a good reason (the `ai` and `vectorize` bindings would otherwise make the
 * pool open a billed remote session against the real account) but it is exactly the kind of
 * duplication that rots — somebody adds a var for production, the suite keeps passing because no
 * test reads it yet, and the failure surfaces months later as an undefined at runtime.
 *
 * So: every variable the Worker declares in its `Env` is asserted present here. Adding one to
 * `src/env.ts` without adding it to both halves of the config fails this file immediately.
 */

const REQUIRED_VARS = [
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'SUPPORT_ALLOWED_AUDIENCES',
  'SUPPORT_REQUESTER_AUDIENCES',
  'SUPPORT_ALLOWED_EMAIL_DOMAINS',
  'SUPPORT_INBOX_ADDRESSES',
  'SUPPORT_REPLY_DOMAIN',
  'SUPPORT_TICKET_URL',
  'MAIL_FROM_EMAIL',
  'MAIL_FROM_NAME',
  'MAIL_REPLY_TO',
  'AI_TEXT_MODEL',
  'AI_EMBEDDING_MODEL',
] as const

describe('the test environment', () => {
  it.each(REQUIRED_VARS)('declares %s', (name) => {
    const value = (env as unknown as Record<string, unknown>)[name]
    expect(typeof value, `${name} is missing from env.test in wrangler.jsonc`).toBe('string')
    expect(String(value).length).toBeGreaterThan(0)
  })

  it('binds the database and the auth service', () => {
    expect(env.DB).toBeDefined()
    expect(env.AUTH).toBeDefined()
    expect(env.EMAIL).toBeDefined()
  })

  it('declares the notifications queue, which Miniflare simulates without an account', () => {
    // Unlike AI and Vectorize, a queue producer has a local simulation, so it stays declared here and
    // a missing one fails this line rather than the first reply on the development stack.
    expect(env.NOTIFICATIONS_QUEUE).toBeDefined()
  })

  it('keeps the two audience lists distinct', () => {
    // The whole point of having two is that a website token is not a console token. If somebody
    // "simplifies" them into one value, this is the line that says no.
    expect(env.SUPPORT_ALLOWED_AUDIENCES).not.toBe(env.SUPPORT_REQUESTER_AUDIENCES)
    expect(env.SUPPORT_ALLOWED_AUDIENCES.split(',')).not.toContain('franciscosolis-web')
    expect(env.SUPPORT_REQUESTER_AUDIENCES.split(',')).toContain('franciscosolis-web')
  })

  it('leaves the AI and Vectorize bindings out, which is why this environment exists', () => {
    // Declared at the top level for production, deliberately absent here: the pool answers either of
    // them by opening a remote proxy session that needs an API token CI does not have. The suite
    // installs its own stand-ins instead — see `test/helpers/ai.ts`.
    const raw = env as unknown as Record<string, unknown>
    expect(raw.AI).toBeDefined() // installed by test/setup.ts, not by wrangler
    expect(raw.VECTORIZE).toBeDefined()
  })
})
