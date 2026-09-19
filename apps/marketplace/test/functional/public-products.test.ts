import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedProduct, seedRelease, seedWikiPage } from '../helpers/db'

const get = (path: string) => SELF.fetch(`https://marketplace.test${path}`)
const body = async <T>(path: string): Promise<T> => ((await (await get(path)).json()) as { data: T }).data

describe('GET /products', () => {
  beforeEach(clearDatabase)

  it('lists published products in the order an editor arranged them', async () => {
    await seedProduct({ slug: 'second', name: 'Second', position: 1 })
    await seedProduct({ slug: 'first', name: 'First', position: 0 })

    const data = await body<{ slug: string }[]>('/products')

    expect(data.map((row) => row.slug)).toEqual(['first', 'second'])
  })

  it.each(['draft', 'archived'])('never shows a %s product', async (status) => {
    await seedProduct({ slug: 'hidden', status })

    expect(await body<unknown[]>('/products')).toEqual([])
  })

  /**
   * The two tab bodies are Markdown documents capped at 200 kB apiece. A listing of twenty
   * products carrying both is megabytes of text nobody on that screen reads.
   */
  it('leaves the tab bodies out of the listing', async () => {
    await seedProduct({ slug: 'openbattery', overviewBody: '# Long document', contactBody: 'Reach us' })

    const [row] = await body<Record<string, unknown>[]>('/products')

    expect(row).not.toHaveProperty('overview_body')
    expect(row).not.toHaveProperty('contact_body')
    expect(row.slug).toBe('openbattery')
  })

  it('filters on featured', async () => {
    await seedProduct({ slug: 'pinned', featured: true })
    await seedProduct({ slug: 'ordinary', featured: false })

    expect((await body<{ slug: string }[]>('/products?featured=true')).map((row) => row.slug)).toEqual(['pinned'])
  })

  it('searches the name, the tagline and the slug', async () => {
    await seedProduct({ slug: 'openbattery', name: 'OpenBattery', tagline: 'Telemetry for packs' })
    await seedProduct({ slug: 'other', name: 'Something else', tagline: null })

    expect((await body<{ slug: string }[]>('/products?search=telemetry')).map((row) => row.slug)).toEqual([
      'openbattery',
    ])
  })

  it('is cacheable, unlike everything else this Worker answers', async () => {
    const response = await get('/products')

    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/)
  })
})

describe('GET /products/:slug', () => {
  beforeEach(clearDatabase)

  it('answers with the page, its tabs, its links and its Markdown', async () => {
    await seedProduct({
      slug: 'openbattery',
      name: 'OpenBattery',
      tagline: 'Battery telemetry that is actually open',
      tabs: '["overview","releases","wiki","contact"]',
      links: '[{"kind":"github","url":"https://github.com/example/openbattery","label":"Source"}]',
      overviewBody: '# OpenBattery',
      contactBody: 'Open an issue.',
      accentColor: '#A855F7',
      bannerImageUrl: 'https://cdn.example.com/banner.png',
    })

    const data = await body<Record<string, unknown>>('/products/openbattery')

    expect(data.name).toBe('OpenBattery')
    expect(data.tabs).toEqual(['overview', 'releases', 'wiki', 'contact'])
    expect(data.links).toEqual([
      { kind: 'github', url: 'https://github.com/example/openbattery', label: 'Source' },
    ])
    expect(data.overview_body).toBe('# OpenBattery')
    expect(data.contact_body).toBe('Open an issue.')
    expect(data.accent_color).toBe('#A855F7')
    expect(data.banner_image_url).toBe('https://cdn.example.com/banner.png')
  })

  /** A draft answers 404 rather than 403: a 403 would confirm the slug of an unannounced page. */
  it.each(['draft', 'archived'])('answers 404 for a %s product rather than admitting it exists', async (status) => {
    await seedProduct({ slug: 'unannounced', status })

    expect((await get('/products/unannounced')).status).toBe(404)
  })

  it('answers 404 for a slug nobody took', async () => {
    expect((await get('/products/nope')).status).toBe(404)
  })
})

describe('?locale on a public read', () => {
  beforeEach(clearDatabase)

  it('resolves the overrides server-side, so the caller reads plain fields', async () => {
    await seedProduct({
      slug: 'openbattery',
      name: 'OpenBattery',
      tagline: 'Battery telemetry',
      translations: '{"es":{"name":"Batería Abierta"}}',
    })

    const data = await body<Record<string, unknown>>('/products/openbattery?locale=es')

    expect(data.name).toBe('Batería Abierta')
    // Untranslated, so it falls back rather than rendering empty.
    expect(data.tagline).toBe('Battery telemetry')
    expect(data.locale).toBe('es')
    expect(data.available_locales).toEqual(['en', 'es'])
  })

  it('says which locale actually came back when the one asked for is untranslated', async () => {
    await seedProduct({ slug: 'openbattery', translations: '{}' })

    const data = await body<Record<string, unknown>>('/products/openbattery?locale=es')

    expect(data.locale).toBe('en')
    expect(data.available_locales).toEqual(['en'])
  })

  it('refuses a locale the service does not publish, rather than serving a silent fallback', async () => {
    await seedProduct({ slug: 'openbattery' })

    expect((await get('/products/openbattery?locale=fr')).status).toBe(400)
  })
})

