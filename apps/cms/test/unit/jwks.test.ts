import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Env } from '@/env'
import { verifyAccessToken } from '@/lib/jwks'
import type { Jwk, KeyPair } from '../helpers/tokens'
import { editorClaims, generateKeyPair, mintRawToken, mintToken } from '../helpers/tokens'

/**
 * `lib/jwks.ts` memoises the fetched key set in module state that lives as long as the isolate, so
 * this file owns that cache for its whole run. The tests are written to be read in order: each one
 * says what it expects the cache to be in, and the fetch counter is never reset.
 */

let keyA: KeyPair
let keyB: KeyPair
let published: Jwk[]
let fetchMock: ReturnType<typeof vi.fn>

const fetchCount = () => fetchMock.mock.calls.length

const envWith = (overrides: Partial<Env>) => ({ ...env, ...overrides }) as Env

beforeAll(async () => {
  keyA = await generateKeyPair('key-a')
  keyB = await generateKeyPair('key-b')
  published = [keyA.publicJwk]
  fetchMock = vi.fn(async () => Response.json({ keys: published }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('verifyAccessToken', () => {
  it('fetches the key set and returns the claims', async () => {
    const token = await mintToken({ sub: 'editor-42' }, keyA.privateJwk)
    const claims = await verifyAccessToken(env as Env, token)

    expect(claims.sub).toBe('editor-42')
    expect(claims.email).toBe('fran@franciscosolis.cl')
    expect(claims.aud).toBe('franciscosolis-cms')
    expect(fetchCount()).toBe(1)
  })

  it('asks the JWKS endpoint for JSON', () => {
    expect(fetchMock).toHaveBeenCalledWith(env.AUTH_JWKS_URL, {
      headers: { Accept: 'application/json' },
    })
  })

  it('reuses the cached key set on the next verification', async () => {
    const before = fetchCount()
    await verifyAccessToken(env as Env, await mintToken({}, keyA.privateJwk))

    expect(fetchCount()).toBe(before)
  })

  it('falls back to the first published key when the token carries no kid', async () => {
    const anonymous = { ...keyA.privateJwk, kid: undefined } as unknown as Jwk
    const claims = await verifyAccessToken(env as Env, await mintToken({}, anonymous))

    expect(claims.sub).toBe('editor-1')
  })

  it('forces exactly one refetch for an unknown kid, then gives up', async () => {
    // What a key rotation looks like from here. The cache is still fresh, so without the forced
    // refetch a rotation would lock everyone out for up to the TTL.
    const before = fetchCount()
    await expect(verifyAccessToken(env as Env, await mintToken({}, keyB.privateJwk))).rejects.toThrow(
      'no published key matches kid "key-b"',
    )

    expect(fetchCount()).toBe(before + 1)
  })

  it('does not keep retrying: another unknown kid costs one more fetch, not a loop', async () => {
    const before = fetchCount()
    await expect(verifyAccessToken(env as Env, await mintToken({}, keyB.privateJwk))).rejects.toThrow(
      /no published key matches/,
    )

    expect(fetchCount()).toBe(before + 1)
  })

  it('picks up a rotated key through that forced refetch', async () => {
    published = [keyA.publicJwk, keyB.publicJwk]
    const before = fetchCount()

    const claims = await verifyAccessToken(env as Env, await mintToken({ sub: 'rotated' }, keyB.privateJwk))

    expect(claims.sub).toBe('rotated')
    expect(fetchCount()).toBe(before + 1)
  })

  it('serves the rotated key from cache afterwards', async () => {
    const before = fetchCount()
    await verifyAccessToken(env as Env, await mintToken({}, keyB.privateJwk))

    expect(fetchCount()).toBe(before)
  })

  it('rejects a token signed by a key that is not the one published under that kid', async () => {
    const impostor = await generateKeyPair('key-a')
    const token = await mintToken({}, impostor.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({
      name: 'JwtTokenSignatureMismatched',
    })
  })

  it('rejects a token from a different issuer', async () => {
    const token = await mintToken({ iss: 'https://evil.test' }, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtTokenIssuer' })
  })

  it('rejects a token with no issuer at all', async () => {
    const { iss: _iss, ...claims } = editorClaims()
    const token = await mintRawToken(claims, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtTokenIssuer' })
  })

  it('rejects a token minted for another audience', async () => {
    // A token for the public website is a perfectly valid token — it is just not a CMS token.
    const token = await mintToken({ aud: 'franciscosolis-web' }, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtTokenAudience' })
  })

  it('rejects a token with no audience claim', async () => {
    const { aud: _aud, ...claims } = editorClaims()
    const token = await mintRawToken(claims, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtPayloadRequiresAud' })
  })

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken({ iat: now - 100, exp: now - 1 }, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtTokenExpired' })
  })

  it('rejects a token issued in the future', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken({ iat: now + 600, exp: now + 1200 }, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtTokenIssuedAt' })
  })

  it('rejects a token that is not valid yet', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken({ nbf: now + 600 } as never, keyA.privateJwk)

    await expect(verifyAccessToken(env as Env, token)).rejects.toMatchObject({ name: 'JwtTokenNotBefore' })
  })

  it('rejects a string that is not a JWT before it ever looks at a key', async () => {
    await expect(verifyAccessToken(env as Env, 'not-a-jwt')).rejects.toMatchObject({ name: 'JwtTokenInvalid' })
  })

  it('accepts an audience list with padding around the entries', async () => {
    const token = await mintToken({}, keyA.privateJwk)
    const claims = await verifyAccessToken(
      envWith({ CMS_ALLOWED_AUDIENCES: ' franciscosolis-web , franciscosolis-cms ' }),
      token,
    )

    expect(claims.aud).toBe('franciscosolis-cms')
  })

  it('refuses every token when CMS_ALLOWED_AUDIENCES is empty', async () => {
    const token = await mintToken({}, keyA.privateJwk)

    await expect(verifyAccessToken(envWith({ CMS_ALLOWED_AUDIENCES: '' }), token)).rejects.toThrow(
      'CMS_ALLOWED_AUDIENCES is empty, so no token can be accepted',
    )
  })

  it('refuses every token when the audience list is only separators', async () => {
    const token = await mintToken({}, keyA.privateJwk)

    await expect(verifyAccessToken(envWith({ CMS_ALLOWED_AUDIENCES: ' , , ' }), token)).rejects.toThrow(
      /CMS_ALLOWED_AUDIENCES is empty/,
    )
  })

  // The remaining cases point at a different JWKS URL on purpose: the cache is keyed by URL, so
  // this is the only way to make the module fetch again with a fresh TTL still in place.
  it('surfaces a non-OK JWKS response with its status', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 503 }))
    const token = await mintToken({}, keyA.privateJwk)

    await expect(
      verifyAccessToken(envWith({ AUTH_JWKS_URL: 'https://auth.test/down.json' }), token),
    ).rejects.toThrow('JWKS endpoint answered 503')
  })

  it('rejects a JWKS document with an empty key list', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ keys: [] }))
    const token = await mintToken({}, keyA.privateJwk)

    await expect(
      verifyAccessToken(envWith({ AUTH_JWKS_URL: 'https://auth.test/empty.json' }), token),
    ).rejects.toThrow('JWKS endpoint returned no keys')
  })

  it('rejects a JWKS document with no `keys` field', async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ nope: true }))
    const token = await mintToken({}, keyA.privateJwk)

    await expect(
      verifyAccessToken(envWith({ AUTH_JWKS_URL: 'https://auth.test/malformed.json' }), token),
    ).rejects.toThrow('JWKS endpoint returned no keys')
  })

  it('propagates a network failure rather than serving a stale set for another URL', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error('connection refused')
    })
    const token = await mintToken({}, keyA.privateJwk)

    await expect(
      verifyAccessToken(envWith({ AUTH_JWKS_URL: 'https://auth.test/unreachable.json' }), token),
    ).rejects.toThrow('connection refused')
  })

  // Last in the file on purpose: unlike the failures above, this JWKS document *is* fetched
  // successfully, so it replaces the cached set and would perturb the fetch counts of any test
  // written after it.
  it('rejects a published key that is well-formed JSON but not an importable key', async () => {
    // A realistic auth-side misconfiguration: the document parses, the kid matches, and WebCrypto
    // still refuses the key material. It falls through `describeTokenError`'s default arm, which
    // returns the message verbatim — so the message itself has to be safe to hand back.
    const corrupted = { ...keyA.publicJwk, x: 'AAAA' }
    fetchMock.mockImplementationOnce(async () => Response.json({ keys: [corrupted] }))
    const token = await mintToken({}, keyA.privateJwk)

    const rejection = await verifyAccessToken(
      envWith({ AUTH_JWKS_URL: 'https://auth.test/corrupt-key.json' }),
      token,
    ).then(
      () => null,
      (error: unknown) => error as Error,
    )

    expect(rejection).toBeInstanceOf(Error)
    expect(rejection?.name).toBe('DataError')
    // Nothing the WebCrypto failure says may carry a fragment of the credential.
    expect(rejection?.message).not.toContain(token)
    for (const part of token.split('.')) {
      expect(rejection?.message).not.toContain(part.slice(0, 12))
    }
  })

  it('rejects a key whose type does not match the EdDSA the Worker pins', async () => {
    const wrongType = { ...keyA.publicJwk, kty: 'RSA' }
    fetchMock.mockImplementationOnce(async () => Response.json({ keys: [wrongType] }))
    const token = await mintToken({}, keyA.privateJwk)

    await expect(
      verifyAccessToken(envWith({ AUTH_JWKS_URL: 'https://auth.test/wrong-kty.json' }), token),
    ).rejects.toThrow()
  })
})
