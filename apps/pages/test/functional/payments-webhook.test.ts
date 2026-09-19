import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, seedApplication, seedPurchase } from '../helpers/db'

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

const notify = async (
  paymentId: string,
  options: { signed?: boolean; requestId?: string; topic?: string } = {},
) => {
  const requestId = options.requestId ?? 'req-1'
  const ts = '1700000000'
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-request-id': requestId }
  if (options.signed !== false) {
    headers['x-signature'] = `ts=${ts},v1=${await hmac(`id:${paymentId};request-id:${requestId};ts:${ts};`)}`
  }

  return SELF.fetch('https://pages.test/payments/mercadopago/webhook', {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: options.topic ?? 'payment', data: { id: paymentId } }),
  })
}

const purchaseRow = (id: string) =>
  env.DB.prepare('SELECT status, payment_id, amount, approved_at FROM purchases WHERE id = ?')
    .bind(id)
    .first<{ status: string; payment_id: string | null; amount: number; approved_at: number | null }>()

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /payments/mercadopago/webhook', () => {
  beforeEach(clearDatabase)

  const pendingPurchase = async () => {
    const application = await seedApplication({ slug: 'openbattery', pricingMode: 'paid', priceAmount: 4990 })
    const purchase = await seedPurchase({
      applicationId: application.id,
      applicationSlug: application.slug,
      status: 'pending',
      approvedAt: null,
    })
    return { application, purchase }
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
    const response = await SELF.fetch('https://pages.test/payments/mercadopago/webhook', {
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
    const { application, purchase } = await pendingPurchase()
    stubPayment({ id: 995, status: 'rejected', external_reference: purchase.externalReference })

    await notify('995')

    expect((await purchaseRow(purchase.id))?.status).toBe('rejected')
    const access = await SELF.fetch(`https://pages.test/applications/${application.slug}/access`)
    expect(((await access.json()) as { data: { can_download: boolean } }).data.can_download).toBe(false)
  })
})
