import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, countRows, readAuditLog, seedEntry } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

type AdminEntry = {
  id: string
  collection: string
  slug: string
  title: string
  subtitle: string | null
  summary: string | null
  body: string | null
  status: string
  featured: boolean
  position: number
  started_at: string | null
  ended_at: string | null
  url: string | null
  image_url: string | null
  tags: string[]
  data: Record<string, unknown>
  published_at: string | null
  created_by: string | null
  updated_by: string | null
  updated_at: string
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
  env.DB.prepare('SELECT slug, title, status, tags, data, position, published_at, updated_by FROM content_entries WHERE id = ?')
    .bind(id)
    .first<{
      slug: string
      title: string
      status: string
      tags: string
      data: string
      position: number
      published_at: number | null
      updated_by: string | null
    }>()

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

describe('GET /admin/content/:collection', () => {
  it('sees entries in every state, unlike the public route', async () => {
    await seedEntry({ collection: 'projects', slug: 'live', status: 'published' })
    await seedEntry({ collection: 'projects', slug: 'draft', status: 'draft' })
    await seedEntry({ collection: 'projects', slug: 'archived', status: 'archived' })

    const entries = await dataOf<AdminEntry[]>(await call('GET', '/admin/content/projects'))
    expect(entries.map((entry) => entry.slug).sort()).toEqual(['archived', 'draft', 'live'])
  })

  it('exposes the editorial fields', async () => {
    await seedEntry({ collection: 'projects', status: 'draft', createdBy: 'a@franciscosolis.cl' })

    const [entry] = await dataOf<AdminEntry[]>(await call('GET', '/admin/content/projects'))
    expect(entry?.status).toBe('draft')
    expect(entry?.created_by).toBe('a@franciscosolis.cl')
    expect(entry).toHaveProperty('created_at')
  })

  it('narrows by status when asked', async () => {
    await seedEntry({ collection: 'projects', slug: 'live', status: 'published' })
    await seedEntry({ collection: 'projects', slug: 'draft', status: 'draft' })

    const entries = await dataOf<AdminEntry[]>(await call('GET', '/admin/content/projects?status=draft'))
    expect(entries.map((entry) => entry.slug)).toEqual(['draft'])
  })

  it('rejects a status outside the closed set', async () => {
    expect((await call('GET', '/admin/content/projects?status=deleted')).status).toBe(400)
  })

  it('filters by tag and search, and pages', async () => {
    await seedEntry({ collection: 'projects', slug: 'a', title: 'Gateway', tags: '["edge"]', position: 0 })
    await seedEntry({ collection: 'projects', slug: 'b', title: 'Gateway two', tags: '["edge"]', position: 1 })
    await seedEntry({ collection: 'projects', slug: 'c', title: 'Unrelated', tags: '["other"]', position: 2 })

    expect((await dataOf<AdminEntry[]>(await call('GET', '/admin/content/projects?tag=edge'))).length).toBe(2)
    expect((await dataOf<AdminEntry[]>(await call('GET', '/admin/content/projects?search=gateway'))).length).toBe(2)
    expect(
      (await dataOf<AdminEntry[]>(await call('GET', '/admin/content/projects?limit=1&offset=1'))).map((e) => e.slug),
    ).toEqual(['b'])
  })

  it('404s an unknown collection', async () => {
    const response = await call('GET', '/admin/content/talks')

    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Unknown collection: talks')
  })

  it('is never cached', async () => {
    expect((await call('GET', '/admin/content/projects')).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('POST /admin/content/:collection', () => {
  it('creates an entry and answers 201 with it', async () => {
    const response = await call('POST', '/admin/content/projects', { title: 'A New Project' })
    const entry = await dataOf<AdminEntry>(response)

    expect(response.status).toBe(201)
    expect(entry).toMatchObject({
      collection: 'projects',
      slug: 'a-new-project',
      title: 'A New Project',
      status: 'draft',
      featured: false,
      position: 0,
      tags: [],
      data: {},
      published_at: null,
      created_by: 'fran@franciscosolis.cl',
      updated_by: 'fran@franciscosolis.cl',
    })
    expect(await rawRow(entry.id)).toMatchObject({ slug: 'a-new-project', status: 'draft' })
  })

  it('derives the slug from the title, accents and all', async () => {
    const entry = await dataOf<AdminEntry>(await call('POST', '/admin/content/education', { title: 'Ingeniería Civil' }))

    expect(entry.slug).toBe('ingenieria-civil')
  })

  it('prefers an explicit slug, normalised', async () => {
    const entry = await dataOf<AdminEntry>(
      await call('POST', '/admin/content/projects', { title: 'Whatever', slug: '  My-Slug  ' }),
    )

    expect(entry.slug).toBe('my-slug')
  })

  it('rejects a slug that is not slug-shaped', async () => {
    for (const slug of ['-leading', 'trailing-', 'has space', 'has_underscore', 'a'.repeat(81)]) {
      const response = await call('POST', '/admin/content/projects', { title: 'T', slug })
      expect(response.status, slug).toBe(400)
    }
  })

  it('422s when no slug can be derived from the title', async () => {
    const response = await call('POST', '/admin/content/projects', { title: '!!!' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('Could not derive a slug from the title; send one explicitly')
  })

  it('mints a slug from a long title that it will then refuse to be sent back', async () => {
    // Known gap, reported separately: `slugify` truncates *after* trimming dashes, so a title that
    // lands the 80-character cut mid-word produces a trailing dash — which `SLUG_PATTERN` rejects.
    // The round trip is the symptom a CMS front-end actually hits: create, then send the entry's
    // own slug back on an edit and be told it is malformed.
    const created = await call('POST', '/admin/content/projects', { title: `${'a'.repeat(79)} b` })
    const entry = await dataOf<AdminEntry>(created)

    expect(created.status).toBe(201)
    expect(entry.slug).toBe(`${'a'.repeat(79)}-`)

    const echoed = await call('PATCH', `/admin/content/projects/${entry.id}`, { slug: entry.slug })

    expect(echoed.status).toBe(400)
    // The stored row keeps the slug the Worker itself minted, unreachable by that edit.
    expect((await rawRow(entry.id))?.slug).toBe(`${'a'.repeat(79)}-`)
  })

  it('409s a duplicate slug inside the collection', async () => {
    await call('POST', '/admin/content/projects', { title: 'Duplicate Me' })
    const response = await call('POST', '/admin/content/projects', { title: 'Duplicate Me' })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('An entry with slug "duplicate-me" already exists in projects')
    expect(await countRows('content_entries')).toBe(1)
  })

  it('allows the same slug in another collection', async () => {
    expect((await call('POST', '/admin/content/projects', { title: 'Shared' })).status).toBe(201)
    expect((await call('POST', '/admin/content/skills', { title: 'Shared' })).status).toBe(201)
  })

  it('stamps published_at when it is created live, and not otherwise', async () => {
    const live = await dataOf<AdminEntry>(
      await call('POST', '/admin/content/projects', { title: 'Live', status: 'published' }),
    )
    const draft = await dataOf<AdminEntry>(await call('POST', '/admin/content/projects', { title: 'Draft' }))

    expect(live.published_at).toEqual(expect.any(String))
    expect(draft.published_at).toBeNull()
  })

  it('validates `data` against the collection schema', async () => {
    const response = await call('POST', '/admin/content/skills', {
      title: 'TypeScript',
      data: { category: 'backend', level: 5 },
    })

    expect(response.status).toBe(201)
    expect((await dataOf<AdminEntry>(response)).data).toEqual({ category: 'backend', level: 5 })
  })

  it('422s an unknown field in `data` instead of storing the typo', async () => {
    const response = await call('POST', '/admin/content/skills', { title: 'Go', data: { levl: 3 } })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toContain('Invalid data for collection skills')
    expect(await errorOf(await call('POST', '/admin/content/skills', { title: 'Go2', data: { levl: 3 } }))).toContain(
      'levl',
    )
  })

  it('422s a `data` value outside its bounds', async () => {
    expect((await call('POST', '/admin/content/skills', { title: 'A', data: { level: 6 } })).status).toBe(422)
    expect((await call('POST', '/admin/content/skills', { title: 'B', data: { years_of_experience: 81 } })).status).toBe(
      422,
    )
    expect(
      (await call('POST', '/admin/content/projects', { title: 'C', data: { repository_url: 'not-a-url' } })).status,
    ).toBe(422)
  })

  it('applies a collection\'s own schema, not another\'s', async () => {
    // `client` belongs to projects; sending it to experience must fail.
    expect((await call('POST', '/admin/content/experience', { title: 'A', data: { client: 'ACME' } })).status).toBe(422)
    expect((await call('POST', '/admin/content/projects', { title: 'B', data: { client: 'ACME' } })).status).toBe(201)
  })

  it('lowercases the tags it stores', async () => {
    const entry = await dataOf<AdminEntry>(
      await call('POST', '/admin/content/projects', { title: 'Tagged', tags: ['Edge', ' WORKERS '] }),
    )

    expect(entry.tags).toEqual(['edge', 'workers'])
    expect(JSON.parse((await rawRow(entry.id))?.tags ?? '[]')).toEqual(['edge', 'workers'])
  })

  it('parses the ISO dates it is given', async () => {
    const entry = await dataOf<AdminEntry>(
      await call('POST', '/admin/content/experience', {
        title: 'A job',
        started_at: '2022-03-01',
        ended_at: '2024-06-30T12:00:00.000Z',
      }),
    )

    expect(entry.started_at).toBe('2022-03-01T00:00:00.000Z')
    expect(entry.ended_at).toBe('2024-06-30T12:00:00.000Z')
  })

  it('400s a date that is not ISO 8601', async () => {
    const response = await call('POST', '/admin/content/experience', { title: 'A job', started_at: 'last tuesday' })

    expect(response.status).toBe(400)
  })

  it('400s an empty title and a non-URL link', async () => {
    expect((await call('POST', '/admin/content/projects', { title: '   ' })).status).toBe(400)
    expect((await call('POST', '/admin/content/projects', { title: 'T', url: 'example.com' })).status).toBe(400)
    expect((await call('POST', '/admin/content/projects', { title: 'T', position: -1 })).status).toBe(400)
    expect((await call('POST', '/admin/content/projects', { title: 'T', position: 10_000 })).status).toBe(400)
  })

  it('404s an unknown collection before it validates anything', async () => {
    expect((await call('POST', '/admin/content/talks', { title: 'A talk' })).status).toBe(404)
  })

  it('422s a collection name that only exists on Object.prototype', async () => {
    // Known gap, reported separately: `isCollection` is an `in` check, so `toString` slips past
    // the registry guard. It has no schema, so the write is refused rather than stored.
    const response = await call('POST', '/admin/content/toString', { title: 'Prototype pollution probe' })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toBe('Invalid data for collection toString: "unknown issue"')
    expect(await countRows('content_entries')).toBe(0)
  })

  it('writes an audit row naming the actor and the entry', async () => {
    const entry = await dataOf<AdminEntry>(
      await call('POST', '/admin/content/projects', { title: 'Audited', status: 'published' }),
    )

    expect(await readAuditLog()).toEqual([
      {
        event: 'content.created',
        actor_email: 'fran@franciscosolis.cl',
        actor_id: 'editor-1',
        resource_type: 'content_entries',
        resource_id: entry.id,
        ip: null,
        user_agent: null,
        metadata: { collection: 'projects', slug: 'audited', status: 'published' },
      },
    ])
  })

  it('records the client fingerprint when the request carries one', async () => {
    await SELF.fetch('https://cms.internal/admin/content/projects', {
      method: 'POST',
      headers: { ...headers, 'CF-Connecting-IP': '203.0.113.42', 'User-Agent': 'CMS-UI/1.0' },
      body: JSON.stringify({ title: 'Fingerprinted' }),
    })

    const [row] = await readAuditLog()
    expect(row?.ip).toBe('203.0.113.42')
    expect(row?.user_agent).toBe('CMS-UI/1.0')
  })

  it('writes no audit row when the create is refused', async () => {
    await call('POST', '/admin/content/projects', { title: 'Once' })
    await call('POST', '/admin/content/projects', { title: 'Once' })

    expect(await readAuditLog()).toHaveLength(1)
  })
})

describe('GET /admin/content/:collection/:id', () => {
  it('returns a draft by id', async () => {
    const seeded = await seedEntry({ collection: 'projects', status: 'draft' })

    const entry = await dataOf<AdminEntry>(await call('GET', `/admin/content/projects/${seeded.id}`))
    expect(entry.id).toBe(seeded.id)
    expect(entry.status).toBe('draft')
  })

  it('404s an id that belongs to another collection', async () => {
    // Scoped by collection as well as id, so a foreign id cannot be reached sideways.
    const seeded = await seedEntry({ collection: 'skills' })

    const response = await call('GET', `/admin/content/projects/${seeded.id}`)
    expect(response.status).toBe(404)
    expect(await errorOf(response)).toBe('Entry not found')
  })

  it('404s an id that does not exist', async () => {
    expect((await call('GET', '/admin/content/projects/nope')).status).toBe(404)
  })
})

describe('PATCH /admin/content/:collection/:id', () => {
  it('updates only the fields it was sent', async () => {
    const seeded = await seedEntry({
      collection: 'projects',
      slug: 'original',
      title: 'Original',
      subtitle: 'Keep me',
      summary: 'Keep me too',
    })

    const entry = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { title: 'Renamed' }),
    )

    expect(entry.title).toBe('Renamed')
    expect(entry.subtitle).toBe('Keep me')
    expect(entry.summary).toBe('Keep me too')
    expect(entry.slug).toBe('original')
    expect((await rawRow(seeded.id))?.title).toBe('Renamed')
  })

  it('treats an explicit null as "clear this field"', async () => {
    const seeded = await seedEntry({
      collection: 'projects',
      subtitle: 'Set',
      summary: 'Set',
      body: 'Set',
      url: 'https://example.com',
      imageUrl: 'https://example.com/i.png',
      startedAt: new Date('2020-01-01'),
      endedAt: new Date('2021-01-01'),
    })

    const entry = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, {
        subtitle: null,
        summary: null,
        body: null,
        url: null,
        image_url: null,
        started_at: null,
        ended_at: null,
      }),
    )

    expect(entry.subtitle).toBeNull()
    expect(entry.summary).toBeNull()
    expect(entry.body).toBeNull()
    expect(entry.url).toBeNull()
    expect(entry.image_url).toBeNull()
    expect(entry.started_at).toBeNull()
    expect(entry.ended_at).toBeNull()
  })

  it('leaves an omitted field alone even when a sibling is cleared', async () => {
    const seeded = await seedEntry({ collection: 'projects', subtitle: 'Keep', summary: 'Drop' })

    const entry = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { summary: null }),
    )

    expect(entry.subtitle).toBe('Keep')
    expect(entry.summary).toBeNull()
  })

  it('replaces `data` wholesale rather than merging it', async () => {
    const seeded = await seedEntry({ collection: 'skills', data: '{"category":"backend","level":5}' })

    const entry = await dataOf<AdminEntry>(await call('PATCH', `/admin/content/skills/${seeded.id}`, { data: { level: 3 } }))

    expect(entry.data).toEqual({ level: 3 })
    expect(JSON.parse((await rawRow(seeded.id))?.data ?? '{}')).toEqual({ level: 3 })
  })

  it('replaces the tag list when it is sent and keeps it when it is not', async () => {
    const seeded = await seedEntry({ collection: 'projects', tags: '["edge","workers"]' })

    const kept = await dataOf<AdminEntry>(await call('PATCH', `/admin/content/projects/${seeded.id}`, { title: 'X' }))
    expect(kept.tags).toEqual(['edge', 'workers'])

    const replaced = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { tags: ['D1', ' Hono '] }),
    )
    expect(replaced.tags).toEqual(['d1', 'hono'])
    expect(JSON.parse((await rawRow(seeded.id))?.tags ?? '[]')).toEqual(['d1', 'hono'])

    const emptied = await dataOf<AdminEntry>(await call('PATCH', `/admin/content/projects/${seeded.id}`, { tags: [] }))
    expect(emptied.tags).toEqual([])
  })

  it('leaves `data` alone when it is omitted', async () => {
    const seeded = await seedEntry({ collection: 'skills', data: '{"level":5}' })

    const entry = await dataOf<AdminEntry>(await call('PATCH', `/admin/content/skills/${seeded.id}`, { title: 'New' }))

    expect(entry.data).toEqual({ level: 5 })
  })

  it('422s an unknown field in `data` and leaves the row untouched', async () => {
    const seeded = await seedEntry({ collection: 'skills', data: '{"level":5}' })

    const response = await call('PATCH', `/admin/content/skills/${seeded.id}`, { data: { levl: 3 } })

    expect(response.status).toBe(422)
    expect(JSON.parse((await rawRow(seeded.id))?.data ?? '{}')).toEqual({ level: 5 })
  })

  it('stamps published_at the first time an entry goes live', async () => {
    const seeded = await seedEntry({ collection: 'projects', status: 'draft', publishedAt: null })

    const entry = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { status: 'published' }),
    )

    expect(entry.published_at).toEqual(expect.any(String))
  })

  it('keeps the original published_at through unpublish and republish', async () => {
    // It records when the thing was announced, not when the toggle was last flipped.
    const announced = new Date('2024-05-05T10:00:00.000Z')
    const seeded = await seedEntry({ collection: 'projects', status: 'published', publishedAt: announced })

    const unpublished = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { status: 'draft' }),
    )
    const republished = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { status: 'published' }),
    )

    expect(unpublished.published_at).toBe(announced.toISOString())
    expect(republished.published_at).toBe(announced.toISOString())
  })

  it('does not stamp published_at while the entry stays a draft', async () => {
    const seeded = await seedEntry({ collection: 'projects', status: 'draft', publishedAt: null })

    const entry = await dataOf<AdminEntry>(
      await call('PATCH', `/admin/content/projects/${seeded.id}`, { title: 'Still hidden' }),
    )

    expect(entry.published_at).toBeNull()
  })

  it('publishing makes the entry visible to the public route', async () => {
    const seeded = await seedEntry({ collection: 'projects', slug: 'about-to-launch', status: 'draft' })

    expect((await SELF.fetch('https://cms.internal/content/projects/about-to-launch')).status).toBe(404)
    await call('PATCH', `/admin/content/projects/${seeded.id}`, { status: 'published' })
    expect((await SELF.fetch('https://cms.internal/content/projects/about-to-launch')).status).toBe(200)
  })

  it('409s when the new slug is taken by a sibling', async () => {
    await seedEntry({ collection: 'projects', slug: 'taken' })
    const seeded = await seedEntry({ collection: 'projects', slug: 'mine' })

    const response = await call('PATCH', `/admin/content/projects/${seeded.id}`, { slug: 'taken' })

    expect(response.status).toBe(409)
    expect(await errorOf(response)).toBe('An entry with slug "taken" already exists in projects')
    expect((await rawRow(seeded.id))?.slug).toBe('mine')
  })

  it('allows a no-op slug write on the same row', async () => {
    const seeded = await seedEntry({ collection: 'projects', slug: 'same' })

    expect((await call('PATCH', `/admin/content/projects/${seeded.id}`, { slug: 'same' })).status).toBe(200)
  })

  it('records the editor who touched it', async () => {
    const seeded = await seedEntry({ collection: 'projects', updatedBy: 'someone-else@franciscosolis.cl' })

    await call('PATCH', `/admin/content/projects/${seeded.id}`, { title: 'Touched' })

    expect((await rawRow(seeded.id))?.updated_by).toBe('fran@franciscosolis.cl')
  })

  it('404s an entry in another collection and one that does not exist', async () => {
    const seeded = await seedEntry({ collection: 'skills' })

    expect((await call('PATCH', `/admin/content/projects/${seeded.id}`, { title: 'X' })).status).toBe(404)
    expect((await call('PATCH', '/admin/content/projects/nope', { title: 'X' })).status).toBe(404)
  })

  it('accepts an empty body as a no-op that still bumps the editor', async () => {
    const before = new Date('2024-01-01T00:00:00.000Z')
    const seeded = await seedEntry({
      collection: 'projects',
      title: 'Unchanged',
      updatedBy: 'someone-else@franciscosolis.cl',
      updatedAt: before,
    })

    const response = await call('PATCH', `/admin/content/projects/${seeded.id}`, {})
    const entry = await dataOf<AdminEntry>(response)

    expect(response.status).toBe(200)
    expect(entry.title).toBe('Unchanged')
    // The half the name promises: nothing was sent, but the row still records who touched it and
    // when. Both are read off the stored row, not just the echoed response.
    expect(entry.updated_by).toBe('fran@franciscosolis.cl')
    expect((await rawRow(seeded.id))?.updated_by).toBe('fran@franciscosolis.cl')
    expect(new Date(entry.updated_at).getTime()).toBeGreaterThan(before.getTime())
  })

  it('audits an empty PATCH as an update with no fields', async () => {
    const seeded = await seedEntry({ collection: 'projects', slug: 'untouched', status: 'draft' })

    await call('PATCH', `/admin/content/projects/${seeded.id}`, {})

    const [row] = await readAuditLog()
    expect(row?.event).toBe('content.updated')
    expect(row?.metadata).toEqual({ collection: 'projects', fields: [], status: 'draft' })
  })

  it('writes an audit row naming the fields that were sent', async () => {
    const seeded = await seedEntry({ collection: 'projects', slug: 'audited', status: 'draft' })

    await call('PATCH', `/admin/content/projects/${seeded.id}`, { title: 'New title', status: 'published' })

    const [row] = await readAuditLog()
    expect(row?.event).toBe('content.updated')
    expect(row?.resource_id).toBe(seeded.id)
    expect(row?.metadata).toEqual({ collection: 'projects', fields: ['title', 'status'], status: 'published' })
  })
})

