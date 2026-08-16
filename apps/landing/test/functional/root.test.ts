import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('GET /', () => {
  it('answers with the health payload', async () => {
    const response = await SELF.fetch('https://landing.internal/')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: { message: '¡Hello, Landing!' },
    })
  })

  it('tags JSON with an explicit charset so non-ASCII bytes survive', async () => {
    const response = await SELF.fetch('https://landing.internal/')

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })
})
