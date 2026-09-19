import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { asEditor, generateKeyPair, mintToken, stubJwks, stubJwksFetch, testKeyPair } from '../helpers/tokens'

/**
 * The access gate, which is the only thing standing between the public internet and every write in
 * this Worker. It is the CMS Worker's gate, minted for the CMS's client id — the editor here is a
 * section of the CMS interface rather than a product of its own.
 */
const admin = (path = '/admin/me', init: RequestInit = {}) =>
  SELF.fetch(`https://marketplace.test${path}`, init)

const messageOf = async (response: Response) => (await response.json<{ error: string }>()).error

describe('the editorial gate', () => {
  it('lets a verified @franciscosolis.cl editor in', async () => {
    const response = await admin('/admin/me', { headers: await asEditor() })

    expect(response.status).toBe(200)
    const { data } = await response.json<{ data: { email: string; client_id: string } }>()
    expect(data.email).toBe('fran@franciscosolis.cl')
    expect(data.client_id).toBe('franciscosolis-marketplace')
  })

  it('refuses a request with no token at all', async () => {
    const response = await admin()

    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('Bearer')
  })

  it.each([
    ['a scheme that is not Bearer', 'Basic abc'],
    ['a Bearer with nothing after it', 'Bearer'],
    ['an empty Bearer', 'Bearer    '],
  ])('refuses %s', async (_label, authorization) => {
    expect((await admin('/admin/me', { headers: { Authorization: authorization } })).status).toBe(401)
  })

  it('refuses a token signed by a key the auth service never published', async () => {
    const { publicJwk } = await testKeyPair()
    stubJwks([publicJwk])
    const stranger = await generateKeyPair('marketplace-test-key')

    const response = await admin('/admin/me', {
      headers: { Authorization: `Bearer ${await mintToken({}, stranger.privateJwk)}` },
    })

    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('signature')
  })

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const headers = await asEditor({ exp: now - 10, iat: now - 900 })

    const response = await admin('/admin/me', { headers })

    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('expired')
  })

  /**
   * The redaction that matters: several `hono/jwt` errors embed the offending token in their
   * message, which would echo a live credential into a response body and any log capturing it.
   */
  it('never echoes the token back in the error it returns', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await mintToken({ exp: now - 10 })
    const { publicJwk } = await testKeyPair()
    stubJwks([publicJwk])

    const response = await admin('/admin/me', { headers: { Authorization: `Bearer ${token}` } })

    expect(await messageOf(response)).not.toContain(token)
  })

  it('refuses a token minted by a different issuer', async () => {
    const response = await admin('/admin/me', { headers: await asEditor({ iss: 'https://evil.test' }) })

    expect(response.status).toBe(401)
  })

  /** A token minted for the public website is a valid token; it is just not one for this service. */
  it('refuses a token minted for another client application', async () => {
    const response = await admin('/admin/me', { headers: await asEditor({ aud: 'franciscosolis-web' }) })

    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('not issued for this service')
  })

  it('refuses an account whose email was never verified', async () => {
    const response = await admin('/admin/me', { headers: await asEditor({ email_verified: false }) })

    expect(response.status).toBe(403)
    expect(await messageOf(response)).toContain('verified email')
  })

  it('refuses an account outside the allowed domains', async () => {
    const response = await admin('/admin/me', { headers: await asEditor({ email: 'someone@gmail.com' }) })

    expect(response.status).toBe(403)
  })

  /** Matching is on the full domain label, never a suffix: a lookalike domain must not slip in. */
  it.each(['fran@notfranciscosolis.cl', 'fran@franciscosolis.cl.evil.com', 'fran@evil.com'])(
    'refuses %s',
    async (email) => {
      expect((await admin('/admin/me', { headers: await asEditor({ email }) })).status).toBe(403)
    },
  )

  it('refuses a malformed token without reaching the key set', async () => {
    const asked = stubJwksFetch(async () => Response.json({ keys: [] }))

    const response = await admin('/admin/me', { headers: { Authorization: 'Bearer not.a.token' } })

    expect(response.status).toBe(401)
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('every editorial route is behind the gate', () => {
  it.each([
    ['GET', '/admin/products'],
    ['POST', '/admin/products'],
    ['GET', '/admin/audit'],
    ['GET', '/admin/products/whatever/releases'],
    ['GET', '/admin/products/whatever/wiki'],
  ])('%s %s answers 401 without a token', async (method, path) => {
    expect((await admin(path, { method })).status).toBe(401)
  })
})
