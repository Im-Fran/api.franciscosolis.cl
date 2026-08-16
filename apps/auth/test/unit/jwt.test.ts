import { env } from 'cloudflare:test'
import { decode, sign } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import { TTL } from '@/lib/config'
import { getPublicJwks, getSigningKey, signAccessToken, toPublicJwk, verifyAccessToken } from '@/lib/jwt'
import type { Ed25519Jwk } from '@/lib/jwt'
import { testEnv } from '../helpers/env'

/** The key `vitest.config.ts` injects as `JWT_PRIVATE_KEY`. */
const CURRENT_KID = 'zkYWu6vANSKYDOXRS4kw3_owd0qlSMSkVvyPMlwF0uQ'

/** A second Ed25519 keypair, standing in for a key that has been rotated out. */
const RETIRED_KEY: Ed25519Jwk = {
  kty: 'OKP',
  crv: 'Ed25519',
  alg: 'EdDSA',
  kid: 'UdAwRUjhMk7rCE-iwJcxndEf3vIOuHCYCDf6lIRVcVE',
  x: 'dP_5JKS6Tck7_n_SagE9W6e-zksxC4UgMlVc8uIvIrc',
  d: '_yieBECPlSZ7KZbR8c2vPRpNMwsGZmufjldExMAV5FE',
}

const retiredPublicKey = () => {
  const { d: _private, ...publicKey } = RETIRED_KEY
  return publicKey
}

const claims = (overrides: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  aud: 'franciscosolis-web',
  sid: 'session-1',
  provider: 'magic_link' as const,
  email: 'someone@example.test',
  email_verified: true,
  name: 'Someone',
  picture: null,
  roles: ['user'],
  permissions: [],
  ...overrides,
})

describe('getSigningKey', () => {
  it('returns the configured private key with its kid and EdDSA alg', () => {
    const key = getSigningKey(env)

    expect(key.kid).toBe(CURRENT_KID)
    expect(key.alg).toBe('EdDSA')
    expect(key.kty).toBe('OKP')
    expect(key.crv).toBe('Ed25519')
    expect(key.d).toBeTruthy()
  })

  it('forces alg to EdDSA even if the stored key claims something else', () => {
    const key = getSigningKey(testEnv({ JWT_PRIVATE_KEY: JSON.stringify({ ...RETIRED_KEY, alg: 'RS256' }) }))

    expect(key.alg).toBe('EdDSA')
  })

  it('rejects a key that is not JSON', () => {
    expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: 'not-json' }))).toThrow('JWT_PRIVATE_KEY is not valid JSON')
  })

  it('rejects a JWK missing any of kty, crv, x or kid', () => {
    const complete = { kty: 'OKP', crv: 'Ed25519', x: RETIRED_KEY.x, kid: 'k', d: RETIRED_KEY.d }

    for (const missing of ['kty', 'crv', 'x', 'kid'] as const) {
      const { [missing]: _dropped, ...partial } = complete
      expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: JSON.stringify(partial) }))).toThrow(
        'JWT_PRIVATE_KEY must be an Ed25519 JWK with kty=OKP, crv=Ed25519, x and kid',
      )
    }
  })

  it('rejects a key of the wrong type or curve', () => {
    expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: JSON.stringify({ ...RETIRED_KEY, kty: 'EC' }) }))).toThrow(
      /must be an Ed25519 JWK/,
    )
    expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: JSON.stringify({ ...RETIRED_KEY, crv: 'X25519' }) }))).toThrow(
      /must be an Ed25519 JWK/,
    )
  })

  it('rejects a public key, which could not sign anything', () => {
    expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: JSON.stringify(retiredPublicKey()) }))).toThrow(
      'JWT_PRIVATE_KEY is missing the private component `d`',
    )
  })

  it('rejects valid JSON that is not an object', () => {
    expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: '"a string"' }))).toThrow(/must be an Ed25519 JWK/)
    expect(() => getSigningKey(testEnv({ JWT_PRIVATE_KEY: 'null' }))).toThrow(/must be an Ed25519 JWK/)
  })
})

