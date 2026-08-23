import { beforeEach, describe, expect, it } from 'vitest'
import type { ContentEntry } from '@/services/content'
import { findEntryById, findEntryBySlug, listEntries, parseJson, toAdminEntry, toPublicEntry } from '@/services/content'
import { clearDatabase, db, seedEntry } from '../helpers/db'

const list = (filters: Partial<Parameters<typeof listEntries>[1]> = {}) =>
  listEntries(db(), { limit: 50, offset: 0, ...filters })

beforeEach(clearDatabase)

describe('parseJson', () => {
  it('parses a well-formed column', () => {
    expect(parseJson<string[]>('["a","b"]', [])).toEqual(['a', 'b'])
    expect(parseJson<Record<string, unknown>>('{"role":"lead"}', {})).toEqual({ role: 'lead' })
  })

  it('falls back on malformed JSON rather than throwing', () => {
    // One corrupt blob must not take a whole listing — and with it the landing page — down.
    expect(parseJson<string[]>('{not json', ['fallback'])).toEqual(['fallback'])
  })

  it('falls back on null and on an empty string', () => {
    expect(parseJson<string[]>(null, [])).toEqual([])
    expect(parseJson<string[]>('', ['fallback'])).toEqual(['fallback'])
  })

  it('returns whatever the JSON says, even of the wrong shape', () => {
    // No schema check here on purpose; the fallback only covers a parse failure.
    expect(parseJson<string[]>('"a string"', [])).toBe('a string')
  })
})

describe('toPublicEntry', () => {
  it('renders the shape the website consumes', async () => {
    const started = new Date('2024-01-15T00:00:00.000Z')
    const row = await seedEntry({
      collection: 'projects',
      slug: 'api-gateway',
      title: 'API gateway',
      subtitle: 'Edge routing',
      summary: 'A summary',
      body: '# Body',
      featured: true,
      position: 3,
      startedAt: started,
      endedAt: null,
      url: 'https://example.com',
      imageUrl: 'https://example.com/i.png',
      tags: '["edge","workers"]',
      data: '{"role":"lead"}',
    })

    const entry = await findEntryById(db(), row.id)
    expect(toPublicEntry(entry as ContentEntry)).toEqual({
      id: row.id,
      collection: 'projects',
      slug: 'api-gateway',
      title: 'API gateway',
      subtitle: 'Edge routing',
      summary: 'A summary',
      body: '# Body',
      locale: 'en',
      available_locales: ['en'],
      featured: true,
      position: 3,
      started_at: '2024-01-15T00:00:00.000Z',
      ended_at: null,
      url: 'https://example.com',
      image_url: 'https://example.com/i.png',
      tags: ['edge', 'workers'],
      data: { role: 'lead' },
      published_at: expect.any(String),
      updated_at: expect.any(String),
    })
  })

  it('never leaks the editorial fields', async () => {
    const row = await seedEntry({ status: 'draft' })
    const entry = (await findEntryById(db(), row.id)) as ContentEntry
    const shape = toPublicEntry(entry)

    expect(shape).not.toHaveProperty('status')
    expect(shape).not.toHaveProperty('created_by')
    expect(shape).not.toHaveProperty('updated_by')
    expect(shape).not.toHaveProperty('created_at')
  })

  it('falls back to empty tags and data when the blobs are corrupt', async () => {
    const row = await seedEntry({ tags: 'not json', data: '{oops' })
    const entry = (await findEntryById(db(), row.id)) as ContentEntry

    expect(toPublicEntry(entry).tags).toEqual([])
    expect(toPublicEntry(entry).data).toEqual({})
  })
})

