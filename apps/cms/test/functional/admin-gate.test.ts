import { SELF, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Jwk, KeyPair } from '../helpers/tokens'
import { editorClaims, forgeToken, generateKeyPair, mintRawToken, mintToken, stubJwks, testKeyPair } from '../helpers/tokens'

/**
 * `requireEditor`, the gate every editorial route sits behind.
 *
 * The 401/403 split is deliberate and worth pinning: 401 means "this token does not check out",
 * 403 means "it does, and you still may not come in". The second is the actual access rule.
 */

let keys: KeyPair
let jwksFetch: ReturnType<typeof stubJwks>

const request = async (token: string | null, path = '/admin/me') =>
  SELF.fetch(`https://cms.internal${path}`, {
    headers: token === null ? {} : { Authorization: token },
  })

const errorOf = async (response: Response) => (await response.json<{ code: number; error: string }>()).error

beforeAll(async () => {
  keys = await testKeyPair()
  jwksFetch = stubJwks([keys.publicJwk])
})

describe('a valid editor token', () => {
  it('is let in and described by /admin/me', async () => {
    const token = await mintToken({ sub: 'editor-7', roles: ['editor'], permissions: ['cms:write'] })
    const response = await request(`Bearer ${token}`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      code: 200,
      data: {
        id: 'editor-7',
        email: 'fran@franciscosolis.cl',
        name: 'Francisco Solis',
        picture: null,
        roles: ['editor'],
        permissions: ['cms:write'],
        application_id: 'franciscosolis-cms',
        session_id: 'session-1',
      },
    })
  })

  it('is never cached', async () => {
    const response = await request(`Bearer ${await mintToken()}`)

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('accepts a lowercase `bearer` scheme', async () => {
    const response = await request(`bearer ${await mintToken()}`)

    expect(response.status).toBe(200)
  })

  it('lowercases the address it records as the editor', async () => {
    const response = await request(`Bearer ${await mintToken({ email: 'Fran@FranciscoSolis.CL' })}`)
    const body = await response.json<{ data: { email: string } }>()

    expect(response.status).toBe(200)
    expect(body.data.email).toBe('fran@franciscosolis.cl')
  })

  it('defaults every optional claim rather than echoing undefined', async () => {
    const {
      roles: _roles,
      permissions: _permissions,
      name: _name,
      picture: _picture,
      ...claims
    } = editorClaims()
    const response = await request(`Bearer ${await mintRawToken(claims)}`)
    const body = await response.json<{
      data: { roles: string[]; permissions: string[]; name: string | null; picture: string | null }
    }>()

    expect(body.data.roles).toEqual([])
    expect(body.data.permissions).toEqual([])
    expect(body.data.name).toBeNull()
    expect(body.data.picture).toBeNull()
  })
})

describe('401 — the token itself does not check out', () => {
  it('refuses a request with no Authorization header', async () => {
    const response = await request(null)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('A Bearer access token is required')
  })

  it('refuses a non-Bearer scheme', async () => {
    expect((await request('Basic dXNlcjpwYXNz')).status).toBe(401)
    expect((await request(`Token ${await mintToken()}`)).status).toBe(401)
  })

  it('refuses a Bearer header with nothing after it', async () => {
    expect((await request('Bearer')).status).toBe(401)
    expect((await request('Bearer ')).status).toBe(401)
    expect((await request('Bearer    ')).status).toBe(401)
  })

  it('refuses a string that is not a JWT', async () => {
    const response = await request('Bearer not-a-jwt')

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token is malformed')
  })

  it('refuses a JWT whose header carries no algorithm', async () => {
    const token = forgeToken({ typ: 'JWT', kid: keys.kid }, editorClaims() as unknown as Record<string, unknown>)
    const response = await request(`Bearer ${token}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token is malformed')
  })

  it('refuses a JWT that claims a different algorithm', async () => {
    // An `alg` swap is the classic downgrade attempt; the verifier pins EdDSA.
    const token = forgeToken(
      { alg: 'HS256', typ: 'JWT', kid: keys.kid },
      editorClaims() as unknown as Record<string, unknown>,
    )
    const response = await request(`Bearer ${token}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the signature could not be verified')
  })

  it('refuses a token signed by an impostor key published under the same kid', async () => {
    const impostor = await generateKeyPair(keys.kid)
    const token = await mintToken({}, impostor.privateJwk)
    const response = await request(`Bearer ${token}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the signature could not be verified')
  })

  it('refuses a token from another issuer', async () => {
    const response = await request(`Bearer ${await mintToken({ iss: 'https://evil.test' })}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token was issued by a different service')
  })

  it('refuses a token minted for the public website', async () => {
    // A perfectly valid token that is simply not a CMS token.
    const response = await request(`Bearer ${await mintToken({ aud: 'franciscosolis-web' })}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token was not issued for the CMS')
  })

  it('refuses a token with no audience claim', async () => {
    const { aud: _aud, ...claims } = editorClaims()
    const response = await request(`Bearer ${await mintRawToken(claims)}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token was not issued for the CMS')
  })

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const response = await request(`Bearer ${await mintToken({ iat: now - 100, exp: now - 1 })}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token has expired')
  })

  it('refuses a token issued in the future', async () => {
    const now = Math.floor(Date.now() / 1000)
    const response = await request(`Bearer ${await mintToken({ iat: now + 600, exp: now + 1200 })}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token is not valid yet')
  })

  it('refuses a token that is not valid yet', async () => {
    const now = Math.floor(Date.now() / 1000)
    const response = await request(`Bearer ${await mintToken({ nbf: now + 600 } as never)}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe('Invalid access token: the token is not valid yet')
  })

  it('refuses a token signed with a key that was never published', async () => {
    const stranger = await generateKeyPair('unpublished-kid')
    const response = await request(`Bearer ${await mintToken({}, stranger.privateJwk)}`)

    expect(response.status).toBe(401)
    expect(await errorOf(response)).toBe(
      'Invalid access token: no published key matches kid "unpublished-kid"',
    )
  })
})

describe('the error message never echoes the credential', () => {
  // Several `hono/jwt` errors embed the offending token in their message. Returning one would put
  // a live credential in a response body, a browser console and every log that captures either.
  const cases = async () => {
    const now = Math.floor(Date.now() / 1000)
    const impostor = await generateKeyPair(keys.kid)
    return [
      { label: 'expired', token: await mintToken({ iat: now - 100, exp: now - 1 }) },
      { label: 'not yet valid', token: await mintToken({ nbf: now + 600 } as never) },
      { label: 'bad signature', token: await mintToken({}, impostor.privateJwk) },
      { label: 'wrong audience', token: await mintToken({ aud: 'franciscosolis-web' }) },
    ]
  }

  it('keeps the token out of every redacted message', async () => {
    for (const { label, token } of await cases()) {
      const response = await request(`Bearer ${token}`)
      const body = await response.text()

      expect(response.status, label).toBe(401)
      expect(body, label).not.toContain(token)
      // Not even a fragment long enough to be useful.
      expect(body, label).not.toContain(token.split('.')[2]?.slice(0, 20))
    }
  })

  it('keeps the claims out of the message when the audience is missing', async () => {
    const { aud: _aud, ...claims } = editorClaims({ sub: 'leak-canary' })
    const response = await request(`Bearer ${await mintRawToken(claims)}`)

    expect(await response.text()).not.toContain('leak-canary')
  })
})

describe('403 — the token checks out but the account may not come in', () => {
  it('refuses an account whose address is not verified', async () => {
    const response = await request(`Bearer ${await mintToken({ email_verified: false })}`)

    expect(response.status).toBe(403)
    expect(await errorOf(response)).toBe('This account has no verified email address')
  })

  it('refuses a verified address on an outside domain', async () => {
    const response = await request(`Bearer ${await mintToken({ email: 'someone@gmail.com' })}`)

    expect(response.status).toBe(403)
    expect(await errorOf(response)).toBe('This account is not allowed to access the CMS')
  })

  it('refuses the suffix and prefix lookalikes of the allowed domain', async () => {
    const lookalikes = [
      'attacker@notfranciscosolis.cl',
      'attacker@franciscosolis.cl.evil.com',
      'attacker@franciscosolis.club',
      'attacker@mail.franciscosolis.cl',
    ]

    for (const email of lookalikes) {
      const response = await request(`Bearer ${await mintToken({ email })}`)
      expect(response.status, email).toBe(403)
    }
  })

  it('checks the verified flag before the domain, so an unverified insider is refused too', async () => {
    const response = await request(`Bearer ${await mintToken({ email_verified: false })}`)

    expect(await errorOf(response)).toBe('This account has no verified email address')
  })
})

describe('the gate covers every editorial route', () => {
  const routes = [
    ['GET', '/admin/me'],
    ['GET', '/admin/audit'],
    ['GET', '/admin/content/projects'],
    ['POST', '/admin/content/projects'],
    ['POST', '/admin/content/projects/reorder'],
    ['GET', '/admin/content/projects/some-id'],
    ['PATCH', '/admin/content/projects/some-id'],
    ['DELETE', '/admin/content/projects/some-id'],
    ['GET', '/admin/legal'],
    ['POST', '/admin/legal'],
    ['GET', '/admin/legal/some-id'],
    ['PATCH', '/admin/legal/some-id'],
    ['DELETE', '/admin/legal/some-id'],
    ['GET', '/admin/email-templates'],
    ['POST', '/admin/email-templates'],
    ['GET', '/admin/email-templates/some-id'],
    ['PATCH', '/admin/email-templates/some-id'],
    ['DELETE', '/admin/email-templates/some-id'],
    ['GET', '/admin/emails'],
    ['POST', '/admin/emails'],
    ['GET', '/admin/emails/some-id'],
  ] as const

  it('answers 401 without a token, whatever the verb', async () => {
    for (const [method, path] of routes) {
      const response = await SELF.fetch(`https://cms.internal${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      })

      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  it('answers 403 for an outsider, before any body validation runs', async () => {
    // The gate is mounted on `/admin/*`, so it fires ahead of the per-route validators — an
    // outsider never learns whether their payload would have been accepted.
    const token = `Bearer ${await mintToken({ email: 'someone@gmail.com' })}`

    for (const [method, path] of routes) {
      const response = await SELF.fetch(`https://cms.internal${path}`, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : 'not even json',
      })

      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })
})

describe('when the key set cannot be fetched', () => {
  it('refuses the request with the reason, which carries no credential', async () => {
    // Pointed at another URL so the per-isolate cache cannot answer from memory.
    const original = env.AUTH_JWKS_URL
    env.AUTH_JWKS_URL = 'https://auth.test/unreachable.json'
    jwksFetch.mockImplementationOnce(async () => new Response('gone', { status: 503 }))

    const token = await mintToken()
    const response = await request(`Bearer ${token}`)
    const body = await response.text()
    env.AUTH_JWKS_URL = original

    expect(response.status).toBe(401)
    expect(body).toContain('JWKS endpoint answered 503')
    expect(body).not.toContain(token)
  })

  it('recovers once the endpoint is back', async () => {
    const response = await request(`Bearer ${await mintToken()}`)

    expect(response.status).toBe(200)
  })
})

describe('the JWKS is fetched, not assumed', () => {
  it('asks the configured endpoint for JSON', () => {
    expect(jwksFetch).toHaveBeenCalledWith(env.AUTH_JWKS_URL, { headers: { Accept: 'application/json' } })
  })

  it('publishes only the public half of the key', async () => {
    const published = (await (await jwksFetch()).json<{ keys: Jwk[] }>()).keys[0]

    expect(published).not.toHaveProperty('d')
    expect(published?.kid).toBe(keys.kid)
  })
})
