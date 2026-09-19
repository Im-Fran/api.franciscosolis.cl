import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearDatabase, seedProduct, seedPurchase, seedRelease, seedReleaseFile } from '../helpers/db'
import { asBuyer } from '../helpers/tokens'

const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

/**
 * A product with one stable build and one pre-release build, and a flag saying whether the
 * pre-release line is behind the purchase.
 *
 * `donation` by default, because that is the mode the flag exists for: a pay-what-you-like product
 * is free to take, so the pre-release line is the only thing a supporter gets that a non-supporter
 * does not. In `paid` mode the price gate already refuses everything, flag or no flag.
 */
const seedLines = async (overrides: Record<string, unknown> = {}) => {
  const product = await seedProduct({
    slug: 'openbattery',
    name: 'OpenBattery',
    pricingMode: 'donation',
    suggestedAmount: 2000,
    preReleaseRequiresPurchase: true,
    ...overrides,
  })
  const stable = await seedRelease({ productId: product.id, version: '2.6.4', channel: 'release' })
  const beta = await seedRelease({ productId: product.id, version: '2.7.0', channel: 'beta' })
  const stableFile = await seedReleaseFile({ productId: product.id, releaseId: stable.id, filename: 'stable.zip' })
  const betaFile = await seedReleaseFile({ productId: product.id, releaseId: beta.id, filename: 'beta.zip' })
  return { product, stable, beta, stableFile, betaFile }
}

const buyer = (product: { id: string; slug: string }) =>
  seedPurchase({ productId: product.id, productSlug: product.slug, userId: 'buyer-1', email: 'buyer@example.com' })

const mint = async (fileId: string, headers: Record<string, string> = {}) =>
  call(`/products/openbattery/files/${fileId}/download`, { method: 'POST', headers })

describe('a donation product that reserves its pre-releases for supporters', () => {
  beforeEach(clearDatabase)

  it('refuses a pre-release build to somebody who has not paid, and says which gate it is', async () => {
    const { betaFile } = await seedLines()

    const response = await mint(betaFile.id)

    expect(response.status).toBe(402)
    // The body carries the reason as a key, not just as prose: "buy this" and "support this to get
    // the nightlies" are different modals, and a front-end should not have to match on a sentence.
    expect(await response.json()).toMatchObject({ code: 402, gate: 'pre_release' })
  })

  /** The whole point of the mode: refusing the pre-release must not refuse the product. */
  it('still hands anybody the stable build, with the cooldown a non-payer gets', async () => {
    const { stableFile } = await seedLines()

    const response = await mint(stableFile.id)
    const { data } = (await response.json()) as { data: { cooldown_seconds: number; paid: boolean } }

    expect(response.status).toBe(201)
    expect(data).toMatchObject({ paid: false })
    expect(data.cooldown_seconds).toBeGreaterThan(0)
  })

  it('mints a pre-release ticket for somebody who has paid', async () => {
    const { product, betaFile } = await seedLines()
    await buyer(product)

    const response = await mint(betaFile.id, await asBuyer())

    expect(response.status).toBe(201)
  })

  /**
   * The price gate and the channel gate are different refusals and the body has to say which.
   * Telling a non-payer of a *paid* product that "pre-releases are for supporters" would suggest
   * the stable build was free, so the price gate has to win wherever both apply.
   */
  it('reports the price gate, not the channel gate, when the product is paid outright', async () => {
    const { betaFile } = await seedLines({ pricingMode: 'paid', priceAmount: 4990, suggestedAmount: null })

    const response = await mint(betaFile.id)

    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ gate: 'paid' })
  })
})

describe('the gate is on the download and nowhere else', () => {
  beforeEach(clearDatabase)

  /** Hiding a nightly would remove the very incentive the gate exists to create. */
  it('still lists the files of a gated pre-release to a signed-out visitor', async () => {
    await seedLines()

    const response = await call('/products/openbattery/releases/beta/2.7.0/files')
    const { data } = (await response.json()) as {
      data: { files: unknown[]; requires_payment: boolean; channel_requires_purchase: boolean }
    }

    expect(response.status).toBe(200)
    expect(data.files).toHaveLength(1)
    expect(data.channel_requires_purchase).toBe(true)
    // Cacheable, because it is the same answer for everybody. The per-person answer is `…/access`.
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/)
  })

  it('says the stable channel is not behind the purchase, on the same product', async () => {
    await seedLines()

    const { data } = (await (
      await call('/products/openbattery/releases/release/2.6.4/files')
    ).json()) as { data: { channel_requires_purchase: boolean } }

    expect(data.channel_requires_purchase).toBe(false)
  })
})

describe('GET /products/:slug/access?channel', () => {
  beforeEach(clearDatabase)

  it('answers about the product when no channel is named, and about the line when one is', async () => {
    await seedLines()

    const about = async (query: string) =>
      ((await (await call(`/products/openbattery/access${query}`)).json()) as {
        data: { gate: string; channel: string | null; can_download: boolean }
      }).data

    // No channel in hand means no channel gate to report: the answer is about the product, and a
    // donation product is downloadable by anybody.
    expect(await about('')).toMatchObject({ gate: 'none', channel: null, can_download: true })
    expect(await about('?channel=release')).toMatchObject({ gate: 'none', channel: 'release' })
    expect(await about('?channel=beta')).toMatchObject({ gate: 'pre_release', can_download: false })
  })

  it('drops to `none` on every channel once the caller has paid', async () => {
    const { product } = await seedLines()
    await buyer(product)

    const headers = await asBuyer()
    for (const channel of ['release', 'beta', 'nightly']) {
      const { data } = (await (
        await call(`/products/openbattery/access?channel=${channel}`, { headers })
      ).json()) as { data: { gate: string; can_download: boolean } }

      expect(data).toMatchObject({ gate: 'none', can_download: true })
    }
  })
})

describe('the flag is inert outside `paid` mode', () => {
  beforeEach(clearDatabase)

  /**
   * Nulled by `describePricing` for exactly the reason `price` is: an editor who switches a paid
   * product to `free` for a launch week keeps the flag in the column, and a website reading that
   * column raw would go on gating tonight's nightly on a product nobody can pay for any more.
   */
  it('mints a pre-release ticket on a free product even with the flag set', async () => {
    const { betaFile } = await seedLines({ pricingMode: 'free', suggestedAmount: null })

    const response = await mint(betaFile.id)

    expect(response.status).toBe(201)
  })

  it('reports the flag as false in the pricing of a free product', async () => {
    await seedLines({ pricingMode: 'free', suggestedAmount: null })

    const { data } = (await (await call('/products/openbattery/pricing')).json()) as {
      data: { pre_release_requires_purchase: boolean }
    }

    expect(data.pre_release_requires_purchase).toBe(false)
  })
})