describe('DELETE /admin/content/:collection/:id', () => {
  it('deletes the entry and answers 204 with no body', async () => {
    const seeded = await seedEntry({ collection: 'projects' })

    const response = await call('DELETE', `/admin/content/projects/${seeded.id}`)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(await countRows('content_entries')).toBe(0)
  })

  it('404s an entry in another collection and leaves it alone', async () => {
    const seeded = await seedEntry({ collection: 'skills' })

    expect((await call('DELETE', `/admin/content/projects/${seeded.id}`)).status).toBe(404)
    expect(await countRows('content_entries')).toBe(1)
  })

  it('404s an id that does not exist', async () => {
    expect((await call('DELETE', '/admin/content/projects/nope')).status).toBe(404)
  })

  it('writes an audit row that outlives the entry', async () => {
    const seeded = await seedEntry({ collection: 'projects', slug: 'gone' })

    await call('DELETE', `/admin/content/projects/${seeded.id}`)

    const [row] = await readAuditLog()
    expect(row?.event).toBe('content.deleted')
    expect(row?.resource_id).toBe(seeded.id)
    expect(row?.metadata).toEqual({ collection: 'projects', slug: 'gone' })
  })
})

describe('POST /admin/content/:collection/reorder', () => {
  it('sets the position of several entries at once', async () => {
    const first = await seedEntry({ collection: 'projects', slug: 'first', position: 0 })
    const second = await seedEntry({ collection: 'projects', slug: 'second', position: 1 })

    const response = await call('POST', '/admin/content/projects/reorder', {
      items: [
        { id: first.id, position: 10 },
        { id: second.id, position: 5 },
      ],
    })

    expect(response.status).toBe(200)
    expect((await dataOf<AdminEntry[]>(response)).map((entry) => entry.slug)).toEqual(['second', 'first'])
    expect((await rawRow(first.id))?.position).toBe(10)
    expect((await rawRow(second.id))?.position).toBe(5)
  })

  it('is not swallowed by the `:id` route registered after it', async () => {
    // `reorder` is a literal segment competing with `/content/:collection/:id`.
    const seeded = await seedEntry({ collection: 'projects' })

    const response = await call('POST', '/admin/content/projects/reorder', {
      items: [{ id: seeded.id, position: 3 }],
    })

    expect(response.status).toBe(200)
  })

  it('ignores an id from another collection instead of reaching into it', async () => {
    const mine = await seedEntry({ collection: 'projects', position: 0 })
    const foreign = await seedEntry({ collection: 'skills', position: 0 })

    await call('POST', '/admin/content/projects/reorder', {
      items: [
        { id: mine.id, position: 7 },
        { id: foreign.id, position: 9 },
      ],
    })

    expect((await rawRow(mine.id))?.position).toBe(7)
    expect((await rawRow(foreign.id))?.position).toBe(0)
  })

  it('tolerates an id that does not exist', async () => {
    const seeded = await seedEntry({ collection: 'projects' })

    const response = await call('POST', '/admin/content/projects/reorder', {
      items: [
        { id: seeded.id, position: 2 },
        { id: 'ghost', position: 3 },
      ],
    })

    expect(response.status).toBe(200)
    expect((await rawRow(seeded.id))?.position).toBe(2)
  })

  it('returns the whole collection in its new order, drafts included', async () => {
    const draft = await seedEntry({ collection: 'projects', slug: 'draft', status: 'draft', position: 9 })
    const live = await seedEntry({ collection: 'projects', slug: 'live', position: 0 })

    const entries = await dataOf<AdminEntry[]>(
      await call('POST', '/admin/content/projects/reorder', { items: [{ id: draft.id, position: 0 }] }),
    )

    expect(entries.map((entry) => entry.id).sort()).toEqual([draft.id, live.id].sort())
  })

  it('rejects an empty list and an out-of-range position', async () => {
    const seeded = await seedEntry({ collection: 'projects' })

    expect((await call('POST', '/admin/content/projects/reorder', { items: [] })).status).toBe(400)
    expect(
      (await call('POST', '/admin/content/projects/reorder', { items: [{ id: seeded.id, position: -1 }] })).status,
    ).toBe(400)
    expect(
      (await call('POST', '/admin/content/projects/reorder', { items: [{ id: seeded.id, position: 10_000 }] })).status,
    ).toBe(400)
  })

  it('404s an unknown collection', async () => {
    expect((await call('POST', '/admin/content/talks/reorder', { items: [{ id: 'x', position: 0 }] })).status).toBe(404)
  })

  it('writes an audit row with the size of the reorder', async () => {
    const first = await seedEntry({ collection: 'projects' })
    const second = await seedEntry({ collection: 'projects' })

    await call('POST', '/admin/content/projects/reorder', {
      items: [
        { id: first.id, position: 1 },
        { id: second.id, position: 0 },
      ],
    })

    const [row] = await readAuditLog()
    expect(row?.event).toBe('content.reordered')
    expect(row?.metadata).toEqual({ collection: 'projects', count: 2 })
    expect(row?.resource_id).toBeNull()
  })
})
