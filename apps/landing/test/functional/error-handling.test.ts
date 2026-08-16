import { SELF } from 'cloudflare:test'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import app from '@/index'

const BASE = 'https://landing.internal'

/**
 * `onError` is the only place where the response status is derived from the error rather than
 * hardcoded, and no route in `src/` throws an `HTTPException` today, so that branch is otherwise
 * dead in test — a regression collapsing every 4xx into a 500 would go unnoticed. Hanging throwaway
 * routes off the real app instance closes it without touching `src/`.
 *
 * Two constraints shape this file: Hono freezes its router once it has matched a request, so the
 * routes have to be registered at module scope before any dispatch, and vitest isolates modules per
 * test file, which is what keeps these routes out of every other file's view of the app.
 */
app.get('/__test__/teapot', () => {
  throw new HTTPException(418, { message: 'teapot' })
})

app.get('/__test__/silent', () => {
  throw new HTTPException(429)
})

app.get('/__test__/plain', () => {
  throw new Error('plain failure')
})

describe('onError', () => {
  it('takes the status from an HTTPException instead of defaulting to 500', async () => {
    const response = await app.request(`${BASE}/__test__/teapot`)

    expect(response.status).toBe(418)
    await expect(response.json()).resolves.toEqual({ code: 418, error: 'teapot' })
  })

  it('keeps the HTTPException status while falling back on a blank message', async () => {
    // The two halves of the expression are independent: the fallback must not drag the status
    // back to 500 along with the message.
    const response = await app.request(`${BASE}/__test__/silent`)

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ code: 429, error: 'Internal Server Error' })
  })

  it('reports 500 for an ordinary error, which carries no status of its own', async () => {
    const response = await app.request(`${BASE}/__test__/plain`)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: 500, error: 'plain failure' })
  })

  it('keeps the body code and the HTTP status in step on both branches', async () => {
    for (const path of ['/__test__/teapot', '/__test__/silent', '/__test__/plain']) {
      const response = await app.request(`${BASE}${path}`)
      const body = await response.json<{ code: number }>()

      expect(body.code, path).toBe(response.status)
    }
  })

  it('charsets the HTTPException body too, since onError runs under the same middleware', async () => {
    const response = await app.request(`${BASE}/__test__/teapot`)

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('behaves the same over a real Worker dispatch as over a direct request', async () => {
    const dispatched = await SELF.fetch(`${BASE}/__test__/teapot`)

    expect(dispatched.status).toBe(418)
    await expect(dispatched.json()).resolves.toEqual({ code: 418, error: 'teapot' })
  })
})
