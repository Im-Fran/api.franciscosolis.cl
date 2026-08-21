import { describe, expect, it } from 'vitest'
import { FALLBACK_ORIGIN, isAllowedOrigin, resolveAllowedOrigin } from '@/cors'

describe('isAllowedOrigin', () => {
  it.each([
    ['the apex domain', 'https://franciscosolis.cl'],
    ['a subdomain', 'https://www.franciscosolis.cl'],
    ['a deeper subdomain', 'https://preview.staging.franciscosolis.cl'],
    ['the account workers.dev subdomain', 'https://franciscosolis.workers.dev'],
    ['a Cloudflare preview deployment', 'https://abc123-franciscosolis.franciscosolis.workers.dev'],
    ['the Vite dev server', 'http://localhost:5173'],
    ['the Vite dev server over https', 'https://localhost:5173'],
  ])('accepts %s', (_label, origin) => {
    expect(isAllowedOrigin(origin)).toBe(true)
  })

  it.each([
    // Each of these ends with a string of ours but is a domain someone else can register.
    ['a lookalike apex', 'https://evilfranciscosolis.cl'],
    ['a lookalike workers.dev host', 'https://notfranciscosolis.workers.dev'],
    ['a lookalike dev host', 'http://evil-localhost:5173'],
    ['our host under an attacker domain', 'https://franciscosolis.cl.evil.com'],
    ['our host on another port', 'https://franciscosolis.cl:8443'],
    ['our host over plain http', 'http://franciscosolis.cl'],
    // Shapes a header can carry that are not an origin at all.
    ['a trailing slash', 'https://franciscosolis.cl/'],
    ['an origin with a path', 'https://franciscosolis.cl/auth'],
    ['userinfo pointing elsewhere', 'https://franciscosolis.cl@evil.com'],
    ['an opaque origin', 'null'],
    ['an empty origin', ''],
  ])('refuses %s', (_label, origin) => {
    expect(isAllowedOrigin(origin)).toBe(false)
  })
})

describe('resolveAllowedOrigin', () => {
  it('echoes an allowed origin and answers anything else with the canonical one', () => {
    expect(resolveAllowedOrigin('https://franciscosolis.cl')).toBe('https://franciscosolis.cl')
    expect(resolveAllowedOrigin('https://evil.com')).toBe(FALLBACK_ORIGIN)
    expect(resolveAllowedOrigin(undefined)).toBe(FALLBACK_ORIGIN)
  })
})