describe('toAdminEntry', () => {
  it('adds the editorial fields on top of the public shape', async () => {
    const row = await seedEntry({ status: 'archived', createdBy: 'a@franciscosolis.cl', updatedBy: 'b@franciscosolis.cl' })
    const entry = (await findEntryById(db(), row.id)) as ContentEntry
    const shape = toAdminEntry(entry)

    expect(shape.status).toBe('archived')
    expect(shape.created_by).toBe('a@franciscosolis.cl')
    expect(shape.updated_by).toBe('b@franciscosolis.cl')
    expect(shape.created_at).toEqual(expect.any(String))
    expect(shape.slug).toBe(row.slug)
  })
})

describe('findEntryById / findEntryBySlug', () => {
  it('finds an existing row', async () => {
    const row = await seedEntry({ collection: 'skills', slug: 'typescript' })

    expect((await findEntryById(db(), row.id))?.slug).toBe('typescript')
    expect((await findEntryBySlug(db(), 'skills', 'typescript'))?.id).toBe(row.id)
  })

  it('returns null instead of throwing when there is nothing to find', async () => {
    expect(await findEntryById(db(), 'no-such-id')).toBeNull()
    expect(await findEntryBySlug(db(), 'skills', 'no-such-slug')).toBeNull()
  })

  it('scopes a slug lookup to its collection', async () => {
    // The unique index is (collection, slug), so the same slug may exist twice.
    await seedEntry({ collection: 'projects', slug: 'shared' })
    await seedEntry({ collection: 'skills', slug: 'shared' })

    expect((await findEntryBySlug(db(), 'projects', 'shared'))?.collection).toBe('projects')
    expect((await findEntryBySlug(db(), 'skills', 'shared'))?.collection).toBe('skills')
    expect(await findEntryBySlug(db(), 'education', 'shared')).toBeNull()
  })

  it('finds a draft too — the status filter is the caller\'s job', async () => {
    const row = await seedEntry({ status: 'draft', slug: 'hidden' })

    expect((await findEntryById(db(), row.id))?.status).toBe('draft')
    expect((await findEntryBySlug(db(), 'projects', 'hidden'))?.status).toBe('draft')
  })
})

describe('listEntries filtering', () => {
  it('returns everything with no filters', async () => {
    await seedEntry({ collection: 'projects' })
    await seedEntry({ collection: 'skills' })

    expect(await list()).toHaveLength(2)
  })

  it('filters by collection', async () => {
    await seedEntry({ collection: 'projects' })
    await seedEntry({ collection: 'projects' })
    await seedEntry({ collection: 'skills' })

    expect(await list({ collection: 'projects' })).toHaveLength(2)
    expect(await list({ collection: 'skills' })).toHaveLength(1)
    expect(await list({ collection: 'education' })).toHaveLength(0)
  })

  it('filters by status', async () => {
    await seedEntry({ status: 'published' })
    await seedEntry({ status: 'draft' })
    await seedEntry({ status: 'archived' })

    expect(await list({ status: 'published' })).toHaveLength(1)
    expect(await list({ status: 'draft' })).toHaveLength(1)
    expect(await list({ status: 'archived' })).toHaveLength(1)
    expect(await list()).toHaveLength(3)
  })

  it('filters by featured, telling false apart from unset', async () => {
    await seedEntry({ featured: true })
    await seedEntry({ featured: false })

    expect(await list({ featured: true })).toHaveLength(1)
    expect(await list({ featured: false })).toHaveLength(1)
    expect(await list({ featured: undefined })).toHaveLength(2)
  })

  it('filters by exact tag, not by prefix', async () => {
    // The quoted form is matched precisely so `go` does not drag in `golang`.
    await seedEntry({ tags: '["go"]', slug: 'a' })
    await seedEntry({ tags: '["golang"]', slug: 'b' })

    const found = await list({ tag: 'go' })
    expect(found.map((entry) => entry.slug)).toEqual(['a'])
  })

  it('lowercases the tag it filters by', async () => {
    await seedEntry({ tags: '["typescript"]' })

    expect(await list({ tag: 'TypeScript' })).toHaveLength(1)
  })

  it('finds a tag anywhere in the array, not only first', async () => {
    await seedEntry({ tags: '["edge","workers","d1"]' })

    expect(await list({ tag: 'workers' })).toHaveLength(1)
    expect(await list({ tag: 'd1' })).toHaveLength(1)
    expect(await list({ tag: 'missing' })).toHaveLength(0)
  })

  it('searches title, summary and slug', async () => {
    await seedEntry({ slug: 'alpha', title: 'Gateway rewrite', summary: null })
    await seedEntry({ slug: 'beta', title: 'Something else', summary: 'A gateway summary' })
    await seedEntry({ slug: 'gateway-slug', title: 'Unrelated', summary: null })
    await seedEntry({ slug: 'delta', title: 'Nothing to see', summary: null })

    const found = await list({ search: 'gateway' })
    expect(found.map((entry) => entry.slug).sort()).toEqual(['alpha', 'beta', 'gateway-slug'])
  })

  it('searches case-insensitively', async () => {
    await seedEntry({ title: 'Cloudflare Workers' })

    expect(await list({ search: 'CLOUDFLARE' })).toHaveLength(1)
    expect(await list({ search: 'cloudflare' })).toHaveLength(1)
  })

  it('combines filters with AND', async () => {
    await seedEntry({ collection: 'projects', status: 'published', title: 'Match me' })
    await seedEntry({ collection: 'projects', status: 'draft', title: 'Match me too' })
    await seedEntry({ collection: 'skills', status: 'published', title: 'Match me three' })

    const found = await list({ collection: 'projects', status: 'published', search: 'match' })
    expect(found).toHaveLength(1)
    expect(found[0]?.title).toBe('Match me')
  })

  it('ignores an empty search or tag string', async () => {
    await seedEntry({ title: 'Anything' })

    expect(await list({ search: '' })).toHaveLength(1)
    expect(await list({ tag: '' })).toHaveLength(1)
  })
})

