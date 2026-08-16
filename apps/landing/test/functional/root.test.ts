import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const BASE = 'https://landing.internal'

describe('GET /', () => {
  it('answers with the health payload', async () => {
    const response = await SELF.fetch(`${BASE}/`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: { message: '¡Hello, Landing!' },
    })
  })

  it('tags JSON with an explicit charset so non-ASCII bytes survive', async () => {
    const response = await SELF.fetch(`${BASE}/`)

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('serves real UTF-8 bytes, which is what the charset header promises', async () => {
    const bytes = Array.from(new Uint8Array(await (await SELF.fetch(`${BASE}/`)).arrayBuffer()))

    // `¡` is 0xC2 0xA1 in UTF-8 and a single 0xA1 in Latin-1.
    expect(bytes).toContain(0xc2)
    expect(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(new Uint8Array(bytes)),
    ).toContain('¡Hello, Landing!')
  })
})

describe('routing', () => {
  it('answers 404 for an unknown path', async () => {
    const response = await SELF.fetch(`${BASE}/does-not-exist`)

    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('404 Not Found')
  })

  it('leaves a non-JSON response alone instead of forcing the JSON content type on it', async () => {
    const response = await SELF.fetch(`${BASE}/does-not-exist`)

    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
  })

  it('registers the health check for GET only', async () => {
    const response = await SELF.fetch(`${BASE}/`, { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('does not expose a bare /stats index, only the mounted /stats/github router', async () => {
    const response = await SELF.fetch(`${BASE}/stats`)

    expect(response.status).toBe(404)
  })

  it('does not treat a trailing slash as the same route', async () => {
    // The gateway proxies paths verbatim, so it must not append one when forwarding /landing/*.
    const response = await SELF.fetch(`${BASE}/stats/github/`)

    expect(response.status).toBe(404)
  })
})
