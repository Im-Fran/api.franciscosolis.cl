import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

type RootPayload = {
  code: number
  data: {
    message: string
    tabs: { key: string; name: string; description: string; source: string }[]
    link_kinds: string[]
    locales: string[]
    default_locale: string
  }
}

describe('GET /', () => {
  it('reports the service is up', async () => {
    const response = await SELF.fetch('https://marketplace.test/')
    const { code, data } = await response.json<RootPayload>()

    expect(response.status).toBe(200)
    expect(code).toBe(200)
    expect(data.message).toBe('Hello, Marketplace!')
  })

  /**
   * The point of advertising these is that an editorial front-end builds its tab picker and its
   * link-kind dropdown from the service instead of from a list of its own that drifts the day a tab
   * is added here.
   */
  it('advertises the tabs a page can be built from, with their descriptions', async () => {
    const { data } = await (await SELF.fetch('https://marketplace.test/')).json<RootPayload>()

    expect(data.tabs.map((tab) => tab.key)).toEqual(['overview', 'releases', 'wiki', 'reviews', 'contact'])
    for (const tab of data.tabs) {
      expect(tab.name.length).toBeGreaterThan(0)
      expect(tab.description.length).toBeGreaterThan(0)
      expect(['field', 'collection']).toContain(tab.source)
    }
  })

  it('advertises the link kinds and the locales it publishes in', async () => {
    const { data } = await (await SELF.fetch('https://marketplace.test/')).json<RootPayload>()

    expect(data.link_kinds).toContain('github')
    expect(data.link_kinds).toContain('play_store')
    expect(data.locales).toEqual(['en', 'es'])
    expect(data.default_locale).toBe('en')
  })

  it('sends JSON with an explicit charset, so accented copy survives the trip', async () => {
    const response = await SELF.fetch('https://marketplace.test/')

    expect(response.headers.get('Content-Type')).toBe('application/json; charset=UTF-8')
  })

  /** Everything that is not an explicitly public read must stay out of any shared cache. */
  it('defaults to no-store', async () => {
    const response = await SELF.fetch('https://marketplace.test/')

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /openapi.json', () => {
  it('describes the service, and does not document itself', async () => {
    const response = await SELF.fetch('https://marketplace.test/openapi.json')
    const document = await response.json<{ info: { title: string }; paths: Record<string, unknown> }>()

    expect(response.status).toBe(200)
    expect(document.info.title).toBe('FranciscoSolis - Marketplace API')
    expect(Object.keys(document.paths)).toContain('/products/{slug}')
    expect(document.paths).not.toHaveProperty(['/openapi.json'])
  })
})
