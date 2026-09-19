import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearDatabase,
  seedDownloadEvent,
  seedProduct,
  seedPurchase,
  seedRelease,
} from '../helpers/db'
import { asBuyer } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

const asAccount = async (path: string, init: RequestInit = {}, overrides = {}) =>
  call(path, { ...init, headers: { ...(await asBuyer(overrides)), ...init.headers } })

type Eligibility = { can_review: boolean; reason: string | null; via: string | null; anchor: { version: string } | null }

const seedContext = async (overrides: Record<string, unknown> = {}) => {
  const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery', ...overrides })
  const release = await seedRelease({ productId: product.id, version: '2.6.4' })
  return { product, release }
}

const write = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body) })

describe('eligibility', () => {
  beforeEach(clearDatabase)

  it('refuses somebody who never obtained the product', async () => {
    await seedContext()

    const response = await asAccount('/products/openbattery/reviews', write({ rating: 5 }))

    expect(response.status).toBe(403)
  })

  it('reports why, from a closed set, so a front-end can word its empty state', async () => {
    await seedContext()

    const { data } = (await (await asAccount('/products/openbattery/reviews/me')).json()) as {
      data: { eligibility: Eligibility }
    }

    expect(data.eligibility).toMatchObject({ can_review: false, reason: 'not_obtained', via: null })
  })

  it('says `not_authenticated` rather than nothing when nobody is signed in', async () => {
    await seedContext()

    const { data } = (await (await call('/products/openbattery/reviews/me')).json()) as {
      data: { eligibility: Eligibility }
    }

    expect(data.eligibility).toMatchObject({ can_review: false, reason: 'not_authenticated' })
  })

  it('lets somebody who paid write one, and says so', async () => {
    const { product } = await seedContext({ pricingMode: 'paid', priceAmount: 4990 })
    await seedPurchase({ productId: product.id, productSlug: product.slug, userId: 'buyer-1' })

    const { data } = (await (await asAccount('/products/openbattery/reviews/me')).json()) as {
      data: { eligibility: Eligibility }
    }

    expect(data.eligibility).toMatchObject({ can_review: true, via: 'purchase' })
    expect(data.eligibility.anchor?.version).toBe('2.6.4')
  })

  it('lets somebody who downloaded it while signed in write one', async () => {
    const { product } = await seedContext()
    await seedDownloadEvent({ productId: product.id, userId: 'buyer-1' })

    const response = await asAccount('/products/openbattery/reviews', write({ rating: 4, title: 'Good' }))

    expect(response.status).toBe(200)
  })

  /**
   * `download_events.user_id` is null for an anonymous download — that is what makes a free build
   * free — and matching by address instead would not be identity.
   */
  it('does not count an anonymous download as having obtained it', async () => {
    const { product } = await seedContext()
    await seedDownloadEvent({ productId: product.id, userId: null })

    expect((await asAccount('/products/openbattery/reviews', write({ rating: 5 }))).status).toBe(403)
  })

  /** An unanchored review has nothing for a later reset to be measured against. */
  it('refuses a product with nothing published to anchor to', async () => {
    const product = await seedProduct({ slug: 'unreleased', name: 'Unreleased' })
    await seedDownloadEvent({ productId: product.id, userId: 'buyer-1' })

    const response = await asAccount('/products/unreleased/reviews', write({ rating: 5 }))

    expect(response.status).toBe(409)
  })
})

describe('PUT /products/:slug/reviews', () => {
  beforeEach(clearDatabase)

  const eligible = async () => {
    const context = await seedContext()
    await seedDownloadEvent({ productId: context.product.id, userId: 'buyer-1' })
    return context
  }

  it('publishes immediately and anchors to the release the reviewer had', async () => {
    await eligible()

    const { data } = (await (
      await asAccount('/products/openbattery/reviews', write({ rating: 5, title: 'Great', body: 'Really.' }))
    ).json()) as { data: { status: string; release: { version: string }; counts_toward_rating: boolean } }

    expect(data.status).toBe('visible')
    expect(data.release.version).toBe('2.6.4')
    expect(data.counts_toward_rating).toBe(true)
  })

  /** One per person per product: editing is replacing, which is what makes this a PUT. */
  it('replaces the caller\'s review rather than adding a second one', async () => {
    await eligible()

    await asAccount('/products/openbattery/reviews', write({ rating: 2 }))
    await asAccount('/products/openbattery/reviews', write({ rating: 5, title: 'Changed my mind' }))

    const { data } = (await (await call('/products/openbattery/reviews')).json()) as {
      data: { reviews: { rating: number }[]; summary: { count: number; average: number } }
    }

    expect(data.reviews).toHaveLength(1)
    expect(data.reviews[0]?.rating).toBe(5)
    expect(data.summary).toMatchObject({ count: 1, average: 5 })
  })

  /**
   * Somebody who rewrites their review after two more versions is talking about the version they
   * have now, and the rating window has to agree.
   */
  it('re-anchors on an edit', async () => {
    const { product } = await eligible()
    await asAccount('/products/openbattery/reviews', write({ rating: 3 }))

    await seedRelease({
      productId: product.id,
      version: '3.0.0',
      releasedAt: new Date(Date.now() + 86_400_000),
      publishedAt: new Date(Date.now() + 86_400_000),
    })

    const { data } = (await (
      await asAccount('/products/openbattery/reviews', write({ rating: 5 }))
    ).json()) as { data: { release: { version: string } } }

    expect(data.release.version).toBe('3.0.0')
  })

  it('refuses a rating outside 1–5', async () => {
    await eligible()

    expect((await asAccount('/products/openbattery/reviews', write({ rating: 0 }))).status).toBe(400)
    expect((await asAccount('/products/openbattery/reviews', write({ rating: 6 }))).status).toBe(400)
  })

  it('needs a token', async () => {
    await eligible()

    expect((await call('/products/openbattery/reviews', write({ rating: 5 }))).status).toBe(401)
  })

  it('lets the author withdraw their own', async () => {
    await eligible()
    await asAccount('/products/openbattery/reviews', write({ rating: 5 }))

    expect((await asAccount('/products/openbattery/reviews', { method: 'DELETE' })).status).toBe(204)

    const { data } = (await (await call('/products/openbattery/reviews')).json()) as {
      data: { reviews: unknown[] }
    }
    expect(data.reviews).toEqual([])
  })
})

describe('the anchor', () => {
  beforeEach(clearDatabase)

  const eligibleOn = async (product: { id: string }) => {
    await seedDownloadEvent({ productId: product.id, userId: 'buyer-1' })
  }

  /**
   * The stable line, not "the newest thing they could have downloaded". A product publishing a
   * build every night would otherwise anchor every review to last night's, so the rating window
   * would move daily and a resetting release would be measured against something nobody installed.
   */
  it('is the latest stable release, never a newer nightly', async () => {
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
    await eligibleOn(product)

    const { data } = (await (
      await asAccount('/products/openbattery/reviews', write({ rating: 5 }))
    ).json()) as { data: { release: { version: string; channel: string } } }

    expect(data.release).toMatchObject({ version: '2.6.4', channel: 'release' })
  })

  /** Something shipping nothing but betas is still reviewable by the people running those betas. */
  it('falls back to the newest pre-release when nothing stable was ever published', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedRelease({ productId: product.id, version: '0.9.0-beta', channel: 'beta' })
    await eligibleOn(product)

    const { data } = (await (
      await asAccount('/products/openbattery/reviews', write({ rating: 4 }))
    ).json()) as { data: { release: { channel: string } } }

    expect(data.release.channel).toBe('beta')
  })
})
