import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedLegalPage } from '../helpers/db'

type PublicPage = { id: string; slug: string; title: string; body?: string }

const get = (path: string) => SELF.fetch(`https://cms.internal${path}`)

const listSlugs = async () => {
  const body = await (await get('/legal')).json<{ data: PublicPage[] }>()
  return body.data.map((page) => page.slug)
}

beforeEach(clearDatabase)

describe('GET /legal', () => {
  it('lists published pages', async () => {
    await seedLegalPage({ slug: 'privacy', title: 'Privacy policy', status: 'published' })

    const response = await get('/legal')
    const body = await response.json<{ code: number; data: PublicPage[] }>()

    expect(response.status).toBe(200)
    expect(body.code).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.title).toBe('Privacy policy')
  })

  it('hides a draft and an archived page', async () => {
    await seedLegalPage({ slug: 'privacy', status: 'published' })
    await seedLegalPage({ slug: 'terms', status: 'draft' })
    await seedLegalPage({ slug: 'old-terms', status: 'archived' })

    expect(await listSlugs()).toEqual(['privacy'])
  })

  it('leaves the body out, since an index has no use for it', async () => {
    await seedLegalPage({ slug: 'privacy', body: '# A very long document' })

    const body = await (await get('/legal')).json<{ data: PublicPage[] }>()
    expect(body.data[0]).not.toHaveProperty('body')
    expect(body.data[0]).toHaveProperty('version')
    expect(body.data[0]).toHaveProperty('effective_at')
  })

  it('never exposes the editorial fields', async () => {
    await seedLegalPage({ createdBy: 'fran@franciscosolis.cl' })

    const body = await (await get('/legal')).json<{ data: PublicPage[] }>()
    expect(body.data[0]).not.toHaveProperty('status')
    expect(body.data[0]).not.toHaveProperty('created_by')
  })

  it('orders alphabetically by title', async () => {
    await seedLegalPage({ slug: 'terms', title: 'Terms of service' })
    await seedLegalPage({ slug: 'cookies', title: 'Cookie policy' })
    await seedLegalPage({ slug: 'privacy', title: 'Privacy policy' })

    expect(await listSlugs()).toEqual(['cookies', 'privacy', 'terms'])
  })

  it('is public and briefly cacheable', async () => {
    expect((await get('/legal')).headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('serves an empty list when nothing is published', async () => {
    await seedLegalPage({ status: 'draft' })

    expect(await (await get('/legal')).json()).toEqual({ code: 200, data: [] })
  })

  it('needs no token', async () => {
    expect((await get('/legal')).status).toBe(200)
  })
})

describe('GET /legal/:slug', () => {
  it('returns the published page with its body', async () => {
    await seedLegalPage({
      slug: 'privacy',
      title: 'Privacy policy',
      body: '# Privacy',
      version: '2026-08',
      effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
    })

    const response = await get('/legal/privacy')
    const body = await response.json<{ code: number; data: PublicPage & { version: string; effective_at: string } }>()

    expect(response.status).toBe(200)
    expect(body.data.body).toBe('# Privacy')
    expect(body.data.version).toBe('2026-08')
    expect(body.data.effective_at).toBe('2026-08-01T00:00:00.000Z')
  })

  it('404s a draft page', async () => {
    await seedLegalPage({ slug: 'terms', status: 'draft' })

    const response = await get('/legal/terms')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Legal page not found' })
  })

  it('404s an archived page exactly like a missing one', async () => {
    await seedLegalPage({ slug: 'old-terms', status: 'archived' })

    const archived = await get('/legal/old-terms')
    const missing = await get('/legal/never-existed')

    expect(archived.status).toBe(404)
    expect(await archived.json()).toEqual(await missing.json())
  })

  it('never exposes the editorial fields', async () => {
    await seedLegalPage({ slug: 'privacy', updatedBy: 'fran@franciscosolis.cl' })

    const body = await (await get('/legal/privacy')).json<{ data: PublicPage }>()
    expect(body.data).not.toHaveProperty('status')
    expect(body.data).not.toHaveProperty('updated_by')
    expect(body.data).not.toHaveProperty('created_at')
  })

  it('is public and briefly cacheable, but a 404 is not', async () => {
    await seedLegalPage({ slug: 'privacy' })

    expect((await get('/legal/privacy')).headers.get('Cache-Control')).toBe('public, max-age=60')
    expect((await get('/legal/missing')).headers.get('Cache-Control')).toBe('no-store')
  })

  it('matches the slug exactly', async () => {
    await seedLegalPage({ slug: 'privacy-policy' })

    expect((await get('/legal/privacy')).status).toBe(404)
    expect((await get('/legal/privacy-policy')).status).toBe(200)
  })
})
