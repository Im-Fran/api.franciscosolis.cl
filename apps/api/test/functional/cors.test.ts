import { describe, expect, it } from 'vitest'
import { gateway } from '../helpers/gateway'

/** What a browser gets told when its origin is not on the allowlist: an origin that is not its own. */
const FALLBACK_ORIGIN = 'https://franciscosolis.cl'

const allowOriginFor = async (origin: string, path = '/') => {
  const response = await gateway(path, { headers: { Origin: origin } })
  return response.headers.get('Access-Control-Allow-Origin')
}

describe('CORS origin allowlist', () => {
  it.each([
    ['the Vite dev server', 'http://localhost:5173'],
    ['the Vite dev server over https', 'https://localhost:5173'],
    ['the apex domain', 'https://franciscosolis.cl'],
    ['a www subdomain', 'https://www.franciscosolis.cl'],
    ['a deeper subdomain', 'https://preview.staging.franciscosolis.cl'],
    ['a workers.dev preview', 'https://landing.franciscosolis.workers.dev'],
    ['the bare workers.dev domain', 'https://franciscosolis.workers.dev'],
  ])('echoes %s back', async (_label, origin) => {
    expect(await allowOriginFor(origin)).toBe(origin)
  })

  it.each([
    ['another localhost port', 'http://localhost:3000'],
    ['a longer localhost port', 'http://localhost:51730'],
    ['an unrelated site', 'https://evil.com'],
    ['the allowed host used as a subdomain of an attacker domain', 'https://franciscosolis.cl.evil.com'],
    ['the workers.dev host used as a subdomain of an attacker domain', 'https://franciscosolis.workers.dev.evil.com'],
    ['the apex on a non-default port', 'https://franciscosolis.cl:8443'],
    ['a sandboxed opaque origin', 'null'],
    ['an empty origin', ''],
  ])('refuses %s and falls back to the canonical origin', async (_label, origin) => {
    expect(await allowOriginFor(origin)).toBe(FALLBACK_ORIGIN)
  })

  it('falls back when the request carries no Origin at all', async () => {
    const response = await gateway('/')

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(FALLBACK_ORIGIN)
  })

  // The allowlist is a bare `endsWith`, with no separator before the allowed suffix, so a domain an
  // attacker can register is accepted as if it were ours. Pinned as current behaviour and reported
  // as a bug rather than fixed here.
  it.each([
    ['a lookalike apex domain', 'https://evilfranciscosolis.cl'],
    ['a lookalike workers.dev domain', 'https://notfranciscosolis.workers.dev'],
    ['a lookalike dev host', 'http://evil-localhost:5173'],
  ])('currently accepts %s, which is not ours', async (_label, origin) => {
    expect(await allowOriginFor(origin)).toBe(origin)
  })

  it('varies on Origin so the fallback is never cached for an allowed caller', async () => {
    const response = await gateway('/', { headers: { Origin: 'https://evil.com' } })

    expect(response.headers.get('Vary')).toContain('Origin')
  })

  it('applies the same allowlist to proxied routes', async () => {
    expect(await allowOriginFor('https://franciscosolis.cl', '/cms/content/projects')).toBe('https://franciscosolis.cl')
    expect(await allowOriginFor('https://evil.com', '/cms/content/projects')).toBe(FALLBACK_ORIGIN)
  })

  it('leaves the auth module to answer for itself, whatever the origin', async () => {
    // Its clients live on domains registered in its own database, which this allowlist cannot
    // describe — see `ownsCors` in src/services.ts.
    expect(await allowOriginFor('https://franciscosolis.cl', '/auth/thing')).toBeNull()
    expect(await allowOriginFor('https://evil.com', '/auth/thing')).toBeNull()
  })

  it('applies the same allowlist to 404s', async () => {
    const response = await gateway('/nope', { headers: { Origin: 'https://evil.com' } })

    expect(response.status).toBe(404)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(FALLBACK_ORIGIN)
  })
})

describe('CORS response headers', () => {
  it('exposes Content-Type to the caller', async () => {
    const response = await gateway('/', { headers: { Origin: 'https://franciscosolis.cl' } })

    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Content-Type')
  })

  it('never allows credentials', async () => {
    const response = await gateway('/', { headers: { Origin: 'https://franciscosolis.cl' } })

    expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
  })

  it('does not put preflight-only headers on a simple response', async () => {
    const response = await gateway('/', { headers: { Origin: 'https://franciscosolis.cl' } })

    expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull()
    expect(response.headers.get('Access-Control-Max-Age')).toBeNull()
  })
})

