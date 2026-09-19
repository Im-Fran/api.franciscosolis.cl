import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * A guard against the one cost of the `test` environment in `wrangler.jsonc`.
 *
 * A named Wrangler environment inherits nothing, so every binding and variable this Worker needs is
 * written twice: once at the top level for production, once under `env.test` for the suite. That
 * duplication exists for a good reason — the `ai` binding would otherwise make the pool open a
 * billed remote session against the real account — but it is exactly the kind of duplication that
 * rots: somebody adds a var for production, the suite keeps passing because no test reads it yet,
 * and the failure surfaces months later as an undefined at runtime.
 *
 * `scripts/check-environments.mjs` guards the *dev* half and deliberately ignores this one, so this
 * file is the only thing standing between `env.test` and that drift.
 */

const REQUIRED_VARS = [
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'MARKETPLACE_ALLOWED_AUDIENCES',
  'MARKETPLACE_ALLOWED_EMAIL_DOMAINS',
  'MARKETPLACE_ACCOUNT_AUDIENCES',
  'MARKETPLACE_PUBLIC_URL',
  'SITE_BASE_URL',
  'MERCADOPAGO_ACCESS_TOKEN',
  'MERCADOPAGO_WEBHOOK_SECRET',
  'DOWNLOAD_SIGNING_KEY',
  'AI_TEXT_MODEL',
] as const

describe('the test environment', () => {
  it.each(REQUIRED_VARS)('declares %s', (name) => {
    const value = (env as unknown as Record<string, unknown>)[name]
    expect(typeof value, `${name} is missing from env.test in wrangler.jsonc`).toBe('string')
    expect(String(value).length).toBeGreaterThan(0)
  })

  it('binds the database, the auth service and the release bucket', () => {
    expect(env.DB).toBeDefined()
    expect(env.AUTH).toBeDefined()
    expect(env.RELEASES).toBeDefined()
  })

  it('keeps the two audience lists distinct', () => {
    // The point of having two is that a buyer's token is not an editor's. If somebody "simplifies"
    // them into one value, this is the line that says no.
    expect(env.MARKETPLACE_ALLOWED_AUDIENCES).not.toBe(env.MARKETPLACE_ACCOUNT_AUDIENCES)
    expect(env.MARKETPLACE_ALLOWED_AUDIENCES.split(',')).not.toContain('franciscosolis-web')
  })

  it('never carries a live MercadoPago credential', () => {
    // Every outbound call to the provider is stubbed; these values are what a call that escaped a
    // stub would present. A real token here is a suite that can charge a card.
    expect(env.MERCADOPAGO_ACCESS_TOKEN).toContain('TEST')
  })

  it('never points the token gate or the provider callbacks at production', () => {
    // Every test stubs `env.AUTH`; these values are what a request that escaped a stub falls
    // against, and pointing them at production would make the suite verify tokens for real.
    expect(env.AUTH_ISSUER).not.toContain('franciscosolis.cl')
    expect(env.AUTH_JWKS_URL).not.toContain('franciscosolis.cl')
    expect(env.MARKETPLACE_PUBLIC_URL).not.toContain('franciscosolis.cl')
    expect(env.SITE_BASE_URL).not.toContain('franciscosolis.cl')
  })

  it('leaves the AI binding out, which is why this environment exists', () => {
    // Declared at the top level for production, deliberately absent here: the pool answers it by
    // opening a remote proxy session that needs an API token CI does not have and bills real
    // neurons. `test/setup.ts` installs a stand-in instead — see `test/helpers/ai.ts`.
    expect((env as unknown as Record<string, unknown>).AI).toBeDefined()
  })
})
