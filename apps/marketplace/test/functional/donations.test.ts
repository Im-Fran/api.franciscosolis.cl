import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSender } from '@/env'
import { clearExchangeRateCache } from '@/services/exchange'
import { clearDatabase, seedProduct, seedPurchase } from '../helpers/db'
import { asBuyer, asEditor } from '../helpers/tokens'

/**
 * The donation link: support for the work in general, in any amount and any listed currency, settled
 * in pesos.
 *
 * Both outside services are stubbed at `fetch`, by URL, so a test fails when the Worker asks the
 * wrong one — and so the suite can never create a real preference or depend on today's rates.
 */
const call = (path: string, init: RequestInit = {}) => SELF.fetch(`https://marketplace.test${path}`, init)

/** What the rate source answers, quoted against the dollar like the real one. */
const RATES = {
  result: 'success',
  time_last_update_unix: Math.floor(Date.now() / 1000) - 3600,
  rates: { USD: 1, CLP: 950, EUR: 0.95, JPY: 150, ARS: 1500 },
}

type Captured = { url: string; body: Record<string, unknown> }

const stubServices = (
  options: { rates?: Response | (() => Response); preference?: Response | (() => Response) } = {},
) => {
  const calls: Captured[] = []
  const answer = (value: Response | (() => Response) | undefined, fallback: () => Response) =>
    value === undefined ? fallback() : typeof value === 'function' ? value() : value.clone()

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} })
      if (url.startsWith('https://open.er-api.com/')) {
        return answer(options.rates, () => Response.json(RATES))
      }
      if (url.includes('/checkout/preferences')) {
        return answer(options.preference, () =>
          Response.json({ id: 'pref-donation', init_point: 'https://mp.test/live', sandbox_init_point: 'https://mp.test/sandbox' }),
        )
      }
      return new Response('unexpected call', { status: 404 })
    }),
  )
  return calls
}

const donate = async (body: Record<string, unknown>, headers?: Record<string, string>) => {
  const response = await call('/donations/checkout', {
    method: 'POST',
    headers: headers ?? (await asBuyer()),
    body: JSON.stringify(body),
  })
  return { response, json: (await response.json()) as { data?: Record<string, unknown>; error?: string } }
}

const purchaseRow = () =>
  env.DB.prepare(
    'SELECT product_id, product_slug, kind, status, amount, currency, pledged_amount, pledged_currency, user_id, metadata FROM purchases',
  ).first<{
    product_id: string
    product_slug: string
    kind: string
    status: string
    amount: number
    currency: string
    pledged_amount: number | null
    pledged_currency: string | null
    user_id: string
    metadata: string
  }>()

beforeEach(async () => {
  await clearDatabase()
  clearExchangeRateCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GET /donations', () => {
  it('lists every accepted currency with what one unit is worth in pesos', async () => {
    stubServices()

    const response = await call('/donations')
    const { data } = (await response.json()) as {
      data: { settlement_currency: string; currencies: { code: string; minor_units: number; clp_per_unit: number | null }[] }
    }

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('public')
    expect(data.settlement_currency).toBe('CLP')
    expect(data.currencies.find((entry) => entry.code === 'CLP')).toMatchObject({ minor_units: 0, clp_per_unit: 1 })
    expect(data.currencies.find((entry) => entry.code === 'USD')).toMatchObject({ minor_units: 2, clp_per_unit: 950 })
    expect(data.currencies.find((entry) => entry.code === 'EUR')?.clp_per_unit).toBeCloseTo(1000, 6)
    // A currency the source did not quote is listed without a rate rather than dropped or invented.
    expect(data.currencies.find((entry) => entry.code === 'GBP')?.clp_per_unit).toBeNull()
  })

  it('still answers through an outage of the rate source, with pesos as the one usable currency', async () => {
    stubServices({ rates: () => new Response('down', { status: 503 }) })

    const response = await call('/donations')
    const { data } = (await response.json()) as {
      data: { currencies: { code: string; clp_per_unit: number | null }[]; rates_updated_at: string | null }
    }

    expect(response.status).toBe(200)
    expect(data.rates_updated_at).toBeNull()
    expect(data.currencies.find((entry) => entry.code === 'CLP')?.clp_per_unit).toBe(1)
    expect(data.currencies.find((entry) => entry.code === 'USD')?.clp_per_unit).toBeNull()
  })

  it('refuses rates the source stopped updating days ago', async () => {
    stubServices({ rates: () => Response.json({ ...RATES, time_last_update_unix: Math.floor(Date.now() / 1000) - 10 * 86_400 }) })

    const { data } = (await (await call('/donations')).json()) as { data: { currencies: { code: string; clp_per_unit: number | null }[] } }
    expect(data.currencies.find((entry) => entry.code === 'USD')?.clp_per_unit).toBeNull()
  })
})