describe('CORS preflight', () => {
  const preflight = (path: string, method: string, origin = 'https://franciscosolis.cl') =>
    gateway(path, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
      },
    })

  it('answers 204 with no body', async () => {
    const response = await preflight('/cms/content/projects', 'POST')

    expect(response.status).toBe(204)
    await expect(response.text()).resolves.toBe('')
  })

  it('allows the write verbs the auth and cms modules need', async () => {
    const response = await preflight('/cms/content/projects', 'POST')

    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PATCH,DELETE,OPTIONS')
  })

  it('does not advertise PUT', async () => {
    const response = await preflight('/cms/content/projects/1', 'PUT')

    expect(response.headers.get('Access-Control-Allow-Methods')).not.toContain('PUT')
  })

  it('allows only Content-Type and Authorization as request headers', async () => {
    const response = await preflight('/cms/content/projects', 'POST')

    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type,Authorization')
  })

  it('lets the browser cache the preflight for ten minutes', async () => {
    const response = await preflight('/cms/content/projects', 'POST')

    expect(response.headers.get('Access-Control-Max-Age')).toBe('600')
  })

  it('varies on the requested headers as well as the origin', async () => {
    const response = await preflight('/cms/content/projects', 'POST')

    expect(response.headers.get('Vary')).toBe('Origin, Access-Control-Request-Headers')
  })

  /**
   * The preflight is the gate a browser actually goes through before the cross-origin POST/PATCH/
   * DELETE the allowlist exists for, so it has to echo an allowed origin rather than answer the
   * canonical one. Both origins here differ from the fallback, which is what makes an echo visible.
   */
  it.each([
    ['the Vite dev server', 'http://localhost:5173'],
    ['a workers.dev preview', 'https://landing.franciscosolis.workers.dev'],
  ])('echoes %s back on the preflight', async (_label, origin) => {
    const response = await preflight('/cms/content/projects', 'POST', origin)

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
  })

  it('applies the allowlist to a preflight for every proxied module', async () => {
    for (const path of ['/landing/stats/github', '/cms/content/projects']) {
      const allowed = await preflight(path, 'POST', 'http://localhost:5173')
      const refused = await preflight(path, 'POST', 'https://evil.com')

      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      expect(refused.headers.get('Access-Control-Allow-Origin')).toBe(FALLBACK_ORIGIN)
    }
  })

  it('still answers a disallowed origin, but with an origin that is not the caller', async () => {
    const response = await preflight('/cms/content/projects', 'POST', 'https://evil.com')

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(FALLBACK_ORIGIN)
  })

  it('short-circuits before routing, so an unknown path preflights too', async () => {
    const response = await preflight('/nope', 'GET')

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Max-Age')).toBe('600')
  })

  it('never reaches the upstream module', async () => {
    const response = await preflight('/landing/stats/github', 'GET')

    expect(response.headers.get('X-Stub-Module')).toBeNull()
    await expect(response.text()).resolves.toBe('')
  })
})

/**
 * The middleware is registered before the routes and short-circuits on the method alone, without
 * looking for `Access-Control-Request-Method`. That is a real constraint on the modules — none of
 * them can implement an OPTIONS handler of its own behind this gateway — and it holds only as long
 * as the middleware stays in front of the `app.all` routes.
 */
describe('OPTIONS without preflight headers', () => {
  it.each(['landing', 'cms'])('is answered by the gateway rather than forwarded to %s', async (module) => {
    const response = await gateway(`/${module}/thing`, { method: 'OPTIONS' })

    expect(response.status).toBe(204)
    expect(response.headers.get('X-Stub-Module')).toBeNull()
    expect(response.headers.get('X-Stub-Method')).toBeNull()
    await expect(response.text()).resolves.toBe('')
  })

  it('answers it with the same preflight headers as a well-formed one', async () => {
    const response = await gateway('/cms/content/projects', { method: 'OPTIONS' })

    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PATCH,DELETE,OPTIONS')
    expect(response.headers.get('Access-Control-Max-Age')).toBe('600')
  })

  it('short-circuits an OPTIONS to an unrouted path instead of 404ing', async () => {
    const response = await gateway('/nope', { method: 'OPTIONS' })

    expect(response.status).toBe(204)
  })
})

/**
 * One module answers cross-origin requests itself (`ownsCors` in src/services.ts). The gateway has
 * to stay entirely out of the way for it — including on the preflight, which it short-circuits for
 * every other path — or it would overwrite that module's decision with the fixed allowlist.
 */
describe('CORS delegated to a module', () => {
  it('forwards a preflight to the module instead of answering it', async () => {
    const response = await gateway('/auth/oauth/token', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://franciscosolis.cl',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(response.headers.get('X-Stub-Module')).toBe('auth')
    expect(response.headers.get('X-Stub-Method')).toBe('OPTIONS')
  })

  it('adds no CORS header of its own to a delegated response', async () => {
    const response = await gateway('/auth/thing', { headers: { Origin: 'https://evil.com' } })

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(response.headers.get('Access-Control-Expose-Headers')).toBeNull()
  })

  it('keeps answering for every module that did not delegate', async () => {
    for (const path of ['/', '/landing/stats/github', '/cms/content/projects', '/nope']) {
      const response = await gateway(path, { headers: { Origin: 'https://franciscosolis.cl' } })

      expect(response.headers.get('Access-Control-Allow-Origin'), path).toBe('https://franciscosolis.cl')
    }
  })
})
