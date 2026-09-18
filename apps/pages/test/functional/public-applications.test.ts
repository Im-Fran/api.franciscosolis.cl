import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedApplication, seedUpdate, seedWikiPage } from '../helpers/db'

const get = (path: string) => SELF.fetch(`https://pages.test${path}`)
const body = async <T>(path: string): Promise<T> => ((await (await get(path)).json()) as { data: T }).data

describe('GET /applications', () => {
  beforeEach(clearDatabase)

  it('lists published applications in the order an editor arranged them', async () => {
    await seedApplication({ slug: 'second', name: 'Second', position: 1 })
    await seedApplication({ slug: 'first', name: 'First', position: 0 })

    const data = await body<{ slug: string }[]>('/applications')

    expect(data.map((row) => row.slug)).toEqual(['first', 'second'])
  })

  it.each(['draft', 'archived'])('never shows a %s application', async (status) => {
    await seedApplication({ slug: 'hidden', status })

    expect(await body<unknown[]>('/applications')).toEqual([])
  })

  /**
   * The two tab bodies are Markdown documents capped at 200 kB apiece. A listing of twenty
   * applications carrying both is megabytes of text nobody on that screen reads.
   */
  it('leaves the tab bodies out of the listing', async () => {
    await seedApplication({ slug: 'openbattery', overviewBody: '# Long document', contactBody: 'Reach us' })

    const [row] = await body<Record<string, unknown>[]>('/applications')

    expect(row).not.toHaveProperty('overview_body')
    expect(row).not.toHaveProperty('contact_body')
    expect(row.slug).toBe('openbattery')
  })

  it('filters on featured', async () => {
    await seedApplication({ slug: 'pinned', featured: true })
    await seedApplication({ slug: 'ordinary', featured: false })

    expect((await body<{ slug: string }[]>('/applications?featured=true')).map((row) => row.slug)).toEqual(['pinned'])
  })

  it('searches the name, the tagline and the slug', async () => {
    await seedApplication({ slug: 'openbattery', name: 'OpenBattery', tagline: 'Telemetry for packs' })
    await seedApplication({ slug: 'other', name: 'Something else', tagline: null })

    expect((await body<{ slug: string }[]>('/applications?search=telemetry')).map((row) => row.slug)).toEqual([
      'openbattery',
    ])
  })

  it('is cacheable, unlike everything else this Worker answers', async () => {
    const response = await get('/applications')

    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/)
  })
})

describe('GET /applications/:slug', () => {
  beforeEach(clearDatabase)

  it('answers with the page, its tabs, its links and its Markdown', async () => {
    await seedApplication({
      slug: 'openbattery',
      name: 'OpenBattery',
      tagline: 'Battery telemetry that is actually open',
      tabs: '["overview","updates","wiki","contact"]',
      links: '[{"kind":"github","url":"https://github.com/example/openbattery","label":"Source"}]',
      overviewBody: '# OpenBattery',
      contactBody: 'Open an issue.',
      accentColor: '#A855F7',
      bannerImageUrl: 'https://cdn.example.com/banner.png',
    })

    const data = await body<Record<string, unknown>>('/applications/openbattery')

    expect(data.name).toBe('OpenBattery')
    expect(data.tabs).toEqual(['overview', 'updates', 'wiki', 'contact'])
    expect(data.links).toEqual([
      { kind: 'github', url: 'https://github.com/example/openbattery', label: 'Source' },
    ])
    expect(data.overview_body).toBe('# OpenBattery')
    expect(data.contact_body).toBe('Open an issue.')
    expect(data.accent_color).toBe('#A855F7')
    expect(data.banner_image_url).toBe('https://cdn.example.com/banner.png')
  })

  /** A draft answers 404 rather than 403: a 403 would confirm the slug of an unannounced page. */
  it.each(['draft', 'archived'])('answers 404 for a %s application rather than admitting it exists', async (status) => {
    await seedApplication({ slug: 'unannounced', status })

    expect((await get('/applications/unannounced')).status).toBe(404)
  })

  it('answers 404 for a slug nobody took', async () => {
    expect((await get('/applications/nope')).status).toBe(404)
  })
})

describe('?locale on a public read', () => {
  beforeEach(clearDatabase)

  it('resolves the overrides server-side, so the caller reads plain fields', async () => {
    await seedApplication({
      slug: 'openbattery',
      name: 'OpenBattery',
      tagline: 'Battery telemetry',
      translations: '{"es":{"name":"Batería Abierta"}}',
    })

    const data = await body<Record<string, unknown>>('/applications/openbattery?locale=es')

    expect(data.name).toBe('Batería Abierta')
    // Untranslated, so it falls back rather than rendering empty.
    expect(data.tagline).toBe('Battery telemetry')
    expect(data.locale).toBe('es')
    expect(data.available_locales).toEqual(['en', 'es'])
  })

  it('says which locale actually came back when the one asked for is untranslated', async () => {
    await seedApplication({ slug: 'openbattery', translations: '{}' })

    const data = await body<Record<string, unknown>>('/applications/openbattery?locale=es')

    expect(data.locale).toBe('en')
    expect(data.available_locales).toEqual(['en'])
  })

  it('refuses a locale the service does not publish, rather than serving a silent fallback', async () => {
    await seedApplication({ slug: 'openbattery' })

    expect((await get('/applications/openbattery?locale=fr')).status).toBe(400)
  })
})

