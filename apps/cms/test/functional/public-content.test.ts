import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedEntry } from '../helpers/db'

type PublicEntry = {
  id: string
  collection: string
  slug: string
  title: string
  tags: string[]
  data: Record<string, unknown>
  status?: unknown
}

const get = (path: string) => SELF.fetch(`https://cms.internal${path}`)

const listSlugs = async (path: string) => {
  const response = await get(path)
  const body = await response.json<{ data: PublicEntry[] }>()
  return body.data.map((entry) => entry.slug)
}

beforeEach(clearDatabase)

describe('GET /content/:collection', () => {
  it('returns published entries of the collection', async () => {
    await seedEntry({ collection: 'projects', slug: 'a-project', title: 'A project', status: 'published' })

    const response = await get('/content/projects')
    const body = await response.json<{ code: number; data: PublicEntry[] }>()

    expect(response.status).toBe(200)
    expect(body.code).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ collection: 'projects', slug: 'a-project', title: 'A project' })
  })

  it('hides a draft and an archived entry', async () => {
    // The app's main access rule: the existence of unpublished content is not public information.
    await seedEntry({ collection: 'projects', slug: 'live', status: 'published' })
    await seedEntry({ collection: 'projects', slug: 'draft', status: 'draft' })
    await seedEntry({ collection: 'projects', slug: 'archived', status: 'archived' })

    expect(await listSlugs('/content/projects')).toEqual(['live'])
  })

  it('cannot be talked into showing drafts through the query string', async () => {
    await seedEntry({ collection: 'projects', slug: 'draft', status: 'draft' })

    expect(await listSlugs('/content/projects?status=draft')).toEqual([])
    expect(await listSlugs('/content/projects?status=published&status=draft')).toEqual([])
  })

  it('never exposes the editorial fields', async () => {
    await seedEntry({ collection: 'projects', status: 'published', createdBy: 'fran@franciscosolis.cl' })

    const body = await (await get('/content/projects')).json<{ data: PublicEntry[] }>()
    expect(body.data[0]).not.toHaveProperty('status')
    expect(body.data[0]).not.toHaveProperty('created_by')
    expect(body.data[0]).not.toHaveProperty('updated_by')
    expect(body.data[0]).not.toHaveProperty('created_at')
  })

  it('scopes the listing to one collection', async () => {
    await seedEntry({ collection: 'projects', slug: 'p1' })
    await seedEntry({ collection: 'skills', slug: 's1' })

    expect(await listSlugs('/content/projects')).toEqual(['p1'])
    expect(await listSlugs('/content/skills')).toEqual(['s1'])
  })

  it('404s an unknown collection', async () => {
    const response = await get('/content/talks')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Unknown collection: talks' })
  })

  it('is public and briefly cacheable', async () => {
    const response = await get('/content/projects')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('does not mark a 404 cacheable', async () => {
    const response = await get('/content/talks')

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('needs no token at all', async () => {
    await seedEntry({ collection: 'projects', slug: 'open' })

    expect((await get('/content/projects')).status).toBe(200)
  })

  it('filters by featured', async () => {
    await seedEntry({ collection: 'projects', slug: 'pinned', featured: true })
    await seedEntry({ collection: 'projects', slug: 'ordinary', featured: false })

    expect(await listSlugs('/content/projects?featured=true')).toEqual(['pinned'])
    expect(await listSlugs('/content/projects?featured=false')).toEqual(['ordinary'])
    expect((await listSlugs('/content/projects')).sort()).toEqual(['ordinary', 'pinned'])
  })

  it('rejects a featured value that is neither true nor false', async () => {
    expect((await get('/content/projects?featured=yes')).status).toBe(400)
    expect((await get('/content/projects?featured=1')).status).toBe(400)
  })

  it('filters by tag, case-insensitively and without prefix bleed', async () => {
    await seedEntry({ collection: 'projects', slug: 'go-thing', tags: '["go"]' })
    await seedEntry({ collection: 'projects', slug: 'golang-thing', tags: '["golang"]' })

    expect(await listSlugs('/content/projects?tag=go')).toEqual(['go-thing'])
    expect(await listSlugs('/content/projects?tag=GO')).toEqual(['go-thing'])
    expect(await listSlugs('/content/projects?tag=rust')).toEqual([])
  })

  it('searches title, summary and slug', async () => {
    await seedEntry({ collection: 'projects', slug: 'gateway-rewrite', title: 'Rewrite' })
    await seedEntry({ collection: 'projects', slug: 'other', title: 'Gateway thing' })
    await seedEntry({ collection: 'projects', slug: 'third', title: 'Nothing', summary: 'A gateway summary' })
    await seedEntry({ collection: 'projects', slug: 'fourth', title: 'Unrelated' })

    expect((await listSlugs('/content/projects?search=gateway')).sort()).toEqual([
      'gateway-rewrite',
      'other',
      'third',
    ])
  })

  it('does not let a draft through the search filter', async () => {
    await seedEntry({ collection: 'projects', slug: 'secret', title: 'Gateway secret', status: 'draft' })

    expect(await listSlugs('/content/projects?search=gateway')).toEqual([])
  })

  it('pages with limit and offset', async () => {
    for (const position of [0, 1, 2]) {
      await seedEntry({ collection: 'projects', slug: `entry-${position}`, position })
    }

    expect(await listSlugs('/content/projects?limit=2')).toEqual(['entry-0', 'entry-1'])
    expect(await listSlugs('/content/projects?limit=2&offset=2')).toEqual(['entry-2'])
    expect(await listSlugs('/content/projects?offset=99')).toEqual([])
  })

  it('rejects a limit past the 200 cap rather than trimming it', async () => {
    expect((await get('/content/projects?limit=200')).status).toBe(200)
    expect((await get('/content/projects?limit=201')).status).toBe(400)
    expect((await get('/content/projects?limit=1000')).status).toBe(400)
  })

  it('rejects a non-numeric limit or offset', async () => {
    expect((await get('/content/projects?limit=abc')).status).toBe(400)
    expect((await get('/content/projects?offset=-1')).status).toBe(400)
  })

  it('orders by position, then most recent, then title', async () => {
    await seedEntry({ collection: 'projects', slug: 'last', position: 5, title: 'Z' })
    await seedEntry({ collection: 'projects', slug: 'newest', position: 0, startedAt: new Date('2025-01-01') })
    await seedEntry({ collection: 'projects', slug: 'oldest', position: 0, startedAt: new Date('2020-01-01') })

    expect(await listSlugs('/content/projects')).toEqual(['newest', 'oldest', 'last'])
  })

  it('parses the tags and data blobs into real JSON', async () => {
    await seedEntry({
      collection: 'skills',
      slug: 'typescript',
      tags: '["lang","typed"]',
      data: '{"category":"backend","level":5}',
    })

    const body = await (await get('/content/skills')).json<{ data: PublicEntry[] }>()
    expect(body.data[0]?.tags).toEqual(['lang', 'typed'])
    expect(body.data[0]?.data).toEqual({ category: 'backend', level: 5 })
  })

  it('serves an empty list rather than a 404 for a collection with no entries', async () => {
    const response = await get('/content/education')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ code: 200, data: [] })
  })
})

