import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Every variable `src/env.ts` declares, asserted present in the config the suite runs against. The
 * development half is kept in step with it by `scripts/check-environments.mjs`.
 */
const REQUIRED_VARS = [
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'CUSTOM_APPS_ALLOWED_AUDIENCES',
  'CUSTOM_APPS_ALLOWED_EMAIL_DOMAINS',
  'INGEST_PUBLIC_URL',
] as const

describe('the Worker configuration', () => {
  it.each(REQUIRED_VARS)('declares %s', (name) => {
    const value = (env as unknown as Record<string, unknown>)[name]
    expect(typeof value, `${name} is missing from wrangler.jsonc`).toBe('string')
    expect(String(value).length).toBeGreaterThan(0)
  })

  it('binds the database, the auth service, both queues, the sockets, both buckets and the three rate limiters', () => {
    expect(env.DB).toBeDefined()
    expect(env.AUTH).toBeDefined()
    expect(env.TELEMETRY_QUEUE).toBeDefined()
    expect(env.NOTIFICATIONS_QUEUE).toBeDefined()
    expect(typeof env.PRESENCE.idFromName).toBe('function')
    expect(typeof env.SCREENSHOTS.put).toBe('function')
    expect(typeof env.RELEASES.put).toBe('function')
    expect(typeof env.ENROLL_IP_LIMITER.limit).toBe('function')
    expect(typeof env.ENROLL_APP_LIMITER.limit).toBe('function')
    expect(typeof env.INGEST_LIMITER.limit).toBe('function')
  })

  it('accepts only the panel audience', () => {
    expect(env.CUSTOM_APPS_ALLOWED_AUDIENCES).toBe('franciscosolis-custom-apps')
  })

  it('serves ingest on a host of its own, under a versioned path', () => {
    const url = new URL(env.INGEST_PUBLIC_URL)
    expect(url.protocol).toBe('https:')
    expect(url.host).not.toBe('api.franciscosolis.cl')
    expect(url.pathname).toMatch(/\/v\d+$/)
  })
})
