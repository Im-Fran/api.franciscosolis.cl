import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, countRows, readAuditLog, seedApplication } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://pages.test/admin${path}`, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const json = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data

const create = (payload: Record<string, unknown>) =>
  admin('/applications', { method: 'POST', body: JSON.stringify(payload) })

describe('POST /admin/applications', () => {
  beforeEach(clearDatabase)

  it('creates an application and derives the slug from the name', async () => {
    const response = await create({ name: 'OpenBattery' })

    expect(response.status).toBe(201)
    const data = await json<Record<string, unknown>>(response)
    expect(data.slug).toBe('openbattery')
    expect(data.status).toBe('draft')
  })

  it('strips the accents a Spanish name carries when it derives a slug', async () => {
    const data = await json<{ slug: string }>(await create({ name: 'Batería Abierta' }))

    expect(data.slug).toBe('bateria-abierta')
  })

  /** Overview is not optional: a page without it is a banner and a row of links. */
  it('always puts the overview tab first, whatever tabs were asked for', async () => {
    const data = await json<{ tabs: string[] }>(await create({ name: 'OpenBattery', tabs: ['contact', 'wiki'] }))

    expect(data.tabs).toEqual(['overview', 'contact', 'wiki'])
  })

  it('stamps published_at on a page created live', async () => {
    const data = await json<{ published_at: string | null }>(await create({ name: 'Live', status: 'published' }))

    expect(data.published_at).not.toBeNull()
  })

  it('leaves published_at empty on a draft', async () => {
    const data = await json<{ published_at: string | null }>(await create({ name: 'Draft' }))

    expect(data.published_at).toBeNull()
  })

  it('refuses a duplicate slug with a 409 rather than a 500', async () => {
    await create({ name: 'OpenBattery' })

    const response = await create({ name: 'Open Battery', slug: 'openbattery' })

    expect(response.status).toBe(409)
    expect((await response.json<{ error: string }>()).error).toContain('openbattery')
  })

  it.each([
    ['a name that is only whitespace', { name: '   ' }],
    ['a slug with characters a URL would have to escape', { name: 'X', slug: 'not a slug' }],
    ['an accent colour that is not a hex value', { name: 'X', accent_color: 'rebeccapurple' }],
    ['a banner that is not an absolute URL', { name: 'X', banner_image_url: '/banner.png' }],
    ['a tab the service does not have', { name: 'X', tabs: ['forum'] }],
    ['a link kind the service does not render', { name: 'X', links: [{ kind: 'myspace', url: 'https://a.test' }] }],
  ])('refuses %s', async (_label, payload) => {
    expect((await create(payload)).status).toBe(400)
  })

  it('refuses a name it cannot derive any slug from, rather than storing an empty one', async () => {
    const response = await create({ name: '???' })

    expect(response.status).toBe(422)
  })

  it('writes an audit row naming the editor', async () => {
    await create({ name: 'OpenBattery' })

    const [entry] = await readAuditLog()
    expect(entry?.event).toBe('application.created')
    expect(entry?.actor_email).toBe('fran@franciscosolis.cl')
    expect(entry?.resource_type).toBe('applications')
  })
})

describe('GET /admin/applications', () => {
  beforeEach(clearDatabase)

  it('shows drafts, which the public listing never does', async () => {
    await seedApplication({ slug: 'draft-one', status: 'draft' })
    await seedApplication({ slug: 'live-one', status: 'published' })

    const data = await json<{ slug: string }[]>(await admin('/applications'))

    expect(data.map((row) => row.slug).sort()).toEqual(['draft-one', 'live-one'])
  })

  it('narrows on status', async () => {
    await seedApplication({ slug: 'draft-one', status: 'draft' })
    await seedApplication({ slug: 'live-one', status: 'published' })

    const data = await json<{ slug: string }[]>(await admin('/applications?status=draft'))

    expect(data.map((row) => row.slug)).toEqual(['draft-one'])
  })

  /** The editorial view is always the default locale, with the raw map beside it. */
  it('answers in the default locale and hands back the translation map unresolved', async () => {
    await seedApplication({ slug: 'openbattery', name: 'OpenBattery', translations: '{"es":{"name":"Batería"}}' })

    const [row] = await json<{ name: string; translations: Record<string, unknown> }[]>(await admin('/applications'))

    expect(row.name).toBe('OpenBattery')
    expect(row.translations).toEqual({ es: { name: 'Batería' } })
  })
})