describe('GET /content/:collection/:slug', () => {
  it('returns the published entry addressed by slug', async () => {
    await seedEntry({ collection: 'projects', slug: 'a-project', title: 'A project', body: '# Body' })

    const response = await get('/content/projects/a-project')
    const body = await response.json<{ code: number; data: PublicEntry }>()

    expect(response.status).toBe(200)
    expect(body.data.slug).toBe('a-project')
    expect(body.data.title).toBe('A project')
  })

  it('404s a draft, so its existence stays private', async () => {
    await seedEntry({ collection: 'projects', slug: 'draft-entry', status: 'draft' })

    const response = await get('/content/projects/draft-entry')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Entry not found' })
  })

  it('404s an archived entry with the same message as a missing one', async () => {
    await seedEntry({ collection: 'projects', slug: 'archived-entry', status: 'archived' })

    const archived = await get('/content/projects/archived-entry')
    const missing = await get('/content/projects/never-existed')

    expect(archived.status).toBe(404)
    expect(await archived.json()).toEqual(await missing.json())
  })

  it('404s an unknown collection before it ever looks for the slug', async () => {
    const response = await get('/content/talks/a-talk')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 404, error: 'Unknown collection: talks' })
  })

  it('does not find an entry through the wrong collection', async () => {
    await seedEntry({ collection: 'projects', slug: 'shared' })

    expect((await get('/content/projects/shared')).status).toBe(200)
    expect((await get('/content/skills/shared')).status).toBe(404)
  })

  it('is public and briefly cacheable, but a 404 is not', async () => {
    await seedEntry({ collection: 'projects', slug: 'cached' })

    expect((await get('/content/projects/cached')).headers.get('Cache-Control')).toBe('public, max-age=60')
    expect((await get('/content/projects/missing')).headers.get('Cache-Control')).toBe('no-store')
  })

  it('never exposes the editorial fields', async () => {
    await seedEntry({ collection: 'projects', slug: 'public-entry', updatedBy: 'fran@franciscosolis.cl' })

    const body = await (await get('/content/projects/public-entry')).json<{ data: PublicEntry }>()
    expect(body.data).not.toHaveProperty('status')
    expect(body.data).not.toHaveProperty('updated_by')
  })

  it('serves the body, unlike the legal listing', async () => {
    await seedEntry({ collection: 'projects', slug: 'with-body', body: '# Long body' })

    const body = await (await get('/content/projects/with-body')).json<{ data: { body: string } }>()
    expect(body.data.body).toBe('# Long body')
  })
})