describe('POST /donations/checkout', () => {
  it('opens a donation in pesos with no floor of ours, filed under the general fund', async () => {
    const calls = stubServices()

    const { response, json } = await donate({ amount: 1, currency: 'CLP', locale: 'es' })

    expect(response.status).toBe(201)
    expect(json.data).toMatchObject({
      amount: 1,
      currency: 'CLP',
      pledged: null,
      exchange_rate: null,
      // The suite runs as `sandbox`, so the sandbox checkout is the one handed back.
      checkout_url: 'https://mp.test/sandbox',
    })

    expect(await purchaseRow()).toMatchObject({
      product_id: 'general',
      product_slug: 'general',
      kind: 'donation',
      status: 'pending',
      amount: 1,
      currency: 'CLP',
      pledged_amount: null,
      pledged_currency: null,
      user_id: 'buyer-1',
    })

    // A peso donation never asks for a rate, so it keeps working whatever the rate source is doing.
    expect(calls.some((captured) => captured.url.startsWith('https://open.er-api.com/'))).toBe(false)
    const item = (calls[0]?.body.items as Record<string, unknown>[])[0]
    expect(item).toMatchObject({ currency_id: 'CLP', unit_price: 1 })
  })

  it('takes an amount far above any product price', async () => {
    stubServices()

    const { response, json } = await donate({ amount: 250_000_000 })

    expect(response.status).toBe(201)
    expect(json.data).toMatchObject({ amount: 250_000_000, currency: 'CLP' })
  })

  it('converts a donation named in dollars into pesos, and keeps what the donor chose', async () => {
    const calls = stubServices()

    const { response, json } = await donate({ amount: 10.5, currency: 'usd' })

    expect(response.status).toBe(201)
    expect(json.data).toMatchObject({
      amount: 9975,
      currency: 'CLP',
      pledged: { amount: 10.5, currency: 'USD' },
      exchange_rate: 950,
    })

    const row = await purchaseRow()
    expect(row).toMatchObject({ amount: 9975, currency: 'CLP', pledged_amount: 1050, pledged_currency: 'USD' })
    expect(JSON.parse(row?.metadata ?? '{}')).toMatchObject({ scope: 'general', exchange_rate: 950 })

    // MercadoPago is only ever asked to charge pesos: this account cannot settle anything else.
    const preference = calls.find((captured) => captured.url.includes('/checkout/preferences'))
    expect((preference?.body.items as Record<string, unknown>[])[0]).toMatchObject({ currency_id: 'CLP', unit_price: 9975 })
  })

  it('sends the donor back to the donation page with the payment to wait for', async () => {
    const calls = stubServices()

    const { json } = await donate({ amount: 5000 })

    const preference = calls.find((captured) => captured.url.includes('/checkout/preferences'))
    expect(preference?.body.back_urls).toMatchObject({
      success: `https://site.test/donate?donation=${json.data?.purchase_id}`,
    })
    expect(preference?.body.notification_url).toBe('https://api.test/marketplace/payments/mercadopago/webhook')
  })

  it('refuses more decimals than the currency is written with', async () => {
    stubServices()

    const pesos = await donate({ amount: 1000.5, currency: 'CLP' })
    const dollars = await donate({ amount: 1.005, currency: 'USD' })

    expect(pesos.response.status).toBe(422)
    expect(dollars.response.status).toBe(422)
    expect(await purchaseRow()).toBeNull()
  })

  it('refuses nothing, a negative amount and an unlisted currency', async () => {
    stubServices()

    expect((await donate({ amount: 0 })).response.status).toBe(400)
    expect((await donate({ amount: -5 })).response.status).toBe(400)
    expect((await donate({ amount: 5, currency: 'XYZ' })).response.status).toBe(400)
  })

  it('refuses an amount that is less than a peso once converted', async () => {
    stubServices()

    const { response } = await donate({ amount: 0.01, currency: 'ARS' })

    expect(response.status).toBe(422)
    expect(await purchaseRow()).toBeNull()
  })

  it('answers 503 for a foreign currency when there is no rate, while pesos keep working', async () => {
    stubServices({ rates: () => new Response('down', { status: 503 }) })

    const dollars = await donate({ amount: 10, currency: 'USD' })
    expect(dollars.response.status).toBe(503)
    expect(await purchaseRow()).toBeNull()

    const pesos = await donate({ amount: 10_000, currency: 'CLP' })
    expect(pesos.response.status).toBe(201)
  })

  it('reports an amount MercadoPago refuses as the donor\'s to change, not as an outage', async () => {
    stubServices({ preference: () => Response.json({ message: 'invalid unit_price' }, { status: 400 }) })

    const { response } = await donate({ amount: 1 })

    expect(response.status).toBe(422)
  })

  it('needs an account, like every payment here', async () => {
    stubServices()

    const { response } = await donate({ amount: 5000 }, { 'Content-Type': 'application/json' })

    expect(response.status).toBe(401)
  })
})

