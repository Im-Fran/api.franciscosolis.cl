import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const get = (path: string) => SELF.fetch(`https://support.test${path}`)

describe('GET /', () => {
  it('advertises the vocabularies a front-end builds its filters from', async () => {
    const response = await get('/')
    expect(response.status).toBe(200)

    const body = (await response.json()) as { code: number; data: Record<string, unknown> }
    expect(body.code).toBe(200)
    expect(body.data.ticket_statuses).toContain('open')
    expect(body.data.ticket_statuses).toContain('solved')
    expect(body.data.message_kinds).toEqual(['reply', 'note'])
    expect(body.data.locales).toEqual(['en', 'es'])
    expect(body.data.default_locale).toBe('en')
  })

  it('answers JSON with an explicit charset', async () => {
    const response = await get('/')
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('is never cached by a shared cache, because almost nothing here is public', async () => {
    const response = await get('/')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /openapi.json', () => {
  it('serves a document, which is what the gateway merges', async () => {
    const response = await get('/openapi.json')
    expect(response.status).toBe(200)

    const spec = (await response.json()) as { info: { title: string }; paths: Record<string, unknown> }
    expect(spec.info.title).toBe('FranciscoSolis - Support API')
    expect(Object.keys(spec.paths)).toContain('/tickets')
  })
})
