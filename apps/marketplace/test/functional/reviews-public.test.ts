import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedProduct, seedRelease, seedReview } from '../helpers/db'

const call = (path: string) => SELF.fetch(`https://marketplace.test${path}`)

const read = async (path: string) =>
  (await (await call(path)).json()) as {
    data: {
      summary: { average: number | null; count: number; total: number }
      reviews: { id: string; rating: number; author: Record<string, unknown> }[]
      pagination: { limit: number; offset: number; total: number }
    }
  }

describe('GET /products/:slug/reviews', () => {
  beforeEach(clearDatabase)

  it('is a 404 for a product nobody announced', async () => {
    await seedProduct({ slug: 'unannounced', status: 'draft' })

    expect((await call('/products/unannounced/reviews')).status).toBe(404)
  })

  /**
   * The address is the *eligibility key* — `findActivePurchase` matches a manual cash sale by
   * address — and a review is a public document. The two must never be the same field in the same
   * response.
   */
  it('never serializes the reviewer\'s address', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedReview({ productId: product.id, email: 'private@example.com', authorName: 'Fran S.' })

    const payload = await read('/products/openbattery/reviews')

    expect(JSON.stringify(payload)).not.toContain('private@example.com')
    expect(payload.data.reviews[0]?.author).toMatchObject({ name: 'Fran S.' })
  })

  it('sorts newest first by default, and by rating on request', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedReview({ productId: product.id, rating: 1, createdAt: new Date('2026-01-01') })
    await seedReview({ productId: product.id, rating: 5, createdAt: new Date('2026-02-01') })

    expect((await read('/products/openbattery/reviews')).data.reviews.map((row) => row.rating)).toEqual([5, 1])
    expect(
      (await read('/products/openbattery/reviews?sort=rating_asc')).data.reviews.map((row) => row.rating),
    ).toEqual([1, 5])
  })

  it('narrows to one release when asked', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({ productId: product.id, version: '2.0.0' })
    await seedReview({ productId: product.id, releaseId: release.id, rating: 5 })
    await seedReview({ productId: product.id, rating: 1 })

    const payload = await read(`/products/openbattery/reviews?release_id=${release.id}`)

    expect(payload.data.reviews).toHaveLength(1)
    expect(payload.data.reviews[0]?.rating).toBe(5)
  })

  it('paginates against the all-time total, not the counted one', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    for (let index = 0; index < 3; index += 1) {
      await seedReview({ productId: product.id, rating: 4 })
    }

    const payload = await read('/products/openbattery/reviews?limit=2')

    expect(payload.data.reviews).toHaveLength(2)
    expect(payload.data.pagination).toMatchObject({ limit: 2, offset: 0, total: 3 })
  })

  /**
   * Not cached, unlike every other public read here. A review published a second ago has to appear,
   * and sixty seconds of staleness on the one surface a person watches after writing is the wrong
   * trade.
   */
  it('is not cached', async () => {
    await seedProduct({ slug: 'openbattery' })

    expect((await call('/products/openbattery/reviews')).headers.get('Cache-Control')).toBe('no-store')
  })
})
