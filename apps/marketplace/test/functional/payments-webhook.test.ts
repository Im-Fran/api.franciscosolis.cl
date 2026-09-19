import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, seedProduct, seedPurchase } from '../helpers/db'
import { asBuyer } from '../helpers/tokens'

/**
 * The provider's way back in — the only unauthenticated write in this Worker.
 *
 * Every test here stubs the payment *read* as well as sending the notification, because the
 * notification body is deliberately not evidence: the status comes from asking MercadoPago about the
 * payment. A test that only posted a body would pass against a Worker that trusted one.
 */
const SECRET = 'test-webhook-secret'

const hmac = async (manifest: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Stubs `GET /v1/payments/:id`, which is where the status actually comes from. */
const stubPayment = (payment: Record<string, unknown>) => {
  const fetchMock = vi.fn(async () => Response.json(payment))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Stubs whichever of the three read endpoints the topic under test uses, by URL.
 *
 * Matching on the path rather than answering everything the same way is what makes a test fail when
 * the Worker asks the *wrong* API about a notification — which is the whole risk of supporting two
 * generations of the provider's model at once.
 */
const stubByPath = (routes: { payments?: unknown; orders?: unknown; chargebacks?: unknown }) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/v1/orders/') && routes.orders) {
      return Response.json(routes.orders)
    }
    if (url.includes('/v1/chargebacks/') && routes.chargebacks) {
      return Response.json(routes.chargebacks)
    }
    if (url.includes('/v1/payments/') && routes.payments) {
      return Response.json(routes.payments)
    }
    return new Response('unexpected call', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const notify = async (
  dataId: string,
  options: {
    signed?: boolean
    requestId?: string
    topic?: string
    action?: string
    /** `data.payment_id`, which only the chargeback topic carries. */
    paymentId?: string
  } = {},
) => {
  const requestId = options.requestId ?? 'req-1'
  const ts = '1700000000'
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-request-id': requestId }
  if (options.signed !== false) {
    // The manifest lowercases a non-numeric id, which is what an orders id (`ORD01…`) exercises.
    const signedId = /^\d+$/.test(dataId) ? dataId : dataId.toLowerCase()
    headers['x-signature'] = `ts=${ts},v1=${await hmac(`id:${signedId};request-id:${requestId};ts:${ts};`)}`
  }

  return SELF.fetch('https://marketplace.test/payments/mercadopago/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: options.topic ?? 'payment',
      action: options.action,
      data: { id: dataId, ...(options.paymentId ? { payment_id: options.paymentId } : {}) },
    }),
  })
}

