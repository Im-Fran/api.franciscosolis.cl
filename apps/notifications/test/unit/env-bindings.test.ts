import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * Every variable `src/env.ts` declares, asserted present in the config the suite runs against. The
 * development half is kept in step with it by `scripts/check-environments.mjs`, so between the two a
 * var added for production only fails before it reaches a deploy.
 */
const REQUIRED_VARS = [
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'NOTIFICATIONS_ALLOWED_AUDIENCES',
  'SITE_URL',
  'VAPID_SUBJECT',
  'MAIL_FROM_EMAIL',
  'MAIL_FROM_NAME',
] as const

describe('the Worker configuration', () => {
  it.each(REQUIRED_VARS)('declares %s', (name) => {
    const value = (env as unknown as Record<string, unknown>)[name]
    expect(typeof value, `${name} is missing from wrangler.jsonc`).toBe('string')
    expect(String(value).length).toBeGreaterThan(0)
  })

  it('binds the database, the auth service and the email sender', () => {
    expect(env.DB).toBeDefined()
    expect(env.AUTH).toBeDefined()
    expect(env.EMAIL).toBeDefined()
  })

  it('accepts only the website audience', () => {
    // There is no console behind this Worker; a token minted for one has no business reading an inbox.
    expect(env.NOTIFICATIONS_ALLOWED_AUDIENCES).toBe('franciscosolis-web')
  })

  it('addresses push services with a contact they can reach', () => {
    expect(env.VAPID_SUBJECT).toMatch(/^(mailto:|https:\/\/)/)
  })

  it('ships no VAPID key in the config: it is a secret', () => {
    expect((env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY).toBeUndefined()
  })
})
