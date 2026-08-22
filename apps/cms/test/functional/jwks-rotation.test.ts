import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Jwk, KeyPair } from '../helpers/tokens'
import { generateKeyPair, mintToken, stubJwksFetch } from '../helpers/tokens'

/**
 * The per-isolate JWKS cache, seen from the request path.
 *
 * This file owns the cache for its whole run — the tests read in order, and the fetch counter is
 * never reset. What they pin is the trade the cache makes: one fetch per isolate for the common
 * case, one extra fetch to survive a key rotation, and no retry loop when a kid is simply unknown.
 */

let keyA: KeyPair
let keyB: KeyPair
let published: Jwk[]
/** Consumed by the next actual fetch, so a test can tell "endpoint down" from "never asked". */
let failure: Error | null = null
let jwksFetch: ReturnType<typeof stubJwksFetch>

const fetchCount = () => jwksFetch.mock.calls.length

const me = (token: string) =>
  SELF.fetch('https://cms.internal/admin/me', { headers: { Authorization: `Bearer ${token}` } })

const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error

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

describe('the key set is fetched once per isolate', () => {
  it('fetches it on the first authenticated request', async () => {
    const response = await me(await mintToken({}, keyA.privateJwk))

    expect(response.status).toBe(200)
    expect(fetchCount()).toBe(1)
  })

  it('serves the next request from the cache', async () => {
    const response = await me(await mintToken({}, keyA.privateJwk))

    expect(response.status).toBe(200)
    expect(fetchCount()).toBe(1)
  })

  it('keeps working while the JWKS endpoint is down, which is the point of caching it', async () => {
    failure = new Error('auth is down')

    const response = await me(await mintToken({}, keyA.privateJwk))
    const wasAsked = failure === null
    failure = null

    expect(response.status).toBe(200)
    expect(wasAsked).toBe(false)
    expect(fetchCount()).toBe(1)
  })
})

describe('a key rotation on the auth side', () => {
  it('costs exactly one extra fetch and then succeeds', async () => {
    // Without the forced refetch this would be up to an hour of rejected sign-ins.
    published = [keyB.publicJwk]
    const before = fetchCount()

    const response = await me(await mintToken({ sub: 'rotated' }, keyB.privateJwk))
    const body = await response.json<{ data: { id: string } }>()

    expect(response.status).toBe(200)
    expect(body.data.id).toBe('rotated')
    expect(fetchCount()).toBe(before + 1)
  })

  it('serves the rotated key from the cache afterwards', async () => {
    const before = fetchCount()

    expect((await me(await mintToken({}, keyB.privateJwk))).status).toBe(200)
    expect(fetchCount()).toBe(before)
  })

  it('retires the old key, and says so without echoing the token', async () => {
    const before = fetchCount()
    const token = await mintToken({}, keyA.privateJwk)

    const response = await me(token)
    const message = await errorOf(response)

    expect(response.status).toBe(401)
    expect(message).toBe('Invalid access token: no published key matches kid "key-a"')
    expect(message).not.toContain(token)
    expect(fetchCount()).toBe(before + 1)
  })
})

describe('an unknown kid', () => {
  it('costs one fetch per attempt, never a loop', async () => {
    const stranger = await generateKeyPair('key-c')
    const before = fetchCount()

    expect((await me(await mintToken({}, stranger.privateJwk))).status).toBe(401)
    expect(fetchCount()).toBe(before + 1)

    expect((await me(await mintToken({}, stranger.privateJwk))).status).toBe(401)
    expect(fetchCount()).toBe(before + 2)
  })

  it('is refused when the forced refetch itself fails', async () => {
    failure = new Error('auth is down')
    const stranger = await generateKeyPair('key-d')

    const response = await me(await mintToken({}, stranger.privateJwk))

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: auth is down')
    expect(failure).toBeNull()
  })

  it('leaves the cached set intact for a known kid', async () => {
    expect((await me(await mintToken({}, keyB.privateJwk))).status).toBe(200)
  })
})

describe('the key set is read over the AUTH service binding, never over the public internet', () => {
  it('verifies a token with global fetch made unusable', async () => {
    // The regression this file exists to hold. `api.franciscosolis.cl` is answered entirely by
    // Workers, and a Worker's subrequest to its own zone is sent to the zone's origin instead of
    // back through Workers routing — so the published JWKS URL answered 522 from in here and the
    // gate refused every token ever presented to it. Reading the set over the binding is what
    // fixed it, and a global `fetch` that throws is what keeps it fixed.
    const escaped = vi.fn(async () => {
      throw new Error('lib/jwks.ts must not reach the JWKS over global fetch')
    })
    vi.stubGlobal('fetch', escaped)

    try {
      // A kid the cache has never seen, so the key set genuinely has to be fetched again.
      const rotated = await generateKeyPair('key-binding')
      published = [rotated.publicJwk]

      const response = await me(await mintToken({ sub: 'over-the-binding' }, rotated.privateJwk))

      expect(response.status).toBe(200)
      expect(escaped).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      published = [keyB.publicJwk]
    }
  })
})

describe('the public routes never touch the JWKS', () => {
  it('serves published content without a single fetch', async () => {
    const before = fetchCount()

    await SELF.fetch('https://cms.internal/')
    await SELF.fetch('https://cms.internal/collections')
    await SELF.fetch('https://cms.internal/content/projects')
    await SELF.fetch('https://cms.internal/legal')

    expect(fetchCount()).toBe(before)
  })

  it('does not fetch it for a request with no token either', async () => {
    const before = fetchCount()

    expect((await SELF.fetch('https://cms.internal/admin/me')).status).toBe(401)
    expect(fetchCount()).toBe(before)
  })
})
