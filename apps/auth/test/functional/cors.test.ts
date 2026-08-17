import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApplication, SEED } from '../helpers/db'

const fetchWithOrigin = (path: string, origin: string | null, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal${path}`, {
    ...init,
    headers: { ...(origin ? { Origin: origin } : {}), ...(init.headers ?? {}) },
  })

const preflight = (path: string, origin: string) =>
  fetchWithOrigin(path, origin, {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
  })

describe('cross-origin access to the OAuth endpoints', () => {
  it('allows an origin a registered client actually redirects to', async () => {
    const response = await preflight('/oauth/token', 'https://franciscosolis.cl')

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://franciscosolis.cl')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  it('allows an origin listed explicitly on a client, even with no redirect URI there', async () => {
    await createApplication({
      redirectUris: ['https://elsewhere.test/cb'],
      allowedOrigins: ['https://console.partner.test'],
    })

    const response = await preflight('/oauth/token', 'https://console.partner.test')

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://console.partner.test')
  })

  it('picks the origin out of a redirect URI, not the whole URI', async () => {
    await createApplication({ redirectUris: ['https://spa.partner.test/auth/callback'] })

    expect((await preflight('/oauth/token', 'https://spa.partner.test')).status).toBe(204)
    expect((await preflight('/oauth/token', 'https://spa.partner.test/auth')).status).toBe(403)
  })

  it('refuses an origin no client registered', async () => {
    const response = await preflight('/oauth/token', 'https://evil.test')

    expect(response.status).toBe(403)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('refuses the origin of a deactivated client', async () => {
    await createApplication({ redirectUris: ['https://retired.test/cb'], isActive: false })

    expect((await preflight('/oauth/token', 'https://retired.test')).status).toBe(403)
  })

  it('echoes the allowed origin on the real response, not just the preflight', async () => {
    const response = await fetchWithOrigin('/.well-known/jwks.json', 'https://franciscosolis.cl')

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://franciscosolis.cl')
  })

  it('never allows credentials, since nothing here authenticates with a cookie', async () => {
    const response = await preflight('/oauth/token', 'https://franciscosolis.cl')

    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })

  it('varies on Origin, so a shared cache cannot serve one origin\'s answer to another', async () => {
    const allowed = await fetchWithOrigin('/.well-known/jwks.json', 'https://franciscosolis.cl')
    const refused = await fetchWithOrigin('/.well-known/jwks.json', 'https://evil.test')

    expect(allowed.headers.get('Vary')).toContain('Origin')
    expect(refused.headers.get('Vary')).toContain('Origin')
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('leaves the response alone when there is no Origin at all', async () => {
    const response = await fetchWithOrigin('/.well-known/jwks.json', null)

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('does not open the admin API to other origins', async () => {
    const response = await preflight('/admin/applications', 'https://franciscosolis.cl')

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('covers the endpoints a browser client actually calls', async () => {
    for (const path of ['/oauth/token', '/oauth/revoke', '/oauth/introspect', '/oauth/userinfo', '/me', '/magic-link']) {
      const response = await preflight(path, 'https://franciscosolis.cl')
      expect(response.status, path).toBe(204)
    }
  })

  it('still serves the seeded local development origin', async () => {
    const origin = new URL(SEED.webLocalRedirectUri).origin

    expect((await preflight('/oauth/token', origin)).status).toBe(204)
  })
})
