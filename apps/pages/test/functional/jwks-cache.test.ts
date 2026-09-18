import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Jwk, KeyPair } from '../helpers/tokens'
import { forgeToken, generateKeyPair, mintToken, stubJwksFetch } from '../helpers/tokens'

/**
 * The per-isolate JWKS cache, seen from the request path.
 *
 * This file owns the cache for its whole run — the tests read in order and the fetch counter is
 * never reset, which is also why they cannot live in `admin-gate.test.ts`: the first successful
 * verification there warms the cache for an hour and every later stub goes unasked.
 *
 * What they pin is the trade the cache makes: one fetch per isolate for the common case, one extra
 * fetch to survive a key rotation, and no retry loop when a kid is simply unknown.
 */

let keyA: KeyPair
let keyB: KeyPair
let published: Jwk[]
/** Consumed by the next actual fetch, so a test can tell "endpoint down" from "never asked". */
let failure: Error | null = null
let jwksFetch: ReturnType<typeof stubJwksFetch>

const fetchCount = () => jwksFetch.mock.calls.length

const me = (token: string) =>
  SELF.fetch('https://pages.test/admin/me', { headers: { Authorization: `Bearer ${token}` } })

beforeAll(async () => {
  keyA = await generateKeyPair('key-a')
  keyB = await generateKeyPair('key-b')
  published = [keyA.publicJwk]
  jwksFetch = stubJwksFetch(async () => {
    if (failure) {
      const error = failure
      failure = null
      throw error
    }
    return Response.json({ keys: published })
  })
})

describe('the JWKS cache', () => {
  it('reads the key set over the AUTH binding, not over the public network', async () => {
    const response = await me(await mintToken({}, keyA.privateJwk))

    expect(response.status).toBe(200)
    expect(fetchCount()).toBe(1)
    expect(jwksFetch.mock.calls[0]?.[0]).toBe('https://auth.test/.well-known/jwks.json')
  })

  it('does not ask again for the next token signed by the same key', async () => {
    const response = await me(await mintToken({}, keyA.privateJwk))

    expect(response.status).toBe(200)
    expect(fetchCount()).toBe(1)
  })

  /**
   * A rotation on the auth side looks exactly like this from in here: a kid nobody has seen. One
   * forced refetch is what keeps it from meaning up to an hour of refused sign-ins.
   */
  it('refetches once for a kid it has never seen, which is what a key rotation is', async () => {
    published = [keyA.publicJwk, keyB.publicJwk]

    const response = await me(await mintToken({}, keyB.privateJwk))

    expect(response.status).toBe(200)
    expect(fetchCount()).toBe(2)
  })

  it('refuses an unknown kid after exactly one refetch, rather than looping', async () => {
    const before = fetchCount()

    const response = await me(forgeToken({ alg: 'EdDSA', kid: 'key-nobody-has' }, { sub: 'x' }))

    expect(response.status).toBe(401)
    expect(fetchCount()).toBe(before + 1)
  })

  it('answers 401 rather than 500 when the refetch cannot reach the auth Worker', async () => {
    failure = new Error('binding unreachable')

    const response = await me(forgeToken({ alg: 'EdDSA', kid: 'key-nobody-has' }, { sub: 'x' }))

    expect(response.status).toBe(401)
    await expect(response.json<{ error: string }>()).resolves.toMatchObject({
      error: expect.stringContaining('binding unreachable'),
    })
  })
})