describe('PATCH /admin/applications/:id', () => {
  beforeEach(clearDatabase)

  const patch = (id: string, payload: Record<string, unknown>) =>
    admin(`/applications/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })

  it('leaves an omitted field alone and clears one sent as null', async () => {
    const app = await seedApplication({ slug: 'openbattery', tagline: 'Telemetry', summary: 'A summary' })

    const data = await json<Record<string, unknown>>(await patch(app.id, { summary: null }))

    expect(data.tagline).toBe('Telemetry')
    expect(data.summary).toBeNull()
  })

  it('replaces the tabs wholesale rather than merging them', async () => {
    const app = await seedApplication({ slug: 'openbattery', tabs: '["overview","updates","wiki"]' })

    const data = await json<{ tabs: string[] }>(await patch(app.id, { tabs: ['contact'] }))

    expect(data.tabs).toEqual(['overview', 'contact'])
  })

  /**
   * `published_at` records when the application was announced, not when its status last moved, so
   * unpublishing and republishing must not rewrite it.
   */
  it('keeps the original published_at across an unpublish and a republish', async () => {
    const announced = new Date('2025-03-01T00:00:00Z')
    const app = await seedApplication({ slug: 'openbattery', status: 'published', publishedAt: announced })

    await patch(app.id, { status: 'draft' })
    const data = await json<{ published_at: string }>(await patch(app.id, { status: 'published' }))

    expect(new Date(data.published_at).toISOString()).toBe(announced.toISOString())
  })

  it('refuses a slug another application already holds', async () => {
    await seedApplication({ slug: 'taken' })
    const app = await seedApplication({ slug: 'mine' })

    expect((await patch(app.id, { slug: 'taken' })).status).toBe(409)
  })

  it('answers 404 for an application that does not exist', async () => {
    expect((await patch(crypto.randomUUID(), { name: 'X' })).status).toBe(404)
  })
})

describe('POST /admin/applications/reorder', () => {
  beforeEach(clearDatabase)

  it('applies the new order and answers with the list', async () => {
    const first = await seedApplication({ slug: 'first', position: 0 })
    const second = await seedApplication({ slug: 'second', position: 1 })

    const data = await json<{ slug: string }[]>(
      await admin('/applications/reorder', {
        method: 'POST',
        body: JSON.stringify({ items: [{ id: first.id, position: 1 }, { id: second.id, position: 0 }] }),
      }),
    )

    expect(data.map((row) => row.slug)).toEqual(['second', 'first'])
  })

  /** The literal segment must win over `/:id`, whichever router Hono picks at runtime. */
  it('is not swallowed by the :id route', async () => {
    const response = await admin('/applications/reorder', {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: crypto.randomUUID(), position: 0 }] }),
    })

    expect(response.status).toBe(200)
  })
})

describe('DELETE /admin/applications/:id', () => {
  beforeEach(clearDatabase)

  /**
   * The cascade is the reason the foreign keys exist at all: a release note or a wiki page left
   * behind would be invisible to every route here while still holding its slug.
   */
  it('takes the release notes and the wiki pages with it', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await SELF.fetch(`https://pages.test/admin/applications/${app.id}/updates`, {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ version: '1.0.0', title: 'First' }),
    })
    await SELF.fetch(`https://pages.test/admin/applications/${app.id}/wiki`, {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ title: 'Installation' }),
    })

    expect(await countRows('application_updates')).toBe(1)
    expect(await countRows('application_wiki_pages')).toBe(1)

    const response = await admin(`/applications/${app.id}`, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await countRows('applications')).toBe(0)
    expect(await countRows('application_updates')).toBe(0)
    expect(await countRows('application_wiki_pages')).toBe(0)
  })

  it('answers 404 for an application that does not exist', async () => {
    expect((await admin(`/applications/${crypto.randomUUID()}`, { method: 'DELETE' })).status).toBe(404)
  })
})
