import { SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedEntry, seedLegalPage } from '../helpers/db'
import { asEditor } from '../helpers/tokens'

/**
 * Covers the bilingual half of the public API: `?locale` on every read, and the `translations` map
 * the admin routes write. The rules being pinned are the ones a website depends on and cannot see
 * from the outside — that a locale nobody translated falls back instead of 404-ing, that the
 * response says which text it actually got, and that a fallback is never cached as the translation.
 */

type LocalizedEntry = {
  slug: string
  title: string
  subtitle: string | null
  summary: string | null
  body: string | null
  locale: string
  available_locales: string[]
  translations?: Record<string, Record<string, string>>
}

const get = (path: string, headers?: Record<string, string>) =>
  SELF.fetch(`https://cms.internal${path}`, headers ? { headers } : undefined)

const one = async (path: string) => {
  const response = await get(path)
  const body = await response.json<{ data: LocalizedEntry }>()
  return { status: response.status, entry: body.data, response }
}

let headers: Record<string, string>

beforeAll(async () => {
  headers = await asEditor()
})

beforeEach(clearDatabase)

const seedBilingualProject = () =>
  seedEntry({
    collection: 'projects',
    slug: 'gateway',
    title: 'API gateway',
    subtitle: 'Web App',
    summary: 'Routing at the edge',
    body: '# Gateway',
    status: 'published',
    translations: JSON.stringify({ es: { title: 'Puerta de enlace', summary: 'Enrutado en el borde' } }),
  })

describe('GET /content/:collection?locale', () => {
  it('serves the default locale when none is asked for', async () => {
    await seedBilingualProject()

    const { entry } = await one('/content/projects/gateway')

    expect(entry.title).toBe('API gateway')
    expect(entry.locale).toBe('en')
    expect(entry.available_locales).toEqual(['en', 'es'])
  })

  it('serves the translated fields and falls back on the ones nobody translated', async () => {
    await seedBilingualProject()

    const { entry } = await one('/content/projects/gateway?locale=es')

    expect(entry.title).toBe('Puerta de enlace')
    expect(entry.summary).toBe('Enrutado en el borde')
    // Untranslated. A half-translated entry renders rather than showing an empty heading — which
    // is the right failure for a site whose editor translates as they go.
    expect(entry.subtitle).toBe('Web App')
    expect(entry.body).toBe('# Gateway')
    expect(entry.locale).toBe('es')
  })

  it('reports the default locale when the entry has no translation at all', async () => {
    await seedEntry({ collection: 'projects', slug: 'plain', title: 'Plain', status: 'published' })

    const { entry } = await one('/content/projects/plain?locale=es')

    expect(entry.title).toBe('Plain')
    // Said plainly rather than left for the caller to infer from the text looking English.
    expect(entry.locale).toBe('en')
    expect(entry.available_locales).toEqual(['en'])
  })

  it('translates a listing too', async () => {
    await seedBilingualProject()

    const response = await get('/content/projects?locale=es')
    const body = await response.json<{ data: LocalizedEntry[] }>()

    expect(body.data.map((entry) => entry.title)).toEqual(['Puerta de enlace'])
  })

  it('refuses a language it does not publish rather than quietly serving English', async () => {
    await seedBilingualProject()

    expect((await get('/content/projects?locale=fr')).status).toBe(400)
    expect((await get('/content/projects/gateway?locale=fr')).status).toBe(400)
  })

  it('keeps the locale in the URL, so a shared cache cannot serve one language for another', async () => {
    await seedBilingualProject()

    // The reason `?locale` is a query parameter and not `Accept-Language`: these responses are
    // publicly cacheable, and a header-chosen language needs a `Vary` nobody can forget.
    const spanish = await get('/content/projects/gateway?locale=es')
    expect(spanish.headers.get('Cache-Control')).toBe('public, max-age=60')

    const withHeader = await get('/content/projects/gateway', { 'Accept-Language': 'es-CL' })
    expect((await withHeader.json<{ data: LocalizedEntry }>()).data.title).toBe('API gateway')
  })
})