describe('listEntries ordering and paging', () => {
  it('orders by position, then most recent start, then title', async () => {
    await seedEntry({ slug: 'third', title: 'B', position: 1, startedAt: new Date('2020-01-01') })
    await seedEntry({ slug: 'first', title: 'A', position: 0, startedAt: new Date('2021-01-01') })
    await seedEntry({ slug: 'second', title: 'C', position: 0, startedAt: new Date('2019-01-01') })

    const found = await list()
    expect(found.map((entry) => entry.slug)).toEqual(['first', 'second', 'third'])
  })

  it('sorts undated entries last inside a position group', async () => {
    await seedEntry({ slug: 'dated', startedAt: new Date('2020-01-01'), position: 0 })
    await seedEntry({ slug: 'undated', startedAt: null, position: 0 })

    expect((await list()).map((entry) => entry.slug)).toEqual(['dated', 'undated'])
  })

  it('breaks a full tie by title', async () => {
    await seedEntry({ slug: 'b', title: 'Beta', position: 0, startedAt: null })
    await seedEntry({ slug: 'a', title: 'Alpha', position: 0, startedAt: null })

    expect((await list()).map((entry) => entry.title)).toEqual(['Alpha', 'Beta'])
  })

  it('honours limit and offset', async () => {
    for (const position of [0, 1, 2, 3, 4]) {
      await seedEntry({ slug: `entry-${position}`, position })
    }

    expect((await list({ limit: 2 })).map((entry) => entry.slug)).toEqual(['entry-0', 'entry-1'])
    expect((await list({ limit: 2, offset: 2 })).map((entry) => entry.slug)).toEqual(['entry-2', 'entry-3'])
    expect((await list({ limit: 2, offset: 4 })).map((entry) => entry.slug)).toEqual(['entry-4'])
    expect(await list({ limit: 2, offset: 99 })).toHaveLength(0)
  })

  it('returns nothing for a zero limit', async () => {
    await seedEntry()

    expect(await list({ limit: 0 })).toHaveLength(0)
  })
})
