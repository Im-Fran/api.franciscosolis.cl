import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { EchoedRequest } from '../stubs'

/**
 * The gateway has almost no logic of its own — it is its bindings. These cover the four things
 * that have to hold for it to be doing its job at all: it answers, it forwards over the service
 * bindings with the prefix stripped, it merges the modules' specs, and it does not follow the
 * redirect that carries an authorization code.
 */
describe('gateway smoke', () => {
  it('answers its own root with the module list', async () => {
    const response = await SELF.fetch('https://api.test/')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 200,
      data: { message: '¡Hello, API!', modules: ['landing', 'auth', 'cms'] },
    })
  })

  it.each([
    ['landing', '/landing/stats/github', '/stats/github'],
    ['auth', '/auth/.well-known/jwks.json', '/.well-known/jwks.json'],
    ['cms', '/cms/content/projects', '/content/projects'],
  ])('forwards to the %s binding with the prefix stripped', async (module, requested, forwarded) => {
    const response = await SELF.fetch(`https://api.test${requested}`)
    const echoed = await response.json<EchoedRequest>()

    expect(echoed.module).toBe(module)
    expect(echoed.pathname).toBe(forwarded)
  })

  it('merges each module spec under its own prefix', async () => {
    const response = await SELF.fetch('https://api.test/openapi.json')
    const spec = await response.json<{ paths: Record<string, unknown> }>()

    // The gateway's own routes survive the merge, and a module's `/` collapses onto the bare prefix
    // rather than becoming `/landing/`.
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/', '/landing', '/landing/thing', '/auth/thing', '/cms/thing']),
    )
  })

  it('hands a 302 from auth back to the caller instead of following it', async () => {
    const response = await SELF.fetch('https://api.test/auth/redirect', { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.test/callback?code=abc')
  })
})
