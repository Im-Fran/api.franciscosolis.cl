import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase } from '../helpers/db'
import { asAgent, forgeToken, generateKeyPair, mintToken, stubJwks, testKeyPair } from '../helpers/tokens'

const admin = (path = '/admin/me', init: RequestInit = {}) => SELF.fetch(`https://support.test${path}`, init)

const messageOf = async (response: Response) => ((await response.json()) as { error: string }).error

beforeEach(clearDatabase)

describe('the support console gate', () => {
  it('lets a support agent in and reports what they may do', async () => {
    const response = await admin('/admin/me', { headers: await asAgent() })
    expect(response.status).toBe(200)

    const body = (await response.json()) as { data: { email: string; can_administer: boolean } }
    expect(body.data.email).toBe('fran@franciscosolis.cl')
    expect(body.data.can_administer).toBe(true)
  })

  it.each([
    ['/admin/me'],
    ['/admin/audit'],
    ['/admin/tickets'],
    ['/admin/labels'],
  ])('refuses %s without a token', async (path) => {
    const response = await admin(path)
    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('Bearer access token is required')
  })

  it('refuses a token minted for another client application', async () => {
    const response = await admin('/admin/me', { headers: await asAgent({ aud: 'franciscosolis-web' }) })
    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('not issued for this service')
  })

  it('refuses an account whose address was never verified', async () => {
    const response = await admin('/admin/me', { headers: await asAgent({ email_verified: false }) })
    expect(response.status).toBe(403)
    expect(await messageOf(response)).toContain('no verified email address')
  })

  it.each([
    ['an outside address', 'someone@example.test'],
    // Matching is on the full domain label, never a suffix — both of these are hostnames anybody
    // can register, and a suffix check would have accepted both.
    ['a lookalike parent domain', 'attacker@notfranciscosolis.cl'],
    ['a lookalike subdomain', 'attacker@franciscosolis.cl.evil.test'],
  ])('refuses %s', async (_label, email) => {
    const response = await admin('/admin/me', { headers: await asAgent({ email }) })
    expect(response.status).toBe(403)
    expect(await messageOf(response)).toContain('not allowed into the support console')
  })

  it('refuses an allowed account that has not been made an agent', async () => {
    // The permission check is what `apps/cms` deliberately does without. A support
    // system cannot: "assign this ticket to somebody" is meaningless unless there is a defined set
    // of people, and the domain alone is not one.
    const response = await admin('/admin/me', { headers: await asAgent({ permissions: [] }) })
    expect(response.status).toBe(403)
    expect(await messageOf(response)).toContain('support:agent')
  })

  it('refuses an agent without support:admin from touching the label catalogue', async () => {
    const headers = await asAgent({ permissions: ['support:agent'] })
    // They can read it — answering tickets means seeing the labels.
    expect((await admin('/admin/labels', { headers })).status).toBe(200)

    const response = await admin('/admin/labels', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Escalation' }),
    })
    expect(response.status).toBe(403)
    expect(await messageOf(response)).toContain('support:admin')
  })

  it('refuses an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { publicJwk } = await testKeyPair()
    stubJwks([publicJwk])
    const token = await mintToken({ exp: now - 60, iat: now - 960 })

    const response = await admin('/admin/me', { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('expired')
  })

  it('refuses a token signed by a key the auth service never published', async () => {
    const { publicJwk } = await testKeyPair()
    stubJwks([publicJwk])
    const other = await generateKeyPair('support-test-key')
    const token = await mintToken({}, other.privateJwk)

    const response = await admin('/admin/me', { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(401)
  })

  it('refuses a token whose header names a key that does not exist', async () => {
    const { publicJwk } = await testKeyPair()
    stubJwks([publicJwk])
    const token = forgeToken({ alg: 'EdDSA', kid: 'made-up' }, { sub: 'x' })

    const response = await admin('/admin/me', { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(401)
    expect(await messageOf(response)).toContain('made-up')
  })

  it('never echoes the token back in the error it returns', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { publicJwk } = await testKeyPair()
    stubJwks([publicJwk])
    const token = await mintToken({ exp: now - 60, iat: now - 960 })

    const response = await admin('/admin/me', { headers: { Authorization: `Bearer ${token}` } })
    // Several hono/jwt errors embed the offending token in their message, which would put a live
    // credential in a response body and in every log that captures one.
    expect(await messageOf(response)).not.toContain(token)
  })
})
