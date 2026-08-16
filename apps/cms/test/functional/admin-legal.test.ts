import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, countRows, readAuditLog, seedLegalPage } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

type AdminPage = {
  id: string
  slug: string
  title: string
  summary: string | null
  body: string
  status: string
  version: string | null
  effective_at: string | null
  published_at: string | null
  created_by: string | null
  updated_by: string | null
}

let headers: Record<string, string>

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://cms.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const dataOf = async <T>(response: Response) => (await response.json<{ data: T }>()).data
const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error

const rawRow = (id: string) =>
  env.DB.prepare('SELECT slug, title, body, status, version, published_at, updated_by FROM legal_pages WHERE id = ?')
    .bind(id)
    .first<{
      slug: string
      title: string
      body: string
      status: string
      version: string | null
      published_at: number | null
      updated_by: string | null
    }>()

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('GET /admin/legal', () => {
  it('lists every page, drafts included, with their bodies', async () => {
    await seedLegalPage({ slug: 'privacy', title: 'Privacy', status: 'published' })
    await seedLegalPage({ slug: 'terms', title: 'Terms', status: 'draft', body: '# Draft terms' })

    const pages = await dataOf<AdminPage[]>(await call('GET', '/admin/legal'))
    expect(pages.map((page) => page.slug)).toEqual(['privacy', 'terms'])
    expect(pages[1]?.body).toBe('# Draft terms')
    expect(pages[1]?.status).toBe('draft')
  })

  it('orders alphabetically by title', async () => {
    await seedLegalPage({ slug: 'terms', title: 'Terms of service' })
    await seedLegalPage({ slug: 'cookies', title: 'Cookie policy' })

    const pages = await dataOf<AdminPage[]>(await call('GET', '/admin/legal'))
    expect(pages.map((page) => page.slug)).toEqual(['cookies', 'terms'])
  })

  it('exposes the editorial fields and is never cached', async () => {
    await seedLegalPage({ createdBy: 'a@franciscosolis.cl' })

    const response = await call('GET', '/admin/legal')
    const [page] = await dataOf<AdminPage[]>(response)

    expect(page?.created_by).toBe('a@franciscosolis.cl')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('POST /admin/legal', () => {
  it('creates a page and answers 201 with it', async () => {
    const response = await call('POST', '/admin/legal', { title: 'Privacy Policy', body: '# Privacy' })
    const page = await dataOf<AdminPage>(response)

    expect(response.status).toBe(201)
    expect(page).toMatchObject({
      slug: 'privacy-policy',
      title: 'Privacy Policy',
      body: '# Privacy',
      status: 'draft',
      published_at: null,
      created_by: 'fran@franciscosolis.cl',
      updated_by: 'fran@franciscosolis.cl',
    })
    expect(await rawRow(page.id)).toMatchObject({ slug: 'privacy-policy', status: 'draft' })
  })

  it('prefers an explicit slug, normalised', async () => {
    const page = await dataOf<AdminPage>(
      await call('POST', '/admin/legal', { title: 'Whatever', body: 'x', slug: '  Privacy  ' }),
    )

    expect(page.slug).toBe('privacy')
  })

  it('422s when no slug can be derived', async () => {
    const response = await call('POST', '/admin/legal', { title: '???', body: 'x' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('Could not derive a slug from the title; send one explicitly')
  })

  it('409s a duplicate slug — legal slugs are unique outright, not per collection', async () => {
    await call('POST', '/admin/legal', { title: 'Privacy', body: 'x' })
    const response = await call('POST', '/admin/legal', { title: 'Privacy', body: 'y' })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('A legal page with slug "privacy" already exists')
    expect(await countRows('legal_pages')).toBe(1)
  })

  it('demands a non-empty body, unlike a content entry', async () => {
    expect((await call('POST', '/admin/legal', { title: 'Privacy' })).status).toBe(400)
    expect((await call('POST', '/admin/legal', { title: 'Privacy', body: '' })).status).toBe(400)
  })

  it('stamps published_at only when it is created live', async () => {
    const live = await dataOf<AdminPage>(
      await call('POST', '/admin/legal', { title: 'Live', body: 'x', status: 'published' }),
    )
    const draft = await dataOf<AdminPage>(await call('POST', '/admin/legal', { title: 'Draft', body: 'x' }))

    expect(live.published_at).toEqual(expect.any(String))
    expect(draft.published_at).toBeNull()
  })

  it('keeps the version and effective date it was given', async () => {
    const page = await dataOf<AdminPage>(
      await call('POST', '/admin/legal', {
        title: 'Terms',
        body: 'x',
        version: '2026-08',
        effective_at: '2026-09-01',
      }),
    )

    expect(page.version).toBe('2026-08')
    expect(page.effective_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('400s a bad status, a bad date and an over-long version', async () => {
    expect((await call('POST', '/admin/legal', { title: 'A', body: 'x', status: 'live' })).status).toBe(400)
    expect((await call('POST', '/admin/legal', { title: 'B', body: 'x', effective_at: 'soon' })).status).toBe(400)
    expect((await call('POST', '/admin/legal', { title: 'C', body: 'x', version: 'v'.repeat(41) })).status).toBe(400)
  })

  it('writes an audit row', async () => {
    const page = await dataOf<AdminPage>(
      await call('POST', '/admin/legal', { title: 'Privacy', body: 'x', status: 'published' }),
    )

    const [row] = await readAuditLog()
    expect(row?.event).toBe('legal.created')
    expect(row?.resource_type).toBe('legal_pages')
    expect(row?.resource_id).toBe(page.id)
    expect(row?.metadata).toEqual({ slug: 'privacy', status: 'published' })
  })
})

describe('GET /admin/legal/:id', () => {
  it('returns a draft page by id', async () => {
    const seeded = await seedLegalPage({ status: 'draft' })

    const page = await dataOf<AdminPage>(await call('GET', `/admin/legal/${seeded.id}`))
    expect(page.id).toBe(seeded.id)
    expect(page.status).toBe('draft')
  })

  it('404s an id that does not exist', async () => {
    const response = await call('GET', '/admin/legal/nope')

    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Legal page not found')
  })
})

describe('PATCH /admin/legal/:id', () => {
  it('updates only the fields it was sent', async () => {
    const seeded = await seedLegalPage({ slug: 'privacy', title: 'Privacy', body: '# Old', version: '1.0' })

    const page = await dataOf<AdminPage>(await call('PATCH', `/admin/legal/${seeded.id}`, { body: '# New' }))

    expect(page.body).toBe('# New')
    expect(page.title).toBe('Privacy')
    expect(page.version).toBe('1.0')
  })

  it('clears a nullable field on an explicit null', async () => {
    const seeded = await seedLegalPage({ summary: 'Set', version: '1.0', effectiveAt: new Date('2026-01-01') })

    const page = await dataOf<AdminPage>(
      await call('PATCH', `/admin/legal/${seeded.id}`, { summary: null, version: null, effective_at: null }),
    )

    expect(page.summary).toBeNull()
    expect(page.version).toBeNull()
    expect(page.effective_at).toBeNull()
  })

  it('will not let the body be emptied', async () => {
    // A legal page with no text is not a document; the body is required, never nullable.
    const seeded = await seedLegalPage({ body: '# Keep me' })

    expect((await call('PATCH', `/admin/legal/${seeded.id}`, { body: null })).status).toBe(400)
    expect((await call('PATCH', `/admin/legal/${seeded.id}`, { body: '' })).status).toBe(400)
    expect((await rawRow(seeded.id))?.body).toBe('# Keep me')
  })

  it('stamps published_at the first time and never rewrites it', async () => {
    const seeded = await seedLegalPage({ status: 'draft', publishedAt: null })

    const published = await dataOf<AdminPage>(
      await call('PATCH', `/admin/legal/${seeded.id}`, { status: 'published' }),
    )
    const archived = await dataOf<AdminPage>(await call('PATCH', `/admin/legal/${seeded.id}`, { status: 'archived' }))
    const republished = await dataOf<AdminPage>(
      await call('PATCH', `/admin/legal/${seeded.id}`, { status: 'published' }),
    )

    // Compared at second granularity: the column is unix seconds, so the stamp the first response
    // echoes back straight from memory is the same instant with the milliseconds still on it.
    const seconds = (value: string | null) => Math.floor(Date.parse(value ?? '') / 1000)
    expect(published.published_at).toEqual(expect.any(String))
    expect(seconds(archived.published_at)).toBe(seconds(published.published_at))
    expect(seconds(republished.published_at)).toBe(seconds(published.published_at))
  })

  it('keeps an already-recorded published_at byte for byte through a republish', async () => {
    const announced = new Date('2024-05-05T10:00:00.000Z')
    const seeded = await seedLegalPage({ status: 'published', publishedAt: announced })

    await call('PATCH', `/admin/legal/${seeded.id}`, { status: 'draft' })
    const republished = await dataOf<AdminPage>(
      await call('PATCH', `/admin/legal/${seeded.id}`, { status: 'published' }),
    )

    expect(republished.published_at).toBe(announced.toISOString())
  })

  it('publishing makes the page visible to the public route', async () => {
    const seeded = await seedLegalPage({ slug: 'terms', status: 'draft' })

    expect((await SELF.fetch('https://cms.internal/legal/terms')).status).toBe(404)
    await call('PATCH', `/admin/legal/${seeded.id}`, { status: 'published' })
    expect((await SELF.fetch('https://cms.internal/legal/terms')).status).toBe(200)
  })

  it('409s when another page already uses the slug', async () => {
    await seedLegalPage({ slug: 'taken' })
    const seeded = await seedLegalPage({ slug: 'mine' })

    const response = await call('PATCH', `/admin/legal/${seeded.id}`, { slug: 'taken' })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('A legal page with slug "taken" already exists')
    expect((await rawRow(seeded.id))?.slug).toBe('mine')
  })

  it('records the editor who touched it', async () => {
    const seeded = await seedLegalPage({ updatedBy: 'someone-else@franciscosolis.cl' })

    await call('PATCH', `/admin/legal/${seeded.id}`, { title: 'Touched' })

    expect((await rawRow(seeded.id))?.updated_by).toBe('fran@franciscosolis.cl')
  })

  it('404s a page that does not exist', async () => {
    expect((await call('PATCH', '/admin/legal/nope', { title: 'X' })).status).toBe(404)
  })

  it('writes an audit row naming the fields that were sent', async () => {
    const seeded = await seedLegalPage({ slug: 'privacy', status: 'draft' })

    await call('PATCH', `/admin/legal/${seeded.id}`, { body: '# New', version: '2.0' })

    const [row] = await readAuditLog()
    expect(row?.event).toBe('legal.updated')
    expect(row?.metadata).toEqual({ slug: 'privacy', fields: ['body', 'version'], status: 'draft' })
  })
})

describe('DELETE /admin/legal/:id', () => {
  it('deletes the page and answers 204', async () => {
    const seeded = await seedLegalPage()

    const response = await call('DELETE', `/admin/legal/${seeded.id}`)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(await countRows('legal_pages')).toBe(0)
  })

  it('404s a page that does not exist', async () => {
    expect((await call('DELETE', '/admin/legal/nope')).status).toBe(404)
  })

  it('writes an audit row that outlives the page', async () => {
    const seeded = await seedLegalPage({ slug: 'gone' })

    await call('DELETE', `/admin/legal/${seeded.id}`)

    const [row] = await readAuditLog()
    expect(row?.event).toBe('legal.deleted')
    expect(row?.resource_id).toBe(seeded.id)
    expect(row?.metadata).toEqual({ slug: 'gone' })
  })
})