describe('the general fund in the back office', () => {
  let realEmail: EmailSender

  beforeEach(() => {
    realEmail = env.EMAIL
    ;(env as { EMAIL: EmailSender }).EMAIL = { send: vi.fn(async () => ({ messageId: 'test' })) } as unknown as EmailSender
  })

  afterEach(() => {
    ;(env as { EMAIL: EmailSender }).EMAIL = realEmail
  })

  it('lists general donations under /admin/products/general and nothing else there', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedPurchase({ productId: product.id, productSlug: product.slug })
    const donation = await seedPurchase({
      productId: 'general',
      productSlug: 'general',
      kind: 'donation',
      amount: 9975,
      pledgedAmount: 1050,
      pledgedCurrency: 'USD',
    })

    const response = await call('/admin/products/general/sales', { headers: await asEditor() })
    const { data } = (await response.json()) as { data: { id: string; pledged: unknown }[] }

    expect(response.status).toBe(200)
    expect(data.map((sale) => sale.id)).toEqual([donation.id])
    expect(data[0]?.pledged).toEqual({ amount: 10.5, currency: 'USD' })
  })

  it('records a donation taken in cash as a donation, whatever the form said', async () => {
    const response = await call('/admin/products/general/sales', {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ email: 'donor@example.com', source: 'cash', amount: 20_000, kind: 'purchase' }),
    })
    const { data } = (await response.json()) as { data: { sale: { kind: string; product_id: string }; voucher: { product_name: string } } }

    expect(response.status).toBe(201)
    expect(data.sale).toMatchObject({ kind: 'donation', product_id: 'general' })
    expect(data.voucher.product_name).toBe('FranciscoSolis')
  })

  it('issues a receipt that states what the donor chose and links back to the donation page', async () => {
    const donation = await seedPurchase({
      productId: 'general',
      productSlug: 'general',
      kind: 'donation',
      amount: 9975,
      pledgedAmount: 1050,
      pledgedCurrency: 'USD',
    })

    const response = await call(`/admin/products/general/sales/${donation.id}/vouchers`, {
      method: 'POST',
      headers: await asEditor(),
      body: JSON.stringify({ locale: 'en' }),
    })
    const { data } = (await response.json()) as { data: { pledged: unknown; product_name: string } }

    expect(response.status).toBe(201)
    expect(data).toMatchObject({ product_name: 'FranciscoSolis', pledged: { amount: 10.5, currency: 'USD' } })

    const send = env.EMAIL.send as unknown as ReturnType<typeof vi.fn>
    const message = send.mock.calls[0]?.[0] as { html: string; text: string }
    expect(message.text).toContain('$10.50')
    // Intl separates a currency code from its figure with a non-breaking space.
    expect(message.text).toMatch(/CLP\s9,975/)
    expect(message.html).toContain('https://site.test/donate')
    expect(message.html).not.toContain('/product/general')
  })

  it('does not list the general fund\'s sales through a real product', async () => {
    const product = await seedProduct({ slug: 'openbattery' })
    await seedPurchase({ productId: 'general', productSlug: 'general', kind: 'donation' })

    const response = await call(`/admin/products/${product.id}/sales`, { headers: await asEditor() })
    const { data } = (await response.json()) as { data: unknown[] }

    expect(data).toEqual([])
  })
})