describe('toPublicJwk', () => {
  it('drops the private scalar and marks the key verification-only', () => {
    const publicKey = toPublicJwk(getSigningKey(env))

    expect(publicKey).not.toHaveProperty('d')
    expect(publicKey.use).toBe('sig')
    expect(publicKey.key_ops).toEqual(['verify'])
    expect(publicKey.kid).toBe(CURRENT_KID)
    expect(publicKey.x).toBe(getSigningKey(env).x)
  })

  it('does not mutate the key it was given', () => {
    const key = getSigningKey(env)
    toPublicJwk(key)

    expect(key.d).toBeTruthy()
  })
})

describe('getPublicJwks', () => {
  it('publishes the current signing key, without its private half', () => {
    const keys = getPublicJwks(env)

    expect(keys).toHaveLength(1)
    expect(keys[0]?.kid).toBe(CURRENT_KID)
    expect(keys[0]).not.toHaveProperty('d')
  })

  it('appends retired keys so tokens signed before a rotation still verify', () => {
    const keys = getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: JSON.stringify([retiredPublicKey()]) }))

    expect(keys.map((key) => key.kid)).toEqual([CURRENT_KID, RETIRED_KEY.kid])
  })

  it('strips the private component from a retired key that was pasted in whole', () => {
    const keys = getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: JSON.stringify([RETIRED_KEY]) }))

    expect(keys.every((key) => !('d' in key))).toBe(true)
  })

  it('de-duplicates by kid, keeping the current key rather than the retired copy', () => {
    const shadow = { ...retiredPublicKey(), kid: CURRENT_KID, x: RETIRED_KEY.x }
    const keys = getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: JSON.stringify([shadow, shadow]) }))

    expect(keys).toHaveLength(1)
    expect(keys[0]?.x).toBe(getSigningKey(env).x)
  })

  it('ignores an empty retired-keys variable rather than treating it as malformed', () => {
    expect(getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: '' }))).toHaveLength(1)
  })

  it('accepts an empty retired-keys array', () => {
    expect(getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: '[]' }))).toHaveLength(1)
  })

  it('rejects retired keys that are not JSON', () => {
    expect(() => getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: '{oops' }))).toThrow(
      'JWT_RETIRED_PUBLIC_KEYS is not valid JSON',
    )
  })

  it('rejects retired keys that are JSON but not an array', () => {
    expect(() => getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: JSON.stringify(retiredPublicKey()) }))).toThrow(
      'JWT_RETIRED_PUBLIC_KEYS must be a JSON array of public JWKs',
    )
  })

  it('rejects an array entry that is not an Ed25519 JWK', () => {
    expect(() => getPublicJwks(testEnv({ JWT_RETIRED_PUBLIC_KEYS: JSON.stringify([{ kty: 'RSA', kid: 'x' }]) }))).toThrow(
      'JWT_RETIRED_PUBLIC_KEYS must be an Ed25519 JWK with kty=OKP, crv=Ed25519, x and kid',
    )
  })
})

