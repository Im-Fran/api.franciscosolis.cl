import { describe, expect, it } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { fetcher, gateway, gatewayWithBindings } from '../helpers/gateway'

type ErrorPayload = { code: number; error: string }

/** Every failure the gateway owns has to come back in this one shape. */
describe('app.onError', () => {
  it('turns an upstream module that blows up into a 500 with the error shape', async () => {
    const response = await gateway('/landing/throw')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 500, error: 'stub blew up' })
  })

  it.each(['LANDING', 'AUTH', 'CMS'] as const)('uses the same shape for a broken %s binding', async (binding) => {
    const module = binding.toLowerCase()
    const response = await gatewayWithBindings(
      { [binding]: fetcher(() => Promise.reject(new Error(`${module} is unreachable`))) },
      `/${module}/anything`,
    )

    expect(response.status).toBe(500)
    const body = await response.json<ErrorPayload>()
    expect(Object.keys(body).sort()).toEqual(['code', 'error'])
    expect(body).toEqual({ code: 500, error: `${module} is unreachable` })
  })

  it.each([
    [400, 'malformed grant'],
    [401, 'invalid token'],
    [429, 'slow down'],
    [503, 'landing is down'],
  ])('preserves the %s status of an HTTPException', async (status, message) => {
    const response = await gatewayWithBindings(
      {
        LANDING: fetcher(() => {
          throw new HTTPException(status as 400, { message })
        }),
      },
      '/landing/stats/github',
    )

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ code: status, error: message })
  })

  it('preserves the status of an HTTPException that arrives as a rejection', async () => {
    const response = await gatewayWithBindings(
      { AUTH: fetcher(() => Promise.reject(new HTTPException(418, { message: 'teapot' }))) },
      '/auth/oauth/token',
    )

    expect(response.status).toBe(418)
    await expect(response.json()).resolves.toEqual({ code: 418, error: 'teapot' })
  })

  it('reports a plain error as 500 rather than leaking its own status', async () => {
    const response = await gatewayWithBindings(
      { CMS: fetcher(() => Promise.reject(new Error('D1_ERROR: no such table'))) },
      '/cms/content/projects',
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 500, error: 'D1_ERROR: no such table' })
  })

  /**
   * The other way a Hono middleware signals a failure: an `HTTPException` built with a ready-made
   * `res` instead of a message. Its `message` is empty, so this lands on the intersection of both
   * `onError` branches — the status is taken from the exception, the module's own body and headers
   * are discarded, and the caller sees the gateway's uniform shape. Pinned because it is what a
   * real caller gets, not because it is obviously the right call.
   */
  it('drops the custom response an HTTPException carries and normalizes it', async () => {
    const response = await gatewayWithBindings(
      {
        AUTH: fetcher(() => {
          throw new HTTPException(401, {
            res: Response.json(
              { error: 'invalid_grant', error_description: 'authorization code already used' },
              { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_grant"' } },
            ),
          })
        }),
      },
      '/auth/oauth/token',
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ code: 401, error: 'Internal Server Error' })
    expect(response.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('falls back to a generic message when the error carries none', async () => {
    const response = await gatewayWithBindings(
      { LANDING: fetcher(() => Promise.reject(new Error(''))) },
      '/landing/stats/github',
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 500, error: 'Internal Server Error' })
  })

  it('answers errors as JSON with the charset applied', async () => {
    const response = await gatewayWithBindings(
      { CMS: fetcher(() => Promise.reject(new Error('boom'))) },
      '/cms/content/projects',
    )

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('keeps the CORS headers on an error, so the browser can read it', async () => {
    const response = await gateway('/cms/throw', { headers: { Origin: 'https://franciscosolis.cl' } })

    expect(response.status).toBe(500)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://franciscosolis.cl')
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Content-Type')
  })

  it('cannot add them for a module that owns its own CORS, and does not guess', async () => {
    // The module never answered, so nothing here knows whether that origin is one of its clients.
    // The browser sees a network error rather than a readable 500, which is the honest outcome:
    // inventing an allowed origin at this point would be the gateway answering for a module
    // precisely where it cannot know the answer.
    const response = await gateway('/auth/throw', { headers: { Origin: 'https://franciscosolis.cl' } })

    expect(response.status).toBe(500)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('upstream error statuses', () => {
  it.each(['landing', 'auth', 'cms'])('passes a %s 500 straight through instead of rewrapping it', async (module) => {
    const response = await gateway(`/${module}/boom`)

    // A status the module chose is the module's answer; only a thrown error becomes `{ code, error }`.
    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toBe('upstream exploded')
  })

  it.each([401, 404, 422, 502])('passes an upstream %s through untouched', async (status) => {
    const response = await gatewayWithBindings(
      { CMS: fetcher(() => new Response(JSON.stringify({ detail: 'from the module' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) },
      '/cms/content/projects',
    )

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ detail: 'from the module' })
  })
})