const purchaseRow = (id: string) =>
  env.DB.prepare(
    'SELECT status, payment_id, amount, approved_at, charged_back_at, chargeback_id FROM purchases WHERE id = ?',
  )
    .bind(id)
    .first<{
      status: string
      payment_id: string | null
      amount: number
      approved_at: number | null
      charged_back_at: number | null
      chargeback_id: string | null
    }>()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /payments/mercadopago/webhook', () => {
  beforeEach(clearDatabase)

  const pendingPurchase = async () => {
    const product = await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const purchase = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      status: 'pending',
      approvedAt: null,
    })
    return { product, purchase }
  }

  it('approves a purchase from the payment the provider reports, not from the body', async () => {
    const { purchase } = await pendingPurchase()
    stubPayment({
      id: 987,
      status: 'approved',
      transaction_amount: 4990,
      external_reference: purchase.externalReference,
    })

    const response = await notify('987')

    expect(response.status).toBe(200)
    expect(await purchaseRow(purchase.id)).toMatchObject({ status: 'approved', payment_id: '987' })
    expect((await purchaseRow(purchase.id))?.approved_at).not.toBeNull()
  })

  it('records the settled amount rather than the one we asked for', async () => {
    const { purchase } = await pendingPurchase()
    stubPayment({ id: 988, status: 'approved', transaction_amount: 12_000, external_reference: purchase.externalReference })

    await notify('988')

    // A donor who edited the total on the checkout paid what they paid.
    expect((await purchaseRow(purchase.id))?.amount).toBe(12_000)
  })

  it('refuses an unsigned notification', async () => {
    const { purchase } = await pendingPurchase()
    stubPayment({ id: 989, status: 'approved', external_reference: purchase.externalReference })

    expect((await notify('989', { signed: false })).status).toBe(401)
    expect((await purchaseRow(purchase.id))?.status).toBe('pending')
  })

  it('refuses a signature minted for another payment', async () => {
    const { purchase } = await pendingPurchase()
    stubPayment({ id: 990, status: 'approved', external_reference: purchase.externalReference })

    const ts = '1700000000'
    const response = await SELF.fetch('https://marketplace.test/payments/mercadopago/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'req-1',
        'x-signature': `ts=${ts},v1=${await hmac(`id:111111;request-id:req-1;ts:${ts};`)}`,
      },
      body: JSON.stringify({ type: 'payment', data: { id: '990' } }),
    })

    expect(response.status).toBe(401)
    expect((await purchaseRow(purchase.id))?.status).toBe('pending')
  })

  it('is idempotent: a retried notification of the same transition changes nothing twice', async () => {
    const { purchase } = await pendingPurchase()
    stubPayment({ id: 991, status: 'approved', transaction_amount: 4990, external_reference: purchase.externalReference })

    const first = (await (await notify('991')).json()) as { data: { handled: boolean } }
    const second = (await (await notify('991')).json()) as { data: { handled: boolean } }

    expect(first.data.handled).toBe(true)
    // Still a 200, because anything else has the provider retrying forever.
    expect(second.data.handled).toBe(false)
    const events = await env.DB.prepare('SELECT count(*) AS total FROM payment_events').first<{ total: number }>()
    expect(events?.total).toBe(1)
  })

  it('lets a genuine later transition through, so a refund still lands', async () => {
    const { purchase } = await pendingPurchase()
    stubPayment({ id: 992, status: 'approved', transaction_amount: 4990, external_reference: purchase.externalReference })
    await notify('992')

    stubPayment({ id: 992, status: 'refunded', transaction_amount: 4990, external_reference: purchase.externalReference })
    await notify('992', { requestId: 'req-2' })

    const row = await purchaseRow(purchase.id)
    expect(row?.status).toBe('refunded')
    // The approval is kept beside the refund: a receipt and a dispute both need to know it happened.
    expect(row?.approved_at).not.toBeNull()
  })

  it('acknowledges a notification for a payment it has never heard of', async () => {
    stubPayment({ id: 993, status: 'approved', external_reference: 'nothing-we-issued' })

    const response = await notify('993')

    expect(response.status).toBe(200)
    expect(((await response.json()) as { data: { handled: boolean } }).data.handled).toBe(false)
  })

  it('acknowledges and drops a topic that says nothing about an entitlement', async () => {
    const fetchMock = stubPayment({ id: 994, status: 'approved' })

    const response = await notify('994', { topic: 'merchant_order' })

    expect(response.status).toBe(200)
    // Not even read: a merchant order is not a payment.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not entitle on a status that is not an approval', async () => {
    const { product, purchase } = await pendingPurchase()
    stubPayment({ id: 995, status: 'rejected', external_reference: purchase.externalReference })

    await notify('995')

    expect((await purchaseRow(purchase.id))?.status).toBe('rejected')
    const access = await SELF.fetch(`https://marketplace.test/products/${product.slug}/access`)
    expect(((await access.json()) as { data: { can_download: boolean } }).data.can_download).toBe(false)
  })
})

describe('POST /payments/mercadopago/webhook · orders API', () => {
  beforeEach(clearDatabase)

  const pendingPurchase = async () => {
    const product = await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const purchase = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      status: 'pending',
      approvedAt: null,
    })
    return { product, purchase }
  }

  it('approves a purchase from an order the provider reports as processed', async () => {
    const { purchase } = await pendingPurchase()
    stubByPath({
      orders: {
        id: 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3',
        status: 'processed',
        status_detail: 'accredited',
        external_reference: purchase.externalReference,
        total_paid_amount: '4990.00',
        transactions: { payments: [{ id: '111222333', status: 'processed' }] },
      },
    })

    const response = await notify('ORD01JQ4S4KY8HWQ6NA5PXB65B3D3', { topic: 'order', action: 'order.processed' })

    expect(response.status).toBe(200)
    // The order's amounts arrive as strings in this API; the row keeps whole pesos either way.
    expect(await purchaseRow(purchase.id)).toMatchObject({ status: 'approved', payment_id: '111222333', amount: 4990 })
  })

  it('asks the orders API, not the payments API', async () => {
    const { purchase } = await pendingPurchase()
    const fetchMock = stubByPath({
      orders: { id: 'ORD02', status: 'processed', external_reference: purchase.externalReference },
    })

    await notify('ORD02', { topic: 'order', action: 'order.processed' })

    const called = fetchMock.mock.calls.map(([input]) => String(input))
    expect(called.some((url) => url.includes('/v1/orders/ORD02'))).toBe(true)
    expect(called.some((url) => url.includes('/v1/payments/'))).toBe(false)
  })

  it('does not entitle on an order that is merely created', async () => {
    const { purchase } = await pendingPurchase()
    stubByPath({ orders: { id: 'ORD03', status: 'created', external_reference: purchase.externalReference } })

    await notify('ORD03', { topic: 'order', action: 'order.created' })

    expect((await purchaseRow(purchase.id))?.status).toBe('pending')
  })

  it('finds the purchase by its payments when the order carries no reference of ours', async () => {
    const { purchase } = await pendingPurchase()
    await env.DB.prepare('UPDATE purchases SET payment_id = ? WHERE id = ?').bind('999888', purchase.id).run()
    stubByPath({
      orders: {
        id: 'ORD04',
        status: 'processed',
        transactions: { payments: [{ id: '999888' }] },
      },
    })

    await notify('ORD04', { topic: 'order', action: 'order.processed' })

    expect((await purchaseRow(purchase.id))?.status).toBe('approved')
  })

  it('applies one transition once when both dashboard topics are enabled', async () => {
    const { purchase } = await pendingPurchase()
    stubByPath({
      orders: {
        id: 'ORD05',
        status: 'processed',
        external_reference: purchase.externalReference,
        total_paid_amount: '4990.00',
        transactions: { payments: [{ id: '777666' }] },
      },
      payments: {
        id: 777666,
        status: 'approved',
        transaction_amount: 4990,
        external_reference: purchase.externalReference,
      },
    })

    const viaOrder = (await (await notify('ORD05', { topic: 'order', action: 'order.processed' })).json()) as {
      data: { handled: boolean }
    }
    const viaPayment = (await (await notify('777666')).json()) as { data: { handled: boolean } }

    expect(viaOrder.data.handled).toBe(true)
    // Keyed on the payment id, so the same money arriving down the other channel is already known.
    expect(viaPayment.data.handled).toBe(false)
    const events = await env.DB.prepare('SELECT count(*) AS total FROM payment_events').first<{ total: number }>()
    expect(events?.total).toBe(1)
  })

  it('ends the entitlement on an order that was charged back', async () => {
    const { product, purchase } = await pendingPurchase()
    stubByPath({
      orders: {
        id: 'ORD06',
        status: 'charged_back',
        external_reference: purchase.externalReference,
        transactions: { payments: [{ id: '555444' }] },
      },
    })

    await notify('ORD06', { topic: 'order', action: 'order.charged_back' })

    expect((await purchaseRow(purchase.id))?.status).toBe('charged_back')
    const access = await SELF.fetch(`https://marketplace.test/products/${product.slug}/access`)
    expect(((await access.json()) as { data: { can_download: boolean } }).data.can_download).toBe(false)
  })
})

