import { describe, expect, it } from 'vitest'
import { echoOf, gateway } from '../helpers/gateway'
import type { ModuleName } from '../stubs'

const MODULES: ModuleName[] = ['landing', 'auth', 'cms']

/** Headers a real caller sends that are not Content-Type or Authorization. */
const EXTRA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (test)',
  'CF-Connecting-IP': '203.0.113.7',
  Cookie: 'session=abc123',
  'Accept-Language': 'es-CL',
  'X-Requested-With': 'XMLHttpRequest',
}

describe.each(MODULES)('/%s/* proxy', (module) => {
  const path = (suffix: string) => `/${module}${suffix}`

  describe('path rewriting', () => {
    it('strips the module prefix', async () => {
      const echoed = await echoOf(await gateway(path('/stats/github')))

      expect(echoed.module).toBe(module)
      expect(echoed.pathname).toBe('/stats/github')
    })

    it('rewrites the bare prefix to the module root', async () => {
      const echoed = await echoOf(await gateway(path('')))

      expect(echoed.pathname).toBe('/')
    })

    it('rewrites a trailing slash to the module root as well', async () => {
      const echoed = await echoOf(await gateway(path('/')))

      expect(echoed.pathname).toBe('/')
    })

    it('strips only the leading occurrence of the prefix', async () => {
      const echoed = await echoOf(await gateway(path(`/${module}/nested`)))

      expect(echoed.pathname).toBe(`/${module}/nested`)
    })

    it('keeps a deep path intact', async () => {
      const echoed = await echoOf(await gateway(path('/a/b/c/d.json')))

      expect(echoed.pathname).toBe('/a/b/c/d.json')
    })

    it('does not touch the host the module sees as its own path', async () => {
      const echoed = await echoOf(await gateway(path('/.well-known/jwks.json')))

      expect(echoed.pathname).toBe('/.well-known/jwks.json')
    })
  })

  describe('query string', () => {
    it('forwards the query string untouched', async () => {
      const echoed = await echoOf(await gateway(path('/search?q=hono&page=2')))

      expect(echoed.search).toBe('?q=hono&page=2')
      expect(echoed.pathname).toBe('/search')
    })

    it('forwards repeated and percent-encoded parameters', async () => {
      const echoed = await echoOf(await gateway(path('/search?tag=a&tag=b&q=caf%C3%A9%20con%20leche')))

      expect(echoed.search).toBe('?tag=a&tag=b&q=caf%C3%A9%20con%20leche')
    })

    it('forwards a query string hanging off the bare prefix', async () => {
      const echoed = await echoOf(await gateway(path('?redirect_uri=https%3A%2F%2Ffranciscosolis.cl')))

      expect(echoed.pathname).toBe('/')
      expect(echoed.search).toBe('?redirect_uri=https%3A%2F%2Ffranciscosolis.cl')
    })

    it('leaves the search empty when there is none', async () => {
      const echoed = await echoOf(await gateway(path('/thing')))

      expect(echoed.search).toBe('')
    })
  })

  describe('method and body', () => {
    it.each(['GET', 'HEAD', 'DELETE'])('forwards a %s unchanged', async (method) => {
      const response = await gateway(path('/thing'), { method })

      expect(response.headers.get('X-Stub-Module')).toBe(module)
      if (method !== 'HEAD') {
        expect((await echoOf(response)).method).toBe(method)
      }
    })

    it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('forwards the body of a %s', async (method) => {
      const payload = JSON.stringify({ title: 'Añoranza', tags: ['a', 'b'] })
      const echoed = await echoOf(await gateway(path('/entries'), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }))

      expect(echoed.method).toBe(method)
      expect(echoed.body).toBe(payload)
    })

    it('forwards a form-encoded body byte for byte', async () => {
      const payload = 'grant_type=authorization_code&code=abc&code_verifier=xyz'
      const echoed = await echoOf(await gateway(path('/oauth/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload,
      }))

      expect(echoed.body).toBe(payload)
      expect(echoed.headers['content-type']).toBe('application/x-www-form-urlencoded')
    })

    it('forwards an empty body as no body', async () => {
      const echoed = await echoOf(await gateway(path('/entries'), { method: 'POST' }))

      expect(echoed.method).toBe('POST')
      expect(echoed.body).toBeNull()
    })
  })

  describe('upstream response', () => {
    it('returns the upstream status untouched', async () => {
      const response = await gateway(path('/boom'))

      expect(response.status).toBe(500)
      await expect(response.text()).resolves.toBe('upstream exploded')
    })

    it('returns upstream headers untouched', async () => {
      const response = await gateway(path('/thing'))

      expect(response.headers.get('X-Stub-Module')).toBe(module)
    })

    it('hands a 302 back to the caller instead of following it', async () => {
      const response = await gateway(path('/redirect'), { redirect: 'manual' })

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://example.test/callback?code=abc')
    })
  })
})