describe('GET /legal?locale', () => {
  const seedBilingualPage = () =>
    seedLegalPage({
      slug: 'terms-of-service',
      title: 'Terms of Service',
      summary: 'The terms',
      body: '# Terms',
      status: 'published',
      translations: JSON.stringify({
        es: { title: 'Términos de Servicio', summary: 'Los términos', body: '# Términos' },
      }),
    })

  it('translates the listing, bodies excluded', async () => {
    await seedBilingualPage()

    const response = await get('/legal?locale=es')
    const body = await response.json<{ data: LocalizedEntry[] }>()

    expect(body.data[0]).toMatchObject({ title: 'Términos de Servicio', locale: 'es' })
    expect(body.data[0]).not.toHaveProperty('body')
  })

  it('translates a single page, body included', async () => {
    await seedBilingualPage()

    const { entry } = await one('/legal/terms-of-service?locale=es')

    expect(entry.body).toBe('# Términos')
    expect(entry.locale).toBe('es')
  })

  it('serves an untranslated policy rather than 404-ing a page the footer links to', async () => {
    await seedLegalPage({ slug: 'cookies', title: 'Cookies', body: '# Cookies', status: 'published' })

    const { status, entry } = await one('/legal/cookies?locale=es')

    expect(status).toBe(200)
    expect(entry.body).toBe('# Cookies')
    // What lets the website label the document as untranslated instead of implying it is not one.
    expect(entry.locale).toBe('en')
  })
})

describe('the admin API', () => {
  const post = (path: string, json: unknown) =>
    SELF.fetch(`https://cms.internal${path}`, { method: 'POST', headers, body: JSON.stringify(json) })

  const patch = (path: string, json: unknown) =>
    SELF.fetch(`https://cms.internal${path}`, { method: 'PATCH', headers, body: JSON.stringify(json) })

  it('stores a translation on create and hands it back to the editor', async () => {
    const response = await post('/admin/content/projects', {
      title: 'API gateway',
      status: 'published',
      translations: { es: { title: 'Puerta de enlace' } },
    })
    const created = (await response.json<{ data: LocalizedEntry }>()).data

    expect(response.status).toBe(201)
    // The editorial shape is always the source text plus the raw map: a localized `title` here is
    // an editor saving the Spanish back over the English row.
    expect(created.title).toBe('API gateway')
    expect(created.translations).toEqual({ es: { title: 'Puerta de enlace' } })

    const { entry } = await one('/content/projects/api-gateway?locale=es')
    expect(entry.title).toBe('Puerta de enlace')
  })

  it('replaces the map wholesale on PATCH, the way `data` is replaced', async () => {
    const created = (
      await (
        await post('/admin/content/projects', {
          title: 'API gateway',
          translations: { es: { title: 'Puerta de enlace', summary: 'Enrutado' } },
        })
      ).json<{ data: LocalizedEntry & { id: string } }>()
    ).data

    const updated = (
      await (
        await patch(`/admin/content/projects/${created.id}`, { translations: { es: { title: 'Pasarela' } } })
      ).json<{ data: LocalizedEntry }>()
    ).data

    expect(updated.translations).toEqual({ es: { title: 'Pasarela' } })
  })

  it('leaves the map alone when PATCH does not mention it', async () => {
    const created = (
      await (
        await post('/admin/content/projects', {
          title: 'API gateway',
          translations: { es: { title: 'Puerta de enlace' } },
        })
      ).json<{ data: LocalizedEntry & { id: string } }>()
    ).data

    const updated = (
      await (await patch(`/admin/content/projects/${created.id}`, { summary: 'Now with a summary' })).json<{
        data: LocalizedEntry
      }>()
    ).data

    expect(updated.translations).toEqual({ es: { title: 'Puerta de enlace' } })
  })

  it('rejects a misspelled field instead of storing a translation that never renders', async () => {
    const response = await post('/admin/content/projects', {
      title: 'API gateway',
      translations: { es: { titel: 'Puerta de enlace' } },
    })

    expect(response.status).toBe(400)
  })

  it('rejects the default locale, which lives in the row itself', async () => {
    const response = await post('/admin/content/projects', {
      title: 'API gateway',
      translations: { en: { title: 'Shadow title' } },
    })

    expect(response.status).toBe(400)
  })

  it('drops a locale an editor emptied, so no language is advertised without text behind it', async () => {
    const created = (
      await (
        await post('/admin/content/projects', {
          title: 'API gateway',
          status: 'published',
          translations: { es: { title: 'Puerta de enlace' } },
        })
      ).json<{ data: LocalizedEntry & { id: string } }>()
    ).data

    await patch(`/admin/content/projects/${created.id}`, { translations: { es: { title: null } } })

    const { entry } = await one('/content/projects/api-gateway?locale=es')
    expect(entry.available_locales).toEqual(['en'])
    expect(entry.locale).toBe('en')
  })

  it('carries translations on a legal page as well', async () => {
    const response = await post('/admin/legal', {
      title: 'Terms of Service',
      body: '# Terms',
      status: 'published',
      translations: { es: { title: 'Términos de Servicio', body: '# Términos' } },
    })
    expect(response.status).toBe(201)

    const { entry } = await one('/legal/terms-of-service?locale=es')
    expect(entry.title).toBe('Términos de Servicio')
    expect(entry.body).toBe('# Términos')
  })
})
