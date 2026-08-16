import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { COLLECTION_NAMES, COLLECTIONS } from '@/lib/collections'

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
  it('lists every collection with the label and description the registry carries', async () => {
    const response = await SELF.fetch('https://cms.internal/collections')
    const body = await response.json<{ code: number; data: { slug: string; name: string; description: string }[] }>()

    expect(response.status).toBe(200)
    expect(body.code).toBe(200)
    // Straight off `COLLECTIONS`, so a slug wired to another collection's label fails here.
    expect(body.data).toEqual(
      COLLECTION_NAMES.map((slug) => ({
        slug,
        name: COLLECTIONS[slug].name,
        description: COLLECTIONS[slug].description,
      })),
    )
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
})

describe('onError', () => {
  it('returns a client error message as-is', async () => {
    const response = await SELF.fetch('https://cms.internal/content/no-such-collection')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Unknown collection: no-such-collection' })
  })

  it('leaves an unrouted verb on a cacheable path uncacheable', async () => {
    // `DELETE /collections` matches no handler, so `onError` never runs and neither does the
    // handler that sets `public, max-age=60`. The global default has to catch it: a path being
    // publicly cacheable for GET must not make a shared cache keep this response too.
    const response = await SELF.fetch('https://cms.internal/collections', { method: 'DELETE' })

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
