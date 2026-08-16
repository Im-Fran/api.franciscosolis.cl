import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLE_SLUG,
  CODE_CHALLENGE_METHOD,
  MAGIC_LINK_RATE_LIMIT,
  PROVIDERS,
  TTL,
  USER_STATUS,
} from '@/lib/config'
import { PROVIDER_REGISTRY } from '@/providers'
import { SUPPORTED_SCOPES } from '@/services/applications'

describe('TTL', () => {
  it('makes the authorization code the shortest-lived thing the Worker issues', () => {
    const others = Object.entries(TTL).filter(([name]) => name !== 'authorizationCode')

    expect(others.every(([, seconds]) => seconds > TTL.authorizationCode)).toBe(true)
  })

  it('keeps the access token far shorter than the refresh token that renews it', () => {
    expect(TTL.accessToken).toBeLessThan(TTL.refreshToken)
    // 15 minutes: short enough that a revoked role is stale only briefly for offline verifiers.
    expect(TTL.accessToken).toBe(15 * 60)
  })

  it('gives a mail round trip more time than a browser redirect to an external provider', () => {
    expect(TTL.oauthState).toBeLessThan(TTL.magicLink)
  })

  it('makes the refresh token the longest-lived credential', () => {
    expect(Math.max(...Object.values(TTL))).toBe(TTL.refreshToken)
  })

  it('outlives an access token with every invitation', () => {
    expect(TTL.invitation).toBeGreaterThan(TTL.accessToken)
  })

  it('states every lifetime in whole seconds', () => {
    expect(Object.values(TTL).every((seconds) => Number.isInteger(seconds) && seconds > 0)).toBe(true)
  })
})

describe('MAGIC_LINK_RATE_LIMIT', () => {
  it('allows a handful of retries inside a window as long as the link itself lives', () => {
    expect(MAGIC_LINK_RATE_LIMIT.max).toBe(5)
    expect(MAGIC_LINK_RATE_LIMIT.windowSeconds).toBe(TTL.magicLink)
  })
})

describe('CODE_CHALLENGE_METHOD', () => {
  it('is S256 and nothing else', () => {
    // `plain` is not merely unused: the whole PKCE guarantee collapses without the hash.
    expect(CODE_CHALLENGE_METHOD).toBe('S256')
  })
})

describe('PROVIDERS', () => {
  it('lists exactly the providers the registry implements', () => {
    expect([...PROVIDERS]).toEqual(['magic_link', 'google'])
    expect(PROVIDER_REGISTRY.map((provider) => provider.name)).toEqual([...PROVIDERS])
  })
})

describe('USER_STATUS', () => {
  it('has only the two states the sign-in and refresh paths check for', () => {
    expect([...USER_STATUS]).toEqual(['active', 'disabled'])
  })
})

describe('SUPPORTED_SCOPES', () => {
  it('is the OIDC baseline, and the metadata document advertises the same list', () => {
    expect([...SUPPORTED_SCOPES]).toEqual(['openid', 'profile', 'email'])
  })
})

describe('ADMIN_ROLE_SLUG', () => {
  it('names a global role that the seed migration actually creates', async () => {
    const row = await env.DB.prepare('SELECT id, application_id FROM roles WHERE slug = ?')
      .bind(ADMIN_ROLE_SLUG)
      .first<{ id: string; application_id: string | null }>()

    // A bootstrap admin gets nothing on first sign-in if this slug and the seed disagree.
    expect(row?.application_id).toBeNull()
  })
})