describe('signAccessToken', () => {
  it('stamps the issuer, timestamps, a unique jti and the configured TTL', async () => {
    const before = Math.floor(Date.now() / 1000)
    const first = await signAccessToken(env, claims())
    const second = await signAccessToken(env, claims())

    const payload = decode(first.token).payload as unknown as Record<string, unknown>

    expect(payload.iss).toBe(env.AUTH_ISSUER)
    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.exp).toBe((payload.iat as number) + TTL.accessToken)
    expect(first.expiresIn).toBe(TTL.accessToken)
    expect(first.expiresAt).toBe(payload.exp)
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect((decode(second.token).payload as unknown as Record<string, unknown>).jti).not.toBe(payload.jti)
  })

  it('carries the caller-supplied claims through untouched', async () => {
    const { token } = await signAccessToken(
      env,
      claims({ sub: 'u-42', aud: 'franciscosolis-cms', roles: ['admin', 'user'], permissions: ['users:read'] }),
    )
    const payload = decode(token).payload as unknown as Record<string, unknown>

    expect(payload).toMatchObject({
      sub: 'u-42',
      aud: 'franciscosolis-cms',
      sid: 'session-1',
      provider: 'magic_link',
      email: 'someone@example.test',
      email_verified: true,
      roles: ['admin', 'user'],
      permissions: ['users:read'],
    })
  })

  it('advertises the key that signed it in the header, so the JWKS can be indexed by kid', async () => {
    const { token } = await signAccessToken(env, claims())

    expect(decode(token).header).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: CURRENT_KID })
  })
})

describe('verifyAccessToken', () => {
  it('round-trips a token it just issued', async () => {
    const { token } = await signAccessToken(env, claims({ sub: 'round-trip' }))

    await expect(verifyAccessToken(env, token)).resolves.toMatchObject({ sub: 'round-trip', iss: env.AUTH_ISSUER })
  })

  it('selects the key by kid, so a token signed with a retired key still verifies', async () => {
    const token = await sign(
      { ...claims(), iss: env.AUTH_ISSUER, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 },
      RETIRED_KEY,
      'EdDSA',
    )
    const rotated = testEnv({ JWT_RETIRED_PUBLIC_KEYS: JSON.stringify([retiredPublicKey()]) })

    expect(decode(token).header.kid).toBe(RETIRED_KEY.kid)
    await expect(verifyAccessToken(rotated, token)).resolves.toMatchObject({ sub: 'user-1' })
  })

  it('refuses a token whose kid is not published', async () => {
    const token = await sign(
      { ...claims(), iss: env.AUTH_ISSUER, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 },
      RETIRED_KEY,
      'EdDSA',
    )

    await expect(verifyAccessToken(env, token)).rejects.toThrow(`no published key matches kid "${RETIRED_KEY.kid}"`)
  })

  it('refuses a token signed by a key that is published under the expected kid but is a different key', async () => {
    const imposter = { ...RETIRED_KEY, kid: CURRENT_KID }
    const token = await sign(
      { ...claims(), iss: env.AUTH_ISSUER, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 },
      imposter,
      'EdDSA',
    )

    await expect(verifyAccessToken(env, token)).rejects.toThrow()
  })

  it('refuses a token issued by someone else', async () => {
    const token = await sign(
      {
        ...claims(),
        iss: 'https://evil.example',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      getSigningKey(env),
      'EdDSA',
    )

    await expect(verifyAccessToken(env, token)).rejects.toThrow()
  })

  it('refuses a token with no issuer at all', async () => {
    const token = await sign(
      { sub: 'u', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 },
      getSigningKey(env),
      'EdDSA',
    )

    await expect(verifyAccessToken(env, token)).rejects.toThrow()
  })

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    const token = await sign(
      { ...claims(), iss: env.AUTH_ISSUER, iat: past, exp: past + 60 },
      getSigningKey(env),
      'EdDSA',
    )

    await expect(verifyAccessToken(env, token)).rejects.toThrow()
  })

  it('refuses a token whose payload was edited after signing', async () => {
    const { token } = await signAccessToken(env, claims({ roles: [] }))
    const [header, , signature] = token.split('.')
    const forgedPayload = btoa(JSON.stringify({ ...claims({ roles: ['admin'] }), iss: env.AUTH_ISSUER, exp: 2 ** 40 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await expect(verifyAccessToken(env, `${header}.${forgedPayload}.${signature}`)).rejects.toThrow()
  })

  it('refuses a string that is not a JWT at all', async () => {
    await expect(verifyAccessToken(env, 'not.a.jwt')).rejects.toThrow()
    await expect(verifyAccessToken(env, 'garbage')).rejects.toThrow()
  })
})