describe('GET /products/:slug/releases', () => {
  beforeEach(clearDatabase)

  const day = (iso: string) => new Date(iso)

  it('orders by the day the version shipped, not by when the entry was written', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    // Written in this order; released in the opposite one.
    await seedRelease({ productId: app.id, version: '1.0.0', releasedAt: day('2025-01-01T00:00:00Z') })
    await seedRelease({ productId: app.id, version: '2.0.0', releasedAt: day('2026-01-01T00:00:00Z') })

    const data = await body<{ version: string }[]>('/products/openbattery/releases')

    expect(data.map((row) => row.version)).toEqual(['2.0.0', '1.0.0'])
  })

  it.each(['draft', 'archived'])('never shows a %s release', async (status) => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: app.id, version: '1.0.0', status })

    expect(await body<unknown[]>('/products/openbattery/releases')).toEqual([])
  })

  /** A draft product hides everything behind its tabs, not just its own row. */
  it('answers 404 for the updates of an unpublished product', async () => {
    await seedProduct({ slug: 'unannounced', status: 'draft' })

    expect((await get('/products/unannounced/releases')).status).toBe(404)
  })

  it('carries the release links', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedRelease({
      productId: app.id,
      version: '2.6.4',
      links: '[{"kind":"play_store","url":"https://play.google.com/store/apps/details?id=x","label":null}]',
    })

    const [row] = await body<{ links: unknown[] }[]>('/products/openbattery/releases')

    expect(row.links).toEqual([
      { kind: 'play_store', url: 'https://play.google.com/store/apps/details?id=x', label: null },
    ])
  })
})

describe('GET /products/:slug/releases/:channel/:version', () => {
  beforeEach(clearDatabase)

  it('addresses a release by its version label', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: app.id, version: '2.6.4', title: 'Full 1.21.11 support' })

    const data = await body<{ title: string }>('/products/openbattery/releases/release/2.6.4')

    expect(data.title).toBe('Full 1.21.11 support')
  })

  it('answers 404 for a draft release', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: app.id, version: '3.0.0', status: 'draft' })

    expect((await get('/products/openbattery/releases/release/3.0.0')).status).toBe(404)
  })

  /** Scoped by product: a version belonging to another page must not resolve through this one. */
  it('does not reach a release of a different product', async () => {
    const mine = await seedProduct({ slug: 'mine' })
    const theirs = await seedProduct({ slug: 'theirs' })
    await seedRelease({ productId: theirs.id, version: '9.9.9' })
    await seedRelease({ productId: mine.id, version: '1.0.0' })

    expect((await get('/products/mine/releases/release/9.9.9')).status).toBe(404)
  })
})

describe('GET /products/:slug/wiki', () => {
  beforeEach(clearDatabase)

  it('answers with the sidebar as a tree, without bodies', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    const section = await seedWikiPage({ productId: app.id, slug: 'overview', title: 'Overview', position: 0 })
    await seedWikiPage({ productId: app.id, slug: 'commands', title: 'Commands', parentId: section.id, position: 1 })
    await seedWikiPage({ productId: app.id, slug: 'install', title: 'Installation', position: 2 })

    const tree = await body<{ slug: string; children: { slug: string }[] }[]>('/products/openbattery/wiki')

    expect(tree.map((node) => node.slug)).toEqual(['overview', 'install'])
    expect(tree[0]?.children.map((child) => child.slug)).toEqual(['commands'])
    expect(tree[0]).not.toHaveProperty('body')
  })

  it('keeps a published page whose section is still a draft, at the top level', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    const draftSection = await seedWikiPage({ productId: app.id, slug: 'secret', status: 'draft' })
    await seedWikiPage({ productId: app.id, slug: 'commands', parentId: draftSection.id })

    const tree = await body<{ slug: string }[]>('/products/openbattery/wiki')

    expect(tree.map((node) => node.slug)).toEqual(['commands'])
  })
})

describe('GET /products/:slug/wiki/:page', () => {
  beforeEach(clearDatabase)

  it('answers with the page and its Markdown body', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedWikiPage({ productId: app.id, slug: 'install', title: 'Installation', body: '## Drop the jar in' })

    const data = await body<{ title: string; body: string }>('/products/openbattery/wiki/install')

    expect(data.title).toBe('Installation')
    expect(data.body).toBe('## Drop the jar in')
  })

  it('answers 404 for a draft page', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedWikiPage({ productId: app.id, slug: 'wip', status: 'draft' })

    expect((await get('/products/openbattery/wiki/wip')).status).toBe(404)
  })

  it('does not reach a page of a different product', async () => {
    const mine = await seedProduct({ slug: 'mine' })
    const theirs = await seedProduct({ slug: 'theirs' })
    await seedWikiPage({ productId: theirs.id, slug: 'secrets' })
    await seedWikiPage({ productId: mine.id, slug: 'install' })

    expect((await get('/products/mine/wiki/secrets')).status).toBe(404)
  })

  it('serves the translated body when one exists', async () => {
    const app = await seedProduct({ slug: 'openbattery' })
    await seedWikiPage({
      productId: app.id,
      slug: 'install',
      title: 'Installation',
      body: 'Drop the jar in',
      translations: '{"es":{"title":"Instalación","body":"Pon el jar en la carpeta"}}',
    })

    const data = await body<{ title: string; body: string; locale: string }>(
      '/products/openbattery/wiki/install?locale=es',
    )

    expect(data.title).toBe('Instalación')
    expect(data.body).toBe('Pon el jar en la carpeta')
    expect(data.locale).toBe('es')
  })
})
