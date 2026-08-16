import { describe, expect, it } from 'vitest'
import { BASE_URL, echoOf, fetcher, gateway, gatewayWithBindings } from '../helpers/gateway'
import type { Env } from '@/env'
import type { ModuleName } from '../stubs'

const MODULES: ModuleName[] = ['landing', 'auth', 'cms']

/** The binding name each proxied prefix forwards to. */
const BINDING_OF: Record<ModuleName, keyof Env> = { landing: 'LANDING', auth: 'AUTH', cms: 'CMS' }

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

    // The handler spells this as `replace(...) || '/'`, but the `|| '/'` half is unreachable: the
    // WHATWG URL setter normalizes an assigned empty pathname to '/' on its own. What is pinned
    // here is the observable outcome, not that particular fallback.
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

  /**
   * Only the path prefix may be rewritten. The modules build absolute URLs out of the request they
   * receive — `auth` derives its OAuth `redirect_uri` allowlist and its JWT issuer from it — so a
   * proxy that quietly changed the scheme, host or port would break sign-in everywhere while still
   * forwarding the right path.
   */
  describe('forwarded origin', () => {
    it('hands the module the caller origin, not an internal one', async () => {
      const echoed = await echoOf(await gateway(path('/thing')))

      expect(echoed.origin).toBe(BASE_URL)
    })

    it('rebuilds the URL as the caller one with only the prefix removed', async () => {
      const echoed = await echoOf(await gateway(path('/oauth/authorize?client_id=web&scope=openid')))

      expect(echoed.url).toBe(`${BASE_URL}/oauth/authorize?client_id=web&scope=openid`)
    })

    it('keeps the origin on the bare prefix too', async () => {
      const echoed = await echoOf(await gateway(path('')))

      expect(echoed.url).toBe(`${BASE_URL}/`)
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
    // The stub reports the method it saw as a header as well as in the echoed body, because a HEAD
    // is answered with no body — the header is the only way to see that HEAD arrived as HEAD and
    // was not quietly turned into a GET on the way.
    it.each(['GET', 'HEAD', 'DELETE'])('forwards a %s unchanged', async (method) => {
      const response = await gateway(path('/thing'), { method })

      expect(response.headers.get('X-Stub-Module')).toBe(module)
      expect(response.headers.get('X-Stub-Method')).toBe(method)
    })

    it('answers a HEAD with the headers of the GET and an empty body', async () => {
      const head = await gateway(path('/thing'), { method: 'HEAD' })

      expect(head.status).toBe(200)
      expect(head.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
      await expect(head.text()).resolves.toBe('')
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

/**
 * `/auth/*` is the only proxy that pins `redirect: 'manual'` on the Request it forwards, so that a
 * 302 carrying an authorization code reaches the browser instead of being followed inside the
 * Worker. An inbound Request already defaults to `manual` in production, which makes the pin
 * invisible to a plain end-to-end 302 assertion — the redirect mode has to be read off the Request
 * the binding actually received, from a caller whose own Request says `follow`.
 */
describe('/auth/* redirect handling', () => {
  const redirectModeSeenBy = async (module: ModuleName) => {
    let seen: Request['redirect'] | undefined
    await gatewayWithBindings(
      {
        [BINDING_OF[module]]: fetcher((request) => {
          seen = request.redirect
          return new Response(null, { status: 204 })
        }),
      },
      `/${module}/probe`,
      { redirect: 'follow' },
    )
    return seen
  }

  it('pins redirect: manual on the request handed to auth', async () => {
    await expect(redirectModeSeenBy('auth')).resolves.toBe('manual')
  })

  it.each(['landing', 'cms'] as const)('leaves the redirect mode alone for %s', async (module) => {
    await expect(redirectModeSeenBy(module)).resolves.toBe('follow')
  })

  it('hands back the 302 that carries the authorization code, with the code intact', async () => {
    const response = await gateway('/auth/redirect', { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.test/callback?code=abc')
    // Following it inside the Worker would have swallowed the 302 and returned the target's body.
    await expect(response.text()).resolves.toBe('')
  })

  it('does not follow the redirect even when the module answers a 302 to a reachable target', async () => {
    let followed = false
    const response = await gatewayWithBindings(
      {
        AUTH: fetcher((request) => {
          if (new URL(request.url).pathname === '/callback') {
            followed = true
            return new Response('landed on the target', { status: 200 })
          }
          return new Response(null, {
            status: 302,
            headers: { Location: `${BASE_URL}/callback?code=one-time` },
          })
        }),
      },
      '/auth/oauth/authorize',
      { redirect: 'follow' },
    )

    expect(followed).toBe(false)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(`${BASE_URL}/callback?code=one-time`)
  })
})
