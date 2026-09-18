import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { allRows, clearDatabase, countRows, firstRow } from '../helpers/db'
import { asAgent } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://support.test${path}`, init)

const createArticle = async (overrides: Record<string, unknown> = {}) => {
  const response = await call('/admin/help/articles', {
    method: 'POST',
    headers: await asAgent(),
    body: JSON.stringify({
      title: 'Why the sign-in link never arrives',
      summary: 'Check your spam folder and your mail provider.',
      body: '## Check spam\nMost providers file the first message from a new sender as spam.\n\n## Still nothing\nAsk us to resend it.',
      status: 'published',
      ...overrides,
    }),
  })
  return response
}

const search = async (query: string, extra = '') => {
  const response = await call(`/help/search?q=${encodeURIComponent(query)}${extra}`)
  return (await response.json()) as { data: Array<{ slug: string; title: string; snippet: string }>; meta: { fallback_locale: boolean } }
}

beforeEach(clearDatabase)

describe('editorial help content', () => {
  it('derives a slug and publishes', async () => {
    const response = await createArticle()
    expect(response.status).toBe(201)

    const body = (await response.json()) as { data: { slug: string; status: string; published_at: string | null } }
    expect(body.data.slug).toBe('why-the-sign-in-link-never-arrives')
    expect(body.data.status).toBe('published')
    expect(body.data.published_at).not.toBeNull()
  })

  it('refuses a duplicate slug', async () => {
    await createArticle()
    expect((await createArticle()).status).toBe(409)
  })

  it('refuses a title it cannot derive any slug from', async () => {
    expect((await createArticle({ title: '???' })).status).toBe(422)
  })

  it('leaves a section\'s articles standing when the section is deleted', async () => {
    const categoryResponse = await call('/admin/help/categories', {
      method: 'POST',
      headers: await asAgent(),
      body: JSON.stringify({ name: 'Signing in', status: 'published' }),
    })
    const category = (await categoryResponse.json()) as { data: { id: string } }
    await createArticle({ category_id: category.data.id })

    expect(
      (await call(`/admin/help/categories/${category.data.id}`, { method: 'DELETE', headers: await asAgent() })).status,
    ).toBe(204)

    // `ON DELETE SET NULL`, not cascade: deleting a section must not silently take its documentation.
    expect(await countRows('help_articles')).toBe(1)
    const article = await firstRow<{ category_id: string | null }>('SELECT category_id FROM help_articles')
    expect(article?.category_id).toBeNull()
  })
})

