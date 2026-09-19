import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearDatabase,
  seedCompatibility,
  seedProduct,
  seedPurchase,
  seedRelease,
  seedReview,
} from '../helpers/db'

const call = (path: string) => SELF.fetch(`https://marketplace.test${path}`)

type Overview = {
  product: { name: string; category: { key: string; name: string } | null }
  pricing: { mode: string }
  stats: {
    download_count: number
    purchase_count: number | null
    view_count: number
    first_released_at: string | null
    last_released_at: string | null
  }
  rating: { average: number | null; count: number; reset_at: string | null }
  latest_version: {
    version: string
    channel: string
    released_at: string | null
    download_count: number
    purchase_count: number | null
    rating: { average: number | null; count: number }
    compatibility: { kind: string; name: string; constraint: string | null }[]
  } | null
  channels: Record<string, number>
}

const overview = async (slug = 'openbattery'): Promise<Overview> =>
  ((await (await call(`/products/${slug}/overview`)).json()) as { data: Overview }).data

describe('GET /products/:slug/overview', () => {
  beforeEach(clearDatabase)

  it('is a 404 for a product nobody announced', async () => {
    await seedProduct({ slug: 'unannounced', status: 'draft' })

    expect((await call('/products/unannounced/overview')).status).toBe(404)
  })

  it('is cacheable: it is the same panel for every visitor', async () => {
    await seedProduct({ slug: 'openbattery' })

    expect((await call('/products/openbattery/overview')).headers.get('Cache-Control')).toMatch(
      /^public, max-age=\d+$/,
    )
  })

  it('carries everything the panel needs in one request', async () => {
    const product = await seedProduct({
      slug: 'openbattery',
      name: 'OpenBattery',
      category: 'library',
      pricingMode: 'paid',
      priceAmount: 4990,
      downloadCount: 2954,
      viewCount: 41203,
    })
    const first = await seedRelease({
      productId: product.id,
      version: '1.0.0',
      releasedAt: new Date('2020-04-07T00:00:00Z'),
      publishedAt: new Date('2020-04-07T00:00:00Z'),
    })
    const latest = await seedRelease({
      productId: product.id,
      version: '5.3.1',
      releasedAt: new Date('2021-11-28T00:00:00Z'),
      publishedAt: new Date('2021-11-28T00:00:00Z'),
      downloadCount: 214,
    })
    await seedCompatibility({
      productId: product.id,
      releaseId: latest.id,
      kind: 'runtime',
      name: 'Java',
      constraintText: '17+',
    })
    await seedReview({ productId: product.id, rating: 4 })
    await seedReview({ productId: product.id, rating: 4 })
    await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      approvedAt: new Date('2021-12-01T00:00:00Z'),
    })

    const panel = await overview()

    expect(panel.product).toMatchObject({ name: 'OpenBattery', category: { key: 'library' } })
    expect(panel.stats).toMatchObject({
      download_count: 2954,
      view_count: 41203,
      purchase_count: 1,
      first_released_at: '2020-04-07T00:00:00.000Z',
      last_released_at: '2021-11-28T00:00:00.000Z',
    })
    expect(panel.rating).toMatchObject({ average: 4, count: 2 })
    expect(panel.latest_version).toMatchObject({
      version: '5.3.1',
      channel: 'release',
      download_count: 214,
      purchase_count: 1,
    })
    expect(panel.latest_version?.compatibility).toEqual([
      expect.objectContaining({ kind: 'runtime', name: 'Java', constraint: '17+' }),
    ])
    void first
  })

  it('has no latest version when the product has published none', async () => {
    await seedProduct({ slug: 'openbattery' })

    const panel = await overview()

    expect(panel.latest_version).toBeNull()
    expect(panel.stats.first_released_at).toBeNull()
  })

  /**
   * A product whose sidebar advertised last night's build as its current version would be telling
   * every visitor to install something nobody has finished.
   */
  it('names the latest stable release, never a newer nightly', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({
      productId: product.id,
      version: '2.6.4',
      channel: 'release',
      releasedAt: new Date('2026-01-10T00:00:00Z'),
    })
    await seedRelease({
      productId: product.id,
      version: '3.0.0-nightly',
      channel: 'nightly',
      releasedAt: new Date('2026-02-10T00:00:00Z'),
    })

    expect((await overview()).latest_version?.version).toBe('2.6.4')
  })

  /** Compatibility comes from the release being named, which is what makes it per-version. */
  it('shows the latest release\'s requirements, not an older release\'s', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const old = await seedRelease({
      productId: product.id,
      version: '1.0.0',
      releasedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const now = await seedRelease({
      productId: product.id,
      version: '2.0.0',
      releasedAt: new Date('2026-06-01T00:00:00Z'),
    })
    await seedCompatibility({ productId: product.id, releaseId: old.id, name: 'macOS', constraintText: '>= 12.0' })
    await seedCompatibility({ productId: product.id, releaseId: now.id, name: 'macOS', constraintText: '>= 15.0' })

    expect((await overview()).latest_version?.compatibility[0]?.constraint).toBe('>= 15.0')
  })

  it('counts published releases per channel, every channel present at zero', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '1.0.0', channel: 'release' })
    await seedRelease({ productId: product.id, version: '2.0.0-beta', channel: 'beta' })
    await seedRelease({ productId: product.id, version: '2.0.0-draft', channel: 'beta', status: 'draft' })

    expect((await overview()).channels).toEqual({ nightly: 0, beta: 1, rc: 0, release: 1 })
  })

  /** "0 purchases" on a free product is a number nobody asked about. */
  it('leaves the purchase count out of a product that never took a payment', async () => {
    const product = await seedProduct({ slug: 'openbattery', pricingMode: 'free' })
    await seedRelease({ productId: product.id, version: '1.0.0' })

    const panel = await overview()

    expect(panel.stats.purchase_count).toBeNull()
    expect(panel.latest_version?.purchase_count).toBeNull()
  })

  it('reports the rating window the same way the Reviews tab does', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({
      productId: product.id,
      version: '2.0.0',
      resetsRating: true,
      publishedAt: new Date('2026-06-01T00:00:00Z'),
    })
    await seedReview({ productId: product.id, rating: 1, anchoredAt: new Date('2026-01-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 5, anchoredAt: new Date('2026-07-01T00:00:00Z') })

    expect((await overview()).rating).toMatchObject({
      average: 5,
      count: 1,
      reset_at: '2026-06-01T00:00:00.000Z',
    })
  })

  it('answers a null average rather than zero stars for something nobody reviewed', async () => {
    await seedProduct({ slug: 'openbattery' })

    expect((await overview()).rating.average).toBeNull()
  })
})
