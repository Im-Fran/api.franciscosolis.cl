import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { describeProviders, getAvailableProviders, PROVIDER_REGISTRY } from '@/providers'
import { testEnv } from '../helpers/env'

describe('PROVIDER_REGISTRY', () => {
  it('gives every provider a distinct name and start path', () => {
    expect(new Set(PROVIDER_REGISTRY.map((provider) => provider.name)).size).toBe(PROVIDER_REGISTRY.length)
    expect(new Set(PROVIDER_REGISTRY.map((provider) => provider.startPath)).size).toBe(PROVIDER_REGISTRY.length)
  })

  it('starts every provider at a path relative to the public URL', () => {
    expect(PROVIDER_REGISTRY.every((provider) => provider.startPath.startsWith('/'))).toBe(true)
  })
})

describe('getAvailableProviders', () => {
  it('returns both providers when the environment is fully configured', () => {
    expect(getAvailableProviders(env).map((provider) => provider.name)).toEqual(['magic_link', 'google'])
  })

  it('drops Google when its credentials are missing, and keeps magic link', () => {
    const available = getAvailableProviders(testEnv({ GOOGLE_CLIENT_SECRET: '' }))

    expect(available.map((provider) => provider.name)).toEqual(['magic_link'])
  })
})

describe('describeProviders', () => {
  it('lists every provider, marking the unusable ones rather than hiding them', () => {
    const described = describeProviders(testEnv({ GOOGLE_CLIENT_ID: '' }))

    expect(described).toEqual([
      {
        name: 'magic_link',
        display_name: 'Magic Link',
        initiation: 'email',
        start_path: '/magic-link',
        available: true,
      },
      {
        name: 'google',
        display_name: 'Google',
        initiation: 'redirect',
        start_path: '/oauth/google/authorize',
        available: false,
      },
    ])
  })

  it('reports both as available on a fully configured deployment', () => {
    expect(describeProviders(env).every((provider) => provider.available)).toBe(true)
  })
})
