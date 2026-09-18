import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, countRows, seedApplication, seedWikiPage } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://pages.test/admin${path}`, { ...init, headers: { ...(await asEditor()), ...init.headers } })

const json = async <T>(response: Response): Promise<T> => ((await response.json()) as { data: T }).data
const errorOf = async (response: Response) => (await response.json<{ error: string }>()).error

describe('POST /admin/applications/:applicationId/wiki', () => {
  beforeEach(clearDatabase)

  const post = (applicationId: string, payload: Record<string, unknown>) =>
    admin(`/applications/${applicationId}/wiki`, { method: 'POST', body: JSON.stringify(payload) })

  it('creates a page and derives its slug from the title', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    const data = await json<{ slug: string; parent_id: string | null }>(await post(app.id, { title: 'Installation Guide' }))

    expect(data.slug).toBe('installation-guide')
    expect(data.parent_id).toBeNull()
  })

  it('nests a page under a top-level section', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview' })

    const data = await json<{ parent_id: string | null }>(await post(app.id, { title: 'Commands', parent_id: section.id }))

    expect(data.parent_id).toBe(section.id)
  })

  it('refuses a duplicate slug inside the application, with a 409', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedWikiPage({ applicationId: app.id, slug: 'install' })

    expect((await post(app.id, { title: 'Install', slug: 'install' })).status).toBe(409)
  })

  it('allows the same slug in a different application', async () => {
    const one = await seedApplication({ slug: 'one' })
    const two = await seedApplication({ slug: 'two' })
    await seedWikiPage({ applicationId: one.id, slug: 'install' })

    expect((await post(two.id, { title: 'Install', slug: 'install' })).status).toBe(201)
  })
})

/**
 * The sidebar is two levels deep by rule rather than by schema, because a self-referencing column
 * cannot express a depth limit. Every shape that would break the tree is refused here with a 422.
 */
describe('the wiki hierarchy rules', () => {
  beforeEach(clearDatabase)

  const post = (applicationId: string, payload: Record<string, unknown>) =>
    admin(`/applications/${applicationId}/wiki`, { method: 'POST', body: JSON.stringify(payload) })

  const patch = (applicationId: string, id: string, payload: Record<string, unknown>) =>
    admin(`/applications/${applicationId}/wiki/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })

  it('refuses a parent belonging to another application', async () => {
    const mine = await seedApplication({ slug: 'mine' })
    const theirs = await seedApplication({ slug: 'theirs' })
    const foreign = await seedWikiPage({ applicationId: theirs.id, slug: 'overview' })

    const response = await post(mine.id, { title: 'Commands', parent_id: foreign.id })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toContain('does not belong to this application')
  })

  it('refuses a parent that does not exist', async () => {
    const app = await seedApplication({ slug: 'openbattery' })

    expect((await post(app.id, { title: 'Commands', parent_id: crypto.randomUUID() })).status).toBe(422)
  })

  it('refuses nesting under a page that is itself nested', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview' })
    const child = await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: section.id })

    const response = await post(app.id, { title: 'Flags', parent_id: child.id })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toContain('levels deep')
  })

  it('refuses making a page its own parent', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const page = await seedWikiPage({ applicationId: app.id, slug: 'overview' })

    const response = await patch(app.id, page.id, { parent_id: page.id })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toContain('its own parent')
  })

  /** The same rule seen from the other end: nesting a section would make its children three deep. */
  it('refuses nesting a page that already has pages under it', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview' })
    await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: section.id })
    const other = await seedWikiPage({ applicationId: app.id, slug: 'install' })

    const response = await patch(app.id, section.id, { parent_id: other.id })

    expect(response.status).toBe(422)
    expect(await errorOf(response)).toContain('pages under it')
  })

  it('moves a page back to the top level with an explicit null', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview' })
    const child = await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: section.id })

    const data = await json<{ parent_id: string | null }>(await patch(app.id, child.id, { parent_id: null }))

    expect(data.parent_id).toBeNull()
  })

  it('leaves the parent alone when the field is simply omitted', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview' })
    const child = await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: section.id })

    const data = await json<{ parent_id: string | null }>(await patch(app.id, child.id, { title: 'Commands & flags' }))

    expect(data.parent_id).toBe(section.id)
  })
})

describe('GET /admin/applications/:applicationId/wiki', () => {
  beforeEach(clearDatabase)

  it('lists every page flat, in sidebar order, drafts included', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedWikiPage({ applicationId: app.id, slug: 'second', position: 1 })
    await seedWikiPage({ applicationId: app.id, slug: 'first', position: 0, status: 'draft' })

    const data = await json<{ slug: string }[]>(await admin(`/applications/${app.id}/wiki`))

    expect(data.map((row) => row.slug)).toEqual(['first', 'second'])
  })

  it('nests the same pages when asked for the tree, and drops the bodies', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview', position: 0 })
    await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: section.id, position: 1 })

    const tree = await json<{ slug: string; children: { slug: string }[] }[]>(
      await admin(`/applications/${app.id}/wiki?tree=true`),
    )

    expect(tree.map((node) => node.slug)).toEqual(['overview'])
    expect(tree[0]?.children.map((child) => child.slug)).toEqual(['commands'])
    expect(tree[0]).not.toHaveProperty('body')
  })
})

describe('POST /admin/applications/:applicationId/wiki/reorder', () => {
  beforeEach(clearDatabase)

  it('applies the new order', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const first = await seedWikiPage({ applicationId: app.id, slug: 'first', position: 0 })
    const second = await seedWikiPage({ applicationId: app.id, slug: 'second', position: 1 })

    const data = await json<{ slug: string }[]>(
      await admin(`/applications/${app.id}/wiki/reorder`, {
        method: 'POST',
        body: JSON.stringify({ items: [{ id: first.id, position: 1 }, { id: second.id, position: 0 }] }),
      }),
    )

    expect(data.map((row) => row.slug)).toEqual(['second', 'first'])
  })

  /** Scoped by application: a foreign id is ignored rather than reordering someone else's sidebar. */
  it('ignores an id belonging to another application', async () => {
    const mine = await seedApplication({ slug: 'mine' })
    const theirs = await seedApplication({ slug: 'theirs' })
    const foreign = await seedWikiPage({ applicationId: theirs.id, slug: 'overview', position: 0 })

    await admin(`/applications/${mine.id}/wiki/reorder`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: foreign.id, position: 99 }] }),
    })

    const [row] = await json<{ position: number }[]>(await admin(`/applications/${theirs.id}/wiki`))
    expect(row.position).toBe(0)
  })
})

describe('DELETE on a wiki page', () => {
  beforeEach(clearDatabase)

  /**
   * Deleting a section must never silently take the documentation inside it. The column carries no
   * foreign key onto itself — a page is reparented far more often than it is deleted — so the
   * children are promoted explicitly before the row goes.
   */
  it('promotes the pages nested under it instead of deleting them', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview' })
    const child = await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: section.id })

    const response = await admin(`/applications/${app.id}/wiki/${section.id}`, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await countRows('application_wiki_pages')).toBe(1)

    const data = await json<{ id: string; parent_id: string | null }>(
      await admin(`/applications/${app.id}/wiki/${child.id}`),
    )
    expect(data.parent_id).toBeNull()
  })

  it('will not delete a page through the wrong application', async () => {
    const mine = await seedApplication({ slug: 'mine' })
    const theirs = await seedApplication({ slug: 'theirs' })
    const page = await seedWikiPage({ applicationId: theirs.id, slug: 'secrets' })

    expect((await admin(`/applications/${mine.id}/wiki/${page.id}`, { method: 'DELETE' })).status).toBe(404)
  })
})
