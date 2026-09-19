import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, seedProduct, seedPurchase } from '../helpers/db'
import { asBuyer } from '../helpers/tokens'

/**
 * Checkout, with MercadoPago stubbed at `fetch`.
 *
 * The pool exports no `fetchMock`, so outbound HTTP is controlled with `vi.stubGlobal` — and that does
 * reach the Worker behind `SELF`, because it shares this test's isolate. The stub is not a convenience:
 * a suite that could reach the real API is a suite that can create real preferences.
 */
const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

/** Captures what was sent to the provider, and answers a preference. */
const stubMercadoPago = (preference: Record<string, unknown> = { id: 'pref-123', init_point: 'https://mp.test/checkout/123' }) => {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return Response.json(preference)
    }),
  )
  return calls
}

const checkout = async (slug: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) => {
  const response = await call(`/products/${slug}/checkout`, {
    method: 'POST',
    headers: headers ?? (await asBuyer()),
    body: JSON.stringify(body),
  })
  return { response, json: (await response.json()) as { data?: Record<string, unknown>; error?: string } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /products/:slug/checkout', () => {
  beforeEach(clearDatabase)

  it('opens a pending purchase before the browser leaves, and hands back the checkout URL', async () => {
    await seedProduct({ slug: 'openbattery', name: 'OpenBattery', pricingMode: 'paid', priceAmount: 4990 })
    const calls = stubMercadoPago()

    const { response, json } = await checkout('openbattery')

    expect(response.status).toBe(201)
    expect(json.data).toMatchObject({ amount: 4990, currency: 'CLP', checkout_url: 'https://mp.test/checkout/123' })

    // The row exists *before* the redirect: a payment that arrives for something this database has
    // never heard of is a payment that goes missing.
    const row = await env.DB.prepare('SELECT status, amount, kind, user_id, email, preference_id FROM purchases').first<{
      status: string
      amount: number
      kind: string
      user_id: string
      email: string
      preference_id: string
    }>()
    expect(row).toMatchObject({
      status: 'pending',
      amount: 4990,
      kind: 'purchase',
      user_id: 'buyer-1',
      email: 'buyer@example.com',
      preference_id: 'pref-123',
    })

    // Our own id travels as the external reference, which is what a notification finds the row by.
    expect(calls[0]?.body.external_reference).toBe(json.data?.reference)
    expect(calls[0]?.headers['X-Idempotency-Key']).toBe(json.data?.reference)
  })

  it('sends the buyer back to the website, never to the API', async () => {
    await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const calls = stubMercadoPago()

    await checkout('openbattery')

    expect(calls[0]?.body.back_urls).toMatchObject({ success: 'https://site.test/product/openbattery' })
    expect(calls[0]?.body.notification_url).toBe('https://api.test/pages/payments/mercadopago/webhook')
  })

  it('charges a paid product its price even when a smaller amount is asked for', async () => {
    await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    stubMercadoPago()

    const { json } = await checkout('openbattery', { amount: 500 })

    expect(json.data?.amount).toBe(4990)
  })

  it('lets a donor name their own amount', async () => {
    await seedProduct({ slug: 'freebie', pricingMode: 'donation', suggestedAmount: 2000 })
    stubMercadoPago()

    const { json } = await checkout('freebie', { amount: 9000 })

    expect(json.data).toMatchObject({ amount: 9000 })
    const row = await env.DB.prepare('SELECT kind FROM purchases').first<{ kind: string }>()
    expect(row?.kind).toBe('donation')
  })

  it('refuses to charge for a free product', async () => {
    await seedProduct({ slug: 'gratis' })
    stubMercadoPago()

    expect((await checkout('gratis')).response.status).toBe(422)
  })

  it('refuses to sell a paid product twice', async () => {
    const product = await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    await seedPurchase({ productId: product.id, productSlug: product.slug })
    stubMercadoPago()

    expect((await checkout('openbattery')).response.status).toBe(409)
  })

  it('lets somebody donate again, because a donation is a repeatable act', async () => {
    const product = await seedProduct({ slug: 'freebie', pricingMode: 'donation', suggestedAmount: 1000 })
    await seedPurchase({ productId: product.id, productSlug: product.slug, kind: 'donation' })
    stubMercadoPago()

    expect((await checkout('freebie')).response.status).toBe(201)
  })

  it('needs an account: a payment with nobody on it has nowhere to live', async () => {
    await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })

    const response = await call('/products/openbattery/checkout', { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
  })

  it('refuses an editor token: the audience lists are separate', async () => {
    await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const { asEditor } = await import('../helpers/tokens')

    expect((await checkout('openbattery', {}, await asEditor())).response.status).toBe(401)
  })

  it('answers 502 and keeps the pending row when the provider cannot be reached', async () => {
    await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))

    expect((await checkout('openbattery')).response.status).toBe(502)

    // Left behind on purpose: it is the record that somebody tried, and a payment that arrives anyway
    // still has something to attach to.
    const row = await env.DB.prepare('SELECT status FROM purchases').first<{ status: string }>()
    expect(row?.status).toBe('pending')
  })
})

describe('GET /me/purchases', () => {
  beforeEach(clearDatabase)

  it('lists what the account paid for, newest first', async () => {
    const first = await seedProduct({ slug: 'one', pricingMode: 'paid', priceAmount: 1000 })
    const second = await seedProduct({ slug: 'two', pricingMode: 'paid', priceAmount: 2000 })
    await seedPurchase({ productId: first.id, productSlug: first.slug, createdAt: new Date(1_700_000_000_000) })
    await seedPurchase({ productId: second.id, productSlug: second.slug, createdAt: new Date(1_800_000_000_000) })

    const response = await call('/me/purchases', { headers: await asBuyer() })
    const { data } = (await response.json()) as { data: { product_slug: string; active: boolean }[] }

    expect(data.map((row) => row.product_slug)).toEqual(['two', 'one'])
    expect(data.every((row) => row.active)).toBe(true)
  })

  it('never shows somebody else\'s payments', async () => {
    const product = await seedProduct({ slug: 'one', pricingMode: 'paid', priceAmount: 1000 })
    await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      userId: 'someone-else',
      email: 'other@example.com',
    })

    const { data } = (await (await call('/me/purchases', { headers: await asBuyer() })).json()) as { data: unknown[] }
    expect(data).toEqual([])
  })

  it('answers 404 for a payment that is not yours, not 403', async () => {
    const product = await seedProduct({ slug: 'one', pricingMode: 'paid', priceAmount: 1000 })
    const purchase = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      userId: 'someone-else',
      email: 'other@example.com',
    })

    // A 403 would confirm the id exists, and these ids travel in URLs a browser has been through.
    expect((await call(`/me/purchases/${purchase.id}`, { headers: await asBuyer() })).status).toBe(404)
  })

  it('needs a token', async () => {
    expect((await call('/me/purchases')).status).toBe(401)
  })
})
