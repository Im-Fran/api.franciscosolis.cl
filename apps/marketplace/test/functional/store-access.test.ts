import { SELF } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { COOLDOWN_SECONDS } from '@/lib/downloads'
import { clearDatabase, seedProduct, seedPurchase } from '../helpers/db'
import { asBuyer } from '../helpers/tokens'

const get = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://marketplace.test${path}`, { headers })

const data = async <T>(path: string, headers: Record<string, string> = {}): Promise<T> =>
  ((await (await get(path, headers)).json()) as { data: T }).data

const paidApp = () => seedProduct({ slug: 'openbattery', name: 'OpenBattery', pricingMode: 'paid', priceAmount: 4990 })

describe('GET /products/:slug/pricing', () => {
  beforeEach(clearDatabase)

  it('answers the price of a paid product, and is cacheable', async () => {
    await paidApp()

    const response = await get('/products/openbattery/pricing')

    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      mode: 'paid',
      price: 4990,
      currency: 'CLP',
      requires_payment: true,
      allows_skip: false,
    })
    // The same answer for everybody, so a shared cache may keep it. `…/access` is the per-person one.
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/)
  })

  it('does not exist for a draft product', async () => {
    await seedProduct({ slug: 'unannounced', status: 'draft', pricingMode: 'paid', priceAmount: 1000 })

    expect((await get('/products/unannounced/pricing')).status).toBe(404)
  })
})

describe('GET /products/:slug/access', () => {
  beforeEach(clearDatabase)

  it('tells a signed-out visitor of a paid product that they cannot download yet', async () => {
    await paidApp()

    expect(await data<Record<string, unknown>>('/products/openbattery/access')).toMatchObject({
      has_paid: false,
      must_offer_payment: true,
      can_download: false,
      authenticated: false,
      cooldown_seconds: COOLDOWN_SECONDS,
    })
  })

  it('recognises a buyer and hands them the direct route', async () => {
    const product = await paidApp()
    await seedPurchase({ productId: product.id, productSlug: product.slug })

    const access = await data<Record<string, unknown>>('/products/openbattery/access', await asBuyer())

    expect(access).toMatchObject({
      has_paid: true,
      must_offer_payment: false,
      can_download: true,
      // No wait at all once it is paid for: that is the whole difference between the two experiences.
      cooldown_seconds: 0,
      authenticated: true,
    })
    expect(access.purchase).toMatchObject({ kind: 'purchase', amount: 4990 })
  })

  it('does not treat a payment that is still pending as a payment', async () => {
    const product = await paidApp()
    await seedPurchase({ productId: product.id, productSlug: product.slug, status: 'pending' })

    expect(await data<Record<string, unknown>>('/products/openbattery/access', await asBuyer())).toMatchObject({
      has_paid: false,
      can_download: false,
    })
  })

  it('stops entitling once a payment is refunded', async () => {
    const product = await paidApp()
    await seedPurchase({ productId: product.id, productSlug: product.slug, status: 'refunded' })

    expect(await data<Record<string, unknown>>('/products/openbattery/access', await asBuyer())).toMatchObject({
      has_paid: false,
      can_download: false,
    })
  })

  it('matches a payment made under the same verified address on another account', async () => {
    const product = await paidApp()
    await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      userId: 'some-older-account',
      email: 'buyer@example.com',
    })

    expect(
      await data<Record<string, unknown>>('/products/openbattery/access', await asBuyer({ sub: 'buyer-2' })),
    ).toMatchObject({ has_paid: true })
  })

  it('does not match a payment belonging to somebody else', async () => {
    const product = await paidApp()
    await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      userId: 'other-account',
      email: 'someone@example.com',
    })

    expect(
      await data<Record<string, unknown>>('/products/openbattery/access', await asBuyer()),
    ).toMatchObject({ has_paid: false })
  })

  it('always offers to a non-payer of an optional-pay product, and still lets them download', async () => {
    await seedProduct({ slug: 'freebie', pricingMode: 'donation', suggestedAmount: 3000 })

    expect(await data<Record<string, unknown>>('/products/freebie/access')).toMatchObject({
      must_offer_payment: true,
      can_download: true,
      cooldown_seconds: COOLDOWN_SECONDS,
    })
  })

  it('never offers anything for a free product', async () => {
    await seedProduct({ slug: 'gratis' })

    expect(await data<Record<string, unknown>>('/products/gratis/access')).toMatchObject({
      must_offer_payment: false,
      can_download: true,
      cooldown_seconds: 0,
    })
  })

  it('is never cached, because it is per person', async () => {
    await paidApp()

    expect((await get('/products/openbattery/access')).headers.get('Cache-Control')).toBe('no-store')
  })

  it('treats an unusable token as nobody rather than refusing the request', async () => {
    await seedProduct({ slug: 'gratis' })

    const response = await get('/products/gratis/access', { Authorization: 'Bearer not-a-token' })

    // A download route runs for a signed-out visitor too, and anonymous grants strictly less.
    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: { authenticated: boolean } }).data.authenticated).toBe(false)
  })

  it('refuses an editor token here: the audience lists are separate', async () => {
    await paidApp()

    // An editor's token is minted for the CMS audience, which is not in `MARKETPLACE_ACCOUNT_AUDIENCES`.
    const { asEditor } = await import('../helpers/tokens')
    const access = await data<Record<string, unknown>>('/products/openbattery/access', await asEditor())

    expect(access.authenticated).toBe(false)
  })
})
