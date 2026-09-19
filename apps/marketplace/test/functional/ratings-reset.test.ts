import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, db, productReleases, seedProduct, seedRelease, seedReview } from '../helpers/db'
import { eq } from 'drizzle-orm'

const call = (path: string) => SELF.fetch(`https://marketplace.test${path}`)

type Summary = {
  average: number | null
  count: number
  total: number
  reset_at: string | null
  distribution: Record<string, number>
}

const summary = async (slug = 'openbattery'): Promise<Summary> =>
  ((await (await call(`/products/${slug}/reviews`)).json()) as { data: { summary: Summary } }).data.summary

const reviews = async (slug = 'openbattery') =>
  ((await (await call(`/products/${slug}/reviews`)).json()) as {
    data: { reviews: { rating: number; counts_toward_rating: boolean }[] }
  }).data.reviews

const at = (iso: string) => new Date(iso)

/**
 * The App Store rule: publishing a release marked `resets_rating` restarts the average, and deletes
 * nothing. Everything below is that one sentence taken apart.
 */
describe('the rating window', () => {
  beforeEach(clearDatabase)

  it('counts every review when no resetting release was ever published', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedReview({ productId: product.id, rating: 5, anchoredAt: at('2026-01-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 3, anchoredAt: at('2026-02-01T00:00:00Z') })

    expect(await summary()).toMatchObject({ average: 4, count: 2, total: 2, reset_at: null })
  })

  it('counts only the reviews anchored at or after the reset, and keeps the rest readable', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({
      productId: product.id,
      version: '2.0.0',
      resetsRating: true,
      publishedAt: at('2026-06-01T00:00:00Z'),
    })
    // Two one-star reviews of the old product, and two five-star reviews of the new one.
    await seedReview({ productId: product.id, rating: 1, anchoredAt: at('2026-01-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 1, anchoredAt: at('2026-03-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 5, anchoredAt: at('2026-06-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 5, anchoredAt: at('2026-07-01T00:00:00Z') })

    const result = await summary()

    expect(result).toMatchObject({ average: 5, count: 2, total: 4 })
    expect(result.reset_at).toBe('2026-06-01T00:00:00.000Z')
    // Nothing was deleted: all four are still there, and each says which side of the line it is on.
    const rows = await reviews()
    expect(rows).toHaveLength(4)
    expect(rows.filter((row) => row.counts_toward_rating)).toHaveLength(2)
  })

  it('takes the latest reset when a product has had two', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '2.0.0', resetsRating: true, publishedAt: at('2026-03-01T00:00:00Z') })
    await seedRelease({ productId: product.id, version: '3.0.0', resetsRating: true, publishedAt: at('2026-09-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 1, anchoredAt: at('2026-04-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 4, anchoredAt: at('2026-10-01T00:00:00Z') })

    expect(await summary()).toMatchObject({ average: 4, count: 1, total: 2, reset_at: '2026-09-01T00:00:00.000Z' })
  })

  /** A reset is what *publishing* does. A release nobody has announced has reset nothing. */
  it('ignores a resetting release that is still a draft', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({
      productId: product.id,
      version: '2.0.0',
      resetsRating: true,
      status: 'draft',
      publishedAt: null,
    })
    await seedReview({ productId: product.id, rating: 1, anchoredAt: at('2026-01-01T00:00:00Z') })

    expect(await summary()).toMatchObject({ average: 1, count: 1, reset_at: null })
  })

  /**
   * `published_at` is stamped once and kept through unpublish/republish, so a release that was
   * taken down and put back does not move the window.
   */
  it('keeps the original publication date through an unpublish and republish', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const release = await seedRelease({
      productId: product.id,
      version: '2.0.0',
      resetsRating: true,
      publishedAt: at('2026-06-01T00:00:00Z'),
    })
    await seedReview({ productId: product.id, rating: 5, anchoredAt: at('2026-06-02T00:00:00Z') })

    // What an unpublish and republish leaves behind: a new `updated_at`, the same `published_at`.
    await db()
      .update(productReleases)
      .set({ updatedAt: new Date() })
      .where(eq(productReleases.id, release.id))

    expect((await summary()).reset_at).toBe('2026-06-01T00:00:00.000Z')
  })

  /**
   * `anchored_at` is a snapshot rather than a join, and this is the case that proves why: the
   * anchor release is gone, `release_id` went null with it, and the review still knows which side
   * of the window it belongs to.
   */
  it('keeps a review in the window after its anchor release is deleted', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '2.0.0', resetsRating: true, publishedAt: at('2026-06-01T00:00:00Z') })
    const anchor = await seedRelease({ productId: product.id, version: '2.1.0', publishedAt: at('2026-07-01T00:00:00Z') })
    await seedReview({
      productId: product.id,
      releaseId: anchor.id,
      rating: 5,
      anchoredAt: at('2026-07-01T00:00:00Z'),
    })

    await db().delete(productReleases).where(eq(productReleases.id, anchor.id))

    const result = await summary()
    expect(result).toMatchObject({ average: 5, count: 1 })
    expect((await reviews())[0]).toMatchObject({ counts_toward_rating: true, release: null })
  })

  it('leaves a hidden review out of both the average and the listing', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedReview({ productId: product.id, rating: 5 })
    await seedReview({ productId: product.id, rating: 1, status: 'hidden' })

    expect(await summary()).toMatchObject({ average: 5, count: 1, total: 1 })
    expect(await reviews()).toHaveLength(1)
  })

  /**
   * `AVG()` over an empty set answers NULL, and that has to survive all the way out: a product
   * serializing `average: 0` would render as a one-star product on every listing card.
   */
  it('answers null rather than zero for a product nobody has reviewed', async () => {
    await seedProduct({ slug: 'openbattery' })

    const result = await summary()

    expect(result.average).toBeNull()
    expect(result.count).toBe(0)
  })

  it('answers null rather than zero when a reset left nothing inside the window', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '2.0.0', resetsRating: true, publishedAt: at('2026-06-01T00:00:00Z') })
    await seedReview({ productId: product.id, rating: 1, anchoredAt: at('2026-01-01T00:00:00Z') })

    const result = await summary()

    expect(result.average).toBeNull()
    expect(result).toMatchObject({ count: 0, total: 1 })
  })

  it('reports the full star histogram, zeros included', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedReview({ productId: product.id, rating: 5 })
    await seedReview({ productId: product.id, rating: 5 })
    await seedReview({ productId: product.id, rating: 2 })

    expect((await summary()).distribution).toEqual({ '1': 0, '2': 1, '3': 0, '4': 0, '5': 2 })
  })

  it('rounds to one decimal, because two would imply a precision three reviews do not have', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedReview({ productId: product.id, rating: 5 })
    await seedReview({ productId: product.id, rating: 4 })
    await seedReview({ productId: product.id, rating: 4 })

    expect((await summary()).average).toBe(4.3)
  })

  /** A reset says "the product changed". It says nothing about how good version 1.4.0 was. */
  it('does not move a release\'s own rating when the product\'s is reset', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    const old = await seedRelease({ productId: product.id, version: '1.0.0', publishedAt: at('2026-01-01T00:00:00Z') })
    await seedRelease({ productId: product.id, version: '2.0.0', resetsRating: true, publishedAt: at('2026-06-01T00:00:00Z') })
    await seedReview({ productId: product.id, releaseId: old.id, rating: 2, anchoredAt: at('2026-01-05T00:00:00Z') })

    // Outside the product's window…
    expect(await summary()).toMatchObject({ count: 0, average: null })
    // …but still the rating of the version it was written about.
    const { data } = (await (await call(`/products/openbattery/reviews?release_id=${old.id}`)).json()) as {
      data: { reviews: unknown[] }
    }
    expect(data.reviews).toHaveLength(1)
  })
})