describe('public reads', () => {
  it('serves a published article and lets a shared cache keep it briefly', async () => {
    await createArticle()
    const response = await call('/help/articles/why-the-sign-in-link-never-arrives')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('answers a draft exactly like an article that does not exist', async () => {
    await createArticle({ status: 'draft' })

    const draft = await call('/help/articles/why-the-sign-in-link-never-arrives')
    const missing = await call('/help/articles/no-such-article')

    expect(draft.status).toBe(404)
    expect(await draft.text()).toBe(await missing.text())
  })

  it('resolves the requested language and says which one it served', async () => {
    await createArticle({
      translations: { es: { title: 'Por qué no llega el enlace de acceso', body: 'Revisa tu carpeta de spam.' } },
    })

    const spanish = await call('/help/articles/why-the-sign-in-link-never-arrives?locale=es')
    const body = (await spanish.json()) as { data: { title: string; locale: string; available_locales: string[]; summary: string } }

    expect(body.data.title).toBe('Por qué no llega el enlace de acceso')
    expect(body.data.locale).toBe('es')
    expect(body.data.available_locales).toEqual(['en', 'es'])
    // A field with no override falls back, so a half-translated article still renders.
    expect(body.data.summary).toBe('Check your spam folder and your mail provider.')
  })
})

describe('search', () => {
  it('finds an article by a word in its body', async () => {
    await createArticle()
    const results = await search('spam')

    expect(results.data).toHaveLength(1)
    expect(results.data[0]?.slug).toBe('why-the-sign-in-link-never-arrives')
    expect(results.data[0]?.snippet).toContain('<mark>')
  })

  it('matches a prefix, so a half-typed word still finds something', async () => {
    await createArticle()
    expect((await search('provid')).data).toHaveLength(1)
  })

  it('ignores accents in both directions', async () => {
    await createArticle({
      title: 'Facturación',
      summary: 'Sobre las facturas',
      body: 'Cómo descargar tu factura de facturación mensual.',
      slug: 'facturacion',
      translations: { es: { title: 'Facturación', body: 'Cómo descargar tu factura de facturación mensual.' } },
    })

    // `remove_diacritics 2` in the FTS5 declaration is the difference between this working and not.
    expect((await search('facturacion')).data.length).toBeGreaterThan(0)
    expect((await search('facturación')).data.length).toBeGreaterThan(0)
  })

  it.each([
    ['an unbalanced quote', 'it"s broken'],
    ['a bare operator', 'NOT'],
    ['punctuation only', '???'],
    ['C++', 'c++'],
  ])('answers %s without a 500', async (_label, query) => {
    await createArticle()
    const response = await call(`/help/search?q=${encodeURIComponent(query)}`)
    // Raw input reaching `MATCH` is a syntax error, and a syntax error from D1 arrives at onError as
    // a 500 with the query in the logs.
    expect(response.status).toBe(200)
  })

  it('drops an article out of the index when it is unpublished, and brings it back', async () => {
    const created = await createArticle()
    const { data } = (await created.json()) as { data: { id: string } }
    const headers = await asAgent()

    await call(`/admin/help/articles/${data.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'draft' }) })
    expect((await search('spam')).data).toHaveLength(0)

    await call(`/admin/help/articles/${data.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'published' }) })
    expect((await search('spam')).data).toHaveLength(1)
  })

  it('indexes one row per language an article actually has', async () => {
    await createArticle({ translations: { es: { title: 'Enlace de acceso', body: 'Revisa tu carpeta de spam.' } } })

    const rows = await allRows<{ locale: string }>('SELECT locale FROM help_search ORDER BY locale')
    expect(rows.map((row) => row.locale)).toEqual(['en', 'es'])
  })

  it('falls back to English rather than showing nothing', async () => {
    await createArticle()
    const results = await search('spam', '&locale=es')

    // A Spanish speaker finding the English article beats finding nothing, and the flag lets the
    // front-end say so.
    expect(results.data.length).toBeGreaterThan(0)
    expect(results.meta.fallback_locale).toBe(true)
  })

  it('logs a search that found little or nothing, and not one that answered itself', async () => {
    // Three articles, so a good query clears `HELP_SEARCH.logResultThreshold` and a bad one does not.
    await createArticle()
    await createArticle({ title: 'Spam filters and support mail', slug: 'spam-filters' })
    await createArticle({ title: 'What to do when spam swallows a reply', slug: 'spam-swallows' })

    await search('spam')
    await search('quantum entanglement refund policy')

    const logged = await allRows<{ term: string; result_count: number }>(
      'SELECT term, result_count FROM help_search_queries',
    )
    // The threshold is "two or fewer", not "zero": a query that scraped one weak match is just as
    // much a sign that nobody has written the article as one that found none. What is *not* worth a
    // write is a search that answered itself, which is most of them.
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ result_count: 0 })
    expect(logged[0]?.term).toContain('quantum')
  })

  it('removes an article from the index when it is deleted', async () => {
    const created = await createArticle()
    const { data } = (await created.json()) as { data: { id: string } }

    await call(`/admin/help/articles/${data.id}`, { method: 'DELETE', headers: await asAgent() })

    expect(await countRows('help_search')).toBe(0)
    expect((await search('spam')).data).toHaveLength(0)
  })
})

describe('feedback', () => {
  it('counts a thumbs up once per person per day', async () => {
    await createArticle()
    const post = () =>
      call('/help/articles/why-the-sign-in-link-never-arrives/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5', 'User-Agent': 'test' },
        body: JSON.stringify({ helpful: true }),
      })

    expect((await post()).status).toBe(204)
    expect((await post()).status).toBe(204)

    const article = await firstRow<{ helpful_yes: number }>('SELECT helpful_yes FROM help_articles')
    // A refresh must not inflate the count, and there is deliberately no view counter at all — that
    // would turn a cacheable read into a D1 write.
    expect(article?.helpful_yes).toBe(1)
  })
})