/**
 * The three proxies are not interchangeable: `/landing/*` rebuilds a two-header request while
 * `/auth/*` and `/cms/*` forward the caller's Request as it stands. That difference is deliberate —
 * these pin it so it cannot be flattened by accident.
 */
describe('header forwarding differs per module', () => {
  it('forwards only Content-Type and Authorization to landing', async () => {
    const echoed = await echoOf(await gateway('/landing/stats/github', {
      headers: { Authorization: 'Bearer landing-token', ...EXTRA_HEADERS },
    }))

    expect(echoed.headers).toEqual({ authorization: 'Bearer landing-token' })
  })

  it('forwards no headers at all to landing when the caller sent neither', async () => {
    const echoed = await echoOf(await gateway('/landing/stats/github', { headers: EXTRA_HEADERS }))

    // The handler still sets both, as empty strings; an empty header value is dropped on the wire.
    expect(echoed.headers).toEqual({})
  })

  it('forwards Content-Type to landing alongside the body', async () => {
    const echoed = await echoOf(await gateway('/landing/stats/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...EXTRA_HEADERS },
      body: '{"a":1}',
    }))

    expect(echoed.headers['content-type']).toBe('application/json')
    expect(echoed.headers).not.toHaveProperty('cookie')
    expect(echoed.headers).not.toHaveProperty('user-agent')
    expect(echoed.body).toBe('{"a":1}')
  })

  it.each(['auth', 'cms'])('forwards the whole request to %s', async (module) => {
    const echoed = await echoOf(await gateway(`/${module}/probe`, {
      headers: { Authorization: 'Bearer token', ...EXTRA_HEADERS },
    }))

    expect(echoed.headers).toMatchObject({
      authorization: 'Bearer token',
      'user-agent': 'Mozilla/5.0 (test)',
      'cf-connecting-ip': '203.0.113.7',
      cookie: 'session=abc123',
      'accept-language': 'es-CL',
      'x-requested-with': 'XMLHttpRequest',
    })
  })

  it.each(['auth', 'cms'])('does not drop the audit headers %s needs', async (module) => {
    const echoed = await echoOf(await gateway(`/${module}/probe`, { headers: EXTRA_HEADERS }))

    expect(echoed.headers['cf-connecting-ip']).toBe('203.0.113.7')
    expect(echoed.headers['user-agent']).toBe('Mozilla/5.0 (test)')
  })

  it('drops from landing the very headers auth keeps', async () => {
    const toLanding = await echoOf(await gateway('/landing/probe', { headers: EXTRA_HEADERS }))
    const toAuth = await echoOf(await gateway('/auth/probe', { headers: EXTRA_HEADERS }))

    for (const header of ['user-agent', 'cf-connecting-ip', 'cookie']) {
      expect(toLanding.headers).not.toHaveProperty(header)
      expect(toAuth.headers).toHaveProperty(header)
    }
  })
})

describe('/auth/* redirect handling', () => {
  it('hands back the 302 that carries the authorization code, with the code intact', async () => {
    const response = await gateway('/auth/redirect', { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.test/callback?code=abc')
    // Following it inside the Worker would have swallowed the 302 and returned the target's body.
    await expect(response.text()).resolves.toBe('')
  })
})
