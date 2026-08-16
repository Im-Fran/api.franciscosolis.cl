import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CODE_CHALLENGE_METHOD } from '@/lib/config'
import { withWorkerEnv } from '../helpers/env'

const get = (path: string) => SELF.fetch(`https://auth.internal${path}`)

describe('GET /', () => {
  it('reports the issuer and every provider it knows about', async () => {
    const response = await get('/')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        message: 'Hello, Auth!',
        issuer: env.AUTH_ISSUER,
        providers: [
          { name: 'magic_link', display_name: 'Magic Link', initiation: 'email', start_path: '/magic-link', available: true },
          {
            name: 'google',
            display_name: 'Google',
            initiation: 'redirect',
            start_path: '/oauth/google/authorize',
            available: true,
          },
        ],
      },
    })
  })

  it('marks a provider unavailable when its secrets are missing on this deployment', async () => {
    const body = await withWorkerEnv({ GOOGLE_CLIENT_SECRET: '' }, async () => (await get('/')).json<{
      data: { providers: { name: string; available: boolean }[] }
    }>())

    expect(body.data.providers.find((provider) => provider.name === 'google')?.available).toBe(false)
    expect(body.data.providers.find((provider) => provider.name === 'magic_link')?.available).toBe(true)
  })
})

describe('GET /.well-known/jwks.json', () => {
  it('publishes the verification key and nothing else', async () => {
    const response = await get('/.well-known/jwks.json')
    const body = await response.json<{ keys: Record<string, unknown>[] }>()

    expect(response.status).toBe(200)
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]).toEqual({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      kid: 'zkYWu6vANSKYDOXRS4kw3_owd0qlSMSkVvyPMlwF0uQ',
      x: expect.any(String),
      use: 'sig',
      key_ops: ['verify'],
    })
  })

  it('never leaks the private scalar, in any spelling', async () => {
    const raw = await (await get('/.well-known/jwks.json')).text()
    const secret = JSON.parse(env.JWT_PRIVATE_KEY) as { d: string }

    expect(raw).not.toContain('"d"')
    expect(raw).not.toContain(secret.d)
  })

  it('opts out of the Worker-wide no-store, because a key is immutable per kid', async () => {
    const response = await get('/.well-known/jwks.json')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })

  it('answers 500 rather than an empty key set when the signing key is unusable', async () => {
    const response = await withWorkerEnv({ JWT_PRIVATE_KEY: 'not-json' }, () => get('/.well-known/jwks.json'))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ code: 500 })
  })
})

describe('GET /.well-known/oauth-authorization-server', () => {
  it('describes the endpoints relative to the public URL, not the internal one', async () => {
    const response = await get('/.well-known/oauth-authorization-server')
    const base = env.AUTH_PUBLIC_URL

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      issuer: env.AUTH_ISSUER,
      authorization_endpoint: `${base}/oauth/google/authorize`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: [CODE_CHALLENGE_METHOD],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      scopes_supported: ['openid', 'profile', 'email'],
      id_token_signing_alg_values_supported: ['EdDSA'],
    })
  })

  it('advertises S256 only, so a client cannot negotiate plain PKCE', async () => {
    const body = await (await get('/.well-known/oauth-authorization-server')).json<{
      code_challenge_methods_supported: string[]
    }>()

    expect(body.code_challenge_methods_supported).not.toContain('plain')
  })

  it('points its jwks_uri at a document this Worker actually serves', async () => {
    const body = await (await get('/.well-known/oauth-authorization-server')).json<{ jwks_uri: string }>()
    const path = new URL(body.jwks_uri).pathname.replace('/auth', '')

    expect((await get(path)).status).toBe(200)
  })

  it('is cacheable, like the JWKS', async () => {
    const response = await get('/.well-known/oauth-authorization-server')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })
})

describe('response defaults', () => {
  it('marks everything else no-store, since every other response is user-specific', async () => {
    for (const path of ['/', '/openapi.json', '/me']) {
      expect((await get(path)).headers.get('Cache-Control')).toBe('no-store')
    }
  })

  it('states the charset on JSON, so non-ASCII is not read as Latin-1', async () => {
    expect((await get('/')).headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('answers a 404 in the { code, error } shape, still uncached', async () => {
    const response = await get('/no-such-endpoint')

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /openapi.json', () => {
  it('documents every mounted route', async () => {
    const response = await get('/openapi.json')
    const body = await response.json<{ paths: Record<string, unknown>; info: { title: string } }>()

    expect(response.status).toBe(200)
    expect(body.info.title).toBe('FranciscoSolis - Auth API')
    expect(Object.keys(body.paths)).toEqual(
      expect.arrayContaining([
        '/',
        '/.well-known/jwks.json',
        '/.well-known/oauth-authorization-server',
        '/magic-link',
        '/magic-link/callback',
        '/oauth/google/authorize',
        '/oauth/google/callback',
        '/oauth/token',
        '/oauth/revoke',
        '/me',
        '/logout',
        '/admin/users',
      ]),
    )
  })

  it('excludes itself from the document', async () => {
    const body = await (await get('/openapi.json')).json<{ paths: Record<string, unknown> }>()

    expect(body.paths).not.toHaveProperty('/openapi.json')
  })

  it('declares the bearer scheme the protected routes reference', async () => {
    const body = await (await get('/openapi.json')).json<{
      components: { securitySchemes: Record<string, unknown> }
      paths: Record<string, Record<string, { security?: unknown[] }>>
    }>()

    expect(body.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    expect(body.paths['/me']?.get?.security).toEqual([{ bearerAuth: [] }])
  })

  it('keeps the discovery endpoints, whose paths contain dots', async () => {
    const body = await (await get('/openapi.json')).json<{ paths: Record<string, unknown> }>()

    expect(body.paths).toHaveProperty('/.well-known/jwks.json')
  })
})