describe('GET /applications/:slug/updates', () => {
  beforeEach(clearDatabase)

  const day = (iso: string) => new Date(iso)

  it('orders by the day the version shipped, not by when the entry was written', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    // Written in this order; released in the opposite one.
    await seedUpdate({ applicationId: app.id, version: '1.0.0', releasedAt: day('2025-01-01T00:00:00Z') })
    await seedUpdate({ applicationId: app.id, version: '2.0.0', releasedAt: day('2026-01-01T00:00:00Z') })

    const data = await body<{ version: string }[]>('/applications/openbattery/updates')

    expect(data.map((row) => row.version)).toEqual(['2.0.0', '1.0.0'])
  })

  it.each(['draft', 'archived'])('never shows a %s release', async (status) => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedUpdate({ applicationId: app.id, version: '1.0.0', status })

    expect(await body<unknown[]>('/applications/openbattery/updates')).toEqual([])
  })

  /** A draft application hides everything behind its tabs, not just its own row. */
  it('answers 404 for the updates of an unpublished application', async () => {
    await seedApplication({ slug: 'unannounced', status: 'draft' })

    expect((await get('/applications/unannounced/updates')).status).toBe(404)
  })

  it('carries the release links', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedUpdate({
      applicationId: app.id,
      version: '2.6.4',
      links: '[{"kind":"play_store","url":"https://play.google.com/store/apps/details?id=x","label":null}]',
    })

    const [row] = await body<{ links: unknown[] }[]>('/applications/openbattery/updates')

    expect(row.links).toEqual([
      { kind: 'play_store', url: 'https://play.google.com/store/apps/details?id=x', label: null },
    ])
  })
})

describe('GET /applications/:slug/updates/:version', () => {
  beforeEach(clearDatabase)

  it('addresses a release by its version label', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedUpdate({ applicationId: app.id, version: '2.6.4', title: 'Full 1.21.11 support' })

    const data = await body<{ title: string }>('/applications/openbattery/updates/2.6.4')

    expect(data.title).toBe('Full 1.21.11 support')
  })

  it('answers 404 for a draft release', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedUpdate({ applicationId: app.id, version: '3.0.0', status: 'draft' })

    expect((await get('/applications/openbattery/updates/3.0.0')).status).toBe(404)
  })

  /** Scoped by application: a version belonging to another page must not resolve through this one. */
  it('does not reach a release of a different application', async () => {
    const mine = await seedApplication({ slug: 'mine' })
    const theirs = await seedApplication({ slug: 'theirs' })
    await seedUpdate({ applicationId: theirs.id, version: '9.9.9' })
    await seedUpdate({ applicationId: mine.id, version: '1.0.0' })

    expect((await get('/applications/mine/updates/9.9.9')).status).toBe(404)
  })
})

describe('GET /applications/:slug/wiki', () => {
  beforeEach(clearDatabase)

  it('answers with the sidebar as a tree, without bodies', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const section = await seedWikiPage({ applicationId: app.id, slug: 'overview', title: 'Overview', position: 0 })
    await seedWikiPage({ applicationId: app.id, slug: 'commands', title: 'Commands', parentId: section.id, position: 1 })
    await seedWikiPage({ applicationId: app.id, slug: 'install', title: 'Installation', position: 2 })

    const tree = await body<{ slug: string; children: { slug: string }[] }[]>('/applications/openbattery/wiki')

    expect(tree.map((node) => node.slug)).toEqual(['overview', 'install'])
    expect(tree[0]?.children.map((child) => child.slug)).toEqual(['commands'])
    expect(tree[0]).not.toHaveProperty('body')
  })

  it('keeps a published page whose section is still a draft, at the top level', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    const draftSection = await seedWikiPage({ applicationId: app.id, slug: 'secret', status: 'draft' })
    await seedWikiPage({ applicationId: app.id, slug: 'commands', parentId: draftSection.id })

    const tree = await body<{ slug: string }[]>('/applications/openbattery/wiki')

    expect(tree.map((node) => node.slug)).toEqual(['commands'])
  })
})

describe('GET /applications/:slug/wiki/:page', () => {
  beforeEach(clearDatabase)

  it('answers with the page and its Markdown body', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedWikiPage({ applicationId: app.id, slug: 'install', title: 'Installation', body: '## Drop the jar in' })

    const data = await body<{ title: string; body: string }>('/applications/openbattery/wiki/install')

    expect(data.title).toBe('Installation')
    expect(data.body).toBe('## Drop the jar in')
  })

  it('answers 404 for a draft page', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedWikiPage({ applicationId: app.id, slug: 'wip', status: 'draft' })

    expect((await get('/applications/openbattery/wiki/wip')).status).toBe(404)
  })

  it('does not reach a page of a different application', async () => {
    const mine = await seedApplication({ slug: 'mine' })
    const theirs = await seedApplication({ slug: 'theirs' })
    await seedWikiPage({ applicationId: theirs.id, slug: 'secrets' })
    await seedWikiPage({ applicationId: mine.id, slug: 'install' })

    expect((await get('/applications/mine/wiki/secrets')).status).toBe(404)
  })

  it('serves the translated body when one exists', async () => {
    const app = await seedApplication({ slug: 'openbattery' })
    await seedWikiPage({
      applicationId: app.id,
      slug: 'install',
      title: 'Installation',
      body: 'Drop the jar in',
      translations: '{"es":{"title":"Instalación","body":"Pon el jar en la carpeta"}}',
    })

    const data = await body<{ title: string; body: string; locale: string }>(
      '/applications/openbattery/wiki/install?locale=es',
    )

    expect(data.title).toBe('Instalación')
    expect(data.body).toBe('Pon el jar en la carpeta')
    expect(data.locale).toBe('es')
  })
})