describe('POST /payments/mercadopago/webhook · chargebacks', () => {
  beforeEach(clearDatabase)

  const approvedPurchase = async () => {
    const product = await seedProduct({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const purchase = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      status: 'approved',
      paymentId: '81968653106',
    })
    return { product, purchase }
  }

  it('takes the download away and records the dispute', async () => {
    const { product, purchase } = await approvedPurchase()
    stubByPath({
      chargebacks: {
        id: 233000061680860000,
        payments: [81968653106],
        amount: '4990.00',
        currency: 'CLP',
        coverage_applied: false,
        documentation_status: 'pending',
      },
    })

    const response = await notify('233000061680860000', {
      topic: 'topic_chargebacks_wh',
      paymentId: '81968653106',
    })

    expect(response.status).toBe(200)
    const row = await purchaseRow(purchase.id)
    expect(row?.status).toBe('charged_back')
    expect(row?.chargeback_id).toBe('233000061680860000')
    expect(row?.charged_back_at).not.toBeNull()
    // The approval is kept beside it: "this was paid, and then it was taken back" is what a dispute
    // needs to be able to say.
    expect(row?.approved_at).not.toBeNull()

    const access = await SELF.fetch(`https://marketplace.test/products/${product.slug}/access`, {
      headers: await asBuyer(),
    })
    expect(((await access.json()) as { data: { has_paid: boolean } }).data.has_paid).toBe(false)
  })

  it('does not overwrite what the person paid with the disputed amount', async () => {
    const { purchase } = await approvedPurchase()
    stubByPath({
      chargebacks: { id: 900, payments: [81968653106], amount: '1000.00', currency: 'CLP' },
    })

    await notify('900', { topic: 'topic_chargebacks_wh', paymentId: '81968653106' })

    expect((await purchaseRow(purchase.id))?.amount).toBe(4990)
  })

  it('finds the payment from the chargeback when the notification does not name it', async () => {
    const { purchase } = await approvedPurchase()
    stubByPath({ chargebacks: { id: 901, payments: [81968653106] } })

    await notify('901', { topic: 'topic_chargebacks_wh' })

    expect((await purchaseRow(purchase.id))?.status).toBe('charged_back')
  })

  it('collapses onto the payment topic\'s own charged_back notification', async () => {
    const { purchase } = await approvedPurchase()
    stubByPath({
      chargebacks: { id: 902, payments: [81968653106] },
      payments: { id: 81968653106, status: 'charged_back', external_reference: purchase.externalReference },
    })

    const viaChargeback = (await (await notify('902', { topic: 'topic_chargebacks_wh', paymentId: '81968653106' })).json()) as {
      data: { handled: boolean }
    }
    const viaPayment = (await (await notify('81968653106', { requestId: 'req-2' })).json()) as {
      data: { handled: boolean }
    }

    expect(viaChargeback.data.handled).toBe(true)
    expect(viaPayment.data.handled).toBe(false)
  })

  it('still requires a valid signature', async () => {
    const { purchase } = await approvedPurchase()
    stubByPath({ chargebacks: { id: 903, payments: [81968653106] } })

    expect((await notify('903', { topic: 'topic_chargebacks_wh', signed: false })).status).toBe(401)
    expect((await purchaseRow(purchase.id))?.status).toBe('approved')
  })
})
