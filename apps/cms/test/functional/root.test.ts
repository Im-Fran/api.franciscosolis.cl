import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { COLLECTION_NAMES } from '@/lib/collections'

describe('GET /', () => {
  it('reports the service and the collections it manages', async () => {
    const response = await SELF.fetch('https://cms.internal/')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      code: 200,
      data: { message: 'Hello, CMS!', collections: [...COLLECTION_NAMES] },
    })
  })
})

describe('response middleware', () => {
  it('spells out the charset, so non-ASCII bytes survive a Latin-1 client', async () => {
    const response = await SELF.fetch('https://cms.internal/')

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  it('defaults everything to no-store', async () => {
    // Editorial and token-bound responses must never sit in a shared cache; the public routes
    // opt back in explicitly.
    const response = await SELF.fetch('https://cms.internal/')

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('leaves a route\'s own Cache-Control alone', async () => {
    const response = await SELF.fetch('https://cms.internal/collections')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('marks a 404 no-store as well', async () => {
    const response = await SELF.fetch('https://cms.internal/nope')

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /collections', () => {
  it('lists every collection with its label and description', async () => {
    const response = await SELF.fetch('https://cms.internal/collections')
    const body = await response.json<{ code: number; data: { slug: string; name: string; description: string }[] }>()

    expect(response.status).toBe(200)
    expect(body.code).toBe(200)
    expect(body.data.map((entry) => entry.slug)).toEqual([...COLLECTION_NAMES])
    for (const entry of body.data) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  it('is public and briefly cacheable', async () => {
    const response = await SELF.fetch('https://cms.internal/collections')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('needs no token', async () => {
    const response = await SELF.fetch('https://cms.internal/collections', {
      headers: { Authorization: 'Bearer garbage' },
    })

    expect(response.status).toBe(200)
  })
})

describe('GET /openapi.json', () => {
  it('describes both the public and the editorial surface', async () => {
    const response = await SELF.fetch('https://cms.internal/openapi.json')
    const body = await response.json<{ info: { title: string }; paths: Record<string, unknown> }>()

    expect(response.status).toBe(200)
    expect(body.info.title).toBe('FranciscoSolis - CMS API')
    expect(Object.keys(body.paths)).toEqual(
      expect.arrayContaining([
        '/',
        '/collections',
        '/content/{collection}',
        '/content/{collection}/{slug}',
        '/legal',
        '/legal/{slug}',
        '/admin/me',
        '/admin/audit',
        '/admin/content/{collection}',
        '/admin/content/{collection}/reorder',
        '/admin/content/{collection}/{id}',
        '/admin/legal',
        '/admin/legal/{id}',
        '/admin/email-templates',
        '/admin/email-templates/{id}',
        '/admin/emails',
        '/admin/emails/{id}',
      ]),
    )
  })

  it('leaves itself out of the document', async () => {
    const response = await SELF.fetch('https://cms.internal/openapi.json')
    const body = await response.json<{ paths: Record<string, unknown> }>()

    expect(body.paths).not.toHaveProperty('/openapi.json')
  })

  it('publishes the bearer scheme the admin routes reference', async () => {
    const response = await SELF.fetch('https://cms.internal/openapi.json')
    const body = await response.json<{
      components: { securitySchemes: Record<string, { type: string; scheme: string }> }
    }>()

    expect(body.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
  })

  it('reaches the merged gateway document without a token', async () => {
    const response = await SELF.fetch('https://cms.internal/openapi.json')

    expect(response.status).toBe(200)
  })
})

describe('onError', () => {
  it('returns a client error message as-is', async () => {
    const response = await SELF.fetch('https://cms.internal/content/no-such-collection')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Unknown collection: no-such-collection' })
  })

  it('treats a known path with an unrouted verb as a 404', async () => {
    const response = await SELF.fetch('https://cms.internal/collections', { method: 'DELETE' })

    expect(response.status).toBe(404)
  })
})
