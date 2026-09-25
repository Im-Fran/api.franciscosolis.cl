import { env, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSender } from '@/env'
import { clearDatabase, seedProduct, seedPurchase, seedRelease, seedReview } from '../helpers/db'
import { captureNotifications, failNotifications } from '../helpers/queue'
import { asEditor } from '../helpers/tokens'

/**
 * What this Worker publishes for `apps/notifications`. The receipt and the refund notice are asserted
 * elsewhere and must not change; every test here only adds the bell beside them.
 */

const admin = async (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://marketplace.test/admin${path}`, { ...init, headers: { ...(await asEditor()), ...init.headers } })

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

/** A signed `payment` notification, with the provider's read of the payment stubbed behind it. */
const webhook = async (paymentId: string, payment: Record<string, unknown>, requestId = 'req-1') => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payment)))
  const ts = '1700000000'
  return SELF.fetch('https://marketplace.test/payments/mercadopago/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-signature': `ts=${ts},v1=${await hmac(`id:${paymentId};request-id:${requestId};ts:${ts};`)}`,
    },
    body: JSON.stringify({ type: 'payment', data: { id: paymentId } }),
  })
}

let queue: ReturnType<typeof captureNotifications>
let realEmail: EmailSender

beforeEach(async () => {
  await clearDatabase()
  queue = captureNotifications()
  // The receipts go somewhere harmless; what they say is `admin-sales.test.ts`'s business.
  realEmail = env.EMAIL
  ;(env as { EMAIL: EmailSender }).EMAIL = { send: vi.fn(async () => ({ messageId: 'test' })) } as unknown as EmailSender
})

afterEach(() => {
  queue.restore()
  ;(env as { EMAIL: EmailSender }).EMAIL = realEmail
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('marketplace.purchase_completed', () => {
  const pendingPurchase = async () => {
    const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery', pricingMode: 'paid', priceAmount: 4990 })
    const purchase = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      status: 'pending',
      approvedAt: null,
      userId: 'buyer-7',
      email: 'buyer@example.com',
      metadata: JSON.stringify({ product_name: 'OpenBattery', locale: 'es' }),
    })
    return { product, purchase }
  }

  it('is published when the webhook approves a payment, with the amount as the receipt prints it', async () => {
    const { purchase } = await pendingPurchase()

    const response = await webhook('501', {
      id: 501,
      status: 'approved',
      transaction_amount: 4990,
      external_reference: purchase.externalReference,
    })

    expect(response.status).toBe(200)
    expect(queue.sent).toHaveLength(1)
    const [event] = queue.sent
    expect(event).toMatchObject({
      version: 1,
      type: 'marketplace.purchase_completed',
      user: { id: 'buyer-7', email: 'buyer@example.com', locale: 'es' },
      data: { product_name: 'OpenBattery', product_slug: 'openbattery' },
      url: '/account/purchases',
    })
    // `es-CL` groups thousands with a dot; the exact currency sign is the runtime's business.
    expect(String(event?.data.amount)).toContain('4.990')
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is published once when the same approval is notified twice', async () => {
    const { purchase } = await pendingPurchase()
    const payment = { id: 502, status: 'approved', transaction_amount: 4990, external_reference: purchase.externalReference }

    await webhook('502', payment)
    // A retry of the same transition. The event key makes it a no-op today; the transition guard in
    // the webhook is what would still hold if a second channel ever produced a fresh key for it.
    await webhook('502', { ...payment, status: 'approved' }, 'req-2')

    expect(queue.ofType('marketplace.purchase_completed')).toHaveLength(1)
  })

  it('publishes a refund made in the provider\'s console', async () => {
    const { purchase } = await pendingPurchase()
    await webhook('503', { id: 503, status: 'approved', transaction_amount: 4990, external_reference: purchase.externalReference })
    await webhook(
      '503',
      { id: 503, status: 'refunded', transaction_amount: 4990, external_reference: purchase.externalReference },
      'req-2',
    )

    expect(queue.ofType('marketplace.purchase_refunded')).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: 'buyer-7' }), url: '/account/purchases' }),
    ])
  })

  it('still answers the webhook 200 and approves the payment when the queue is down', async () => {
    queue.restore()
    const outage = failNotifications()
    const { purchase } = await pendingPurchase()

    try {
      const response = await webhook('504', {
        id: 504,
        status: 'approved',
        transaction_amount: 4990,
        external_reference: purchase.externalReference,
      })
      expect(response.status).toBe(200)
    } finally {
      outage.restore()
    }
    const row = await env.DB.prepare('SELECT status FROM purchases WHERE id = ?').bind(purchase.id).first<{ status: string }>()
    expect(row?.status).toBe('approved')
  })

  describe('a sale recorded by hand', () => {
    const record = (productId: string, payload: Record<string, unknown>) =>
      admin(`/products/${productId}/sales`, { method: 'POST', body: JSON.stringify(payload) })

    it('is published for the account it names', async () => {
      const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })

      const response = await record(product.id, {
        email: 'cash.buyer@example.com',
        user_id: 'buyer-9',
        source: 'cash',
        amount: 4990,
        locale: 'en',
      })

      expect(response.status).toBe(201)
      expect(queue.sent).toEqual([
        expect.objectContaining({
          type: 'marketplace.purchase_completed',
          user: expect.objectContaining({ id: 'buyer-9', email: 'cash.buyer@example.com', locale: 'en' }),
          data: expect.objectContaining({ product_name: 'OpenBattery', product_slug: 'openbattery' }),
        }),
      ])
      expect(String(queue.sent[0]?.data.amount)).toContain('4,990')
    })

    it('publishes nothing for an address with no account yet', async () => {
      const product = await seedProduct()

      expect((await record(product.id, { email: 'someone@example.com', source: 'cash', amount: 100 })).status).toBe(201)

      expect(queue.sent).toHaveLength(0)
    })

    it('publishes nothing when the editor asked not to tell the buyer', async () => {
      const product = await seedProduct()

      await record(product.id, { email: 'gift@example.com', user_id: 'buyer-9', source: 'gift', amount: 0, notify: false })

      expect(queue.sent).toHaveLength(0)
    })

    it('records the sale when the queue is down', async () => {
      queue.restore()
      const outage = failNotifications()
      const product = await seedProduct()

      try {
        const response = await record(product.id, { email: 'b@example.com', user_id: 'buyer-9', source: 'cash', amount: 100 })
        expect(response.status).toBe(201)
      } finally {
        outage.restore()
      }
    })
  })
})

describe('marketplace.purchase_refunded', () => {
  it('is published beside the refund notice, with the amount that went back', async () => {
    const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
    const sale = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      source: 'cash',
      provider: 'manual',
      environment: 'sandbox',
      userId: 'buyer-3',
      amount: 10_000,
    })

    const response = await admin(`/products/${product.id}/sales/${sale.id}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'withdrawal', amount: 5000 }),
    })

    expect(response.status).toBe(200)
    expect(env.EMAIL.send).toHaveBeenCalledTimes(1)
    const [event] = queue.ofType('marketplace.purchase_refunded')
    expect(event).toMatchObject({ user: { id: 'buyer-3' }, data: { product_name: 'OpenBattery' } })
    expect(String(event?.data.amount)).toContain('5')
    expect(String(event?.data.amount)).not.toContain('10')
  })

  it('publishes nothing for a sale with no account behind it', async () => {
    const product = await seedProduct()
    const sale = await seedPurchase({
      productId: product.id,
      productSlug: product.slug,
      source: 'cash',
      provider: 'manual',
      environment: 'sandbox',
      userId: '',
    })

    await admin(`/products/${product.id}/sales/${sale.id}/refund`, { method: 'POST', body: JSON.stringify({ reason: 'other' }) })

    expect(queue.sent).toHaveLength(0)
  })
})

describe('marketplace.release_published', () => {
  const holders = async (productId: string, productSlug: string) => {
    await seedPurchase({ productId, productSlug, userId: 'buyer-1', email: 'one@example.com' })
    // A second purchase by the same account: one person, told once.
    await seedPurchase({ productId, productSlug, userId: 'buyer-1', email: 'one@example.com', kind: 'donation' })
    await seedPurchase({ productId, productSlug, userId: 'buyer-2', email: 'two@example.com' })
    // Not holders: a refunded purchase, a pending one, and a hand-recorded sale with no account.
    await seedPurchase({ productId, productSlug, userId: 'buyer-3', status: 'refunded' })
    await seedPurchase({ productId, productSlug, userId: 'buyer-4', status: 'pending', approvedAt: null })
    await seedPurchase({ productId, productSlug, userId: '', email: 'cash@example.com' })
  }

  it('is published to every account holding the product when a release is created live', async () => {
    const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
    await holders(product.id, product.slug)

    const response = await admin(`/products/${product.id}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '2.7.0', channel: 'beta', title: 'Beta', status: 'published' }),
    })

    expect(response.status).toBe(201)
    expect(queue.sent.map((event) => event.user.id).sort()).toEqual(['buyer-1', 'buyer-2'])
    expect(queue.sent[0]).toMatchObject({
      version: 1,
      type: 'marketplace.release_published',
      data: { product_name: 'OpenBattery', product_slug: 'openbattery', version: '2.7.0', channel: 'beta' },
      url: '/product/openbattery',
    })
    // Two separate ids: the consumer deduplicates per message, not per release.
    expect(new Set(queue.sent.map((event) => event.id)).size).toBe(2)
  })

  it('publishes nothing for a draft, and then once when it goes live', async () => {
    const product = await seedProduct()
    await holders(product.id, product.slug)

    const created = await admin(`/products/${product.id}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '3.0.0', title: 'Three', status: 'draft' }),
    })
    const { data } = (await created.json()) as { data: { id: string } }
    expect(queue.sent).toHaveLength(0)

    const patch = (status: string) =>
      admin(`/products/${product.id}/releases/${data.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })

    await patch('published')
    expect(queue.sent).toHaveLength(2)

    // Taken down and put back: not news.
    await patch('archived')
    await patch('published')
    expect(queue.sent).toHaveLength(2)
  })

  it('publishes nothing for an edit to a release that was already live', async () => {
    const product = await seedProduct()
    await holders(product.id, product.slug)
    const release = await seedRelease({ productId: product.id })

    await admin(`/products/${product.id}/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Typo' }) })

    expect(queue.sent).toHaveLength(0)
  })

  it('publishes nothing for the release of a product that is not public', async () => {
    const product = await seedProduct({ status: 'draft' })
    await holders(product.id, product.slug)

    await admin(`/products/${product.id}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '1.0.0', title: 'One', status: 'published' }),
    })

    expect(queue.sent).toHaveLength(0)
  })

  it('sends a large audience in batches of at most a hundred', async () => {
    const product = await seedProduct()
    for (let index = 0; index < 205; index += 1) {
      await seedPurchase({ productId: product.id, productSlug: product.slug, userId: `buyer-${index}` })
    }

    await admin(`/products/${product.id}/releases`, {
      method: 'POST',
      body: JSON.stringify({ version: '9.9.9', title: 'Big', status: 'published' }),
    })

    expect(queue.batches).toEqual([100, 100, 5])
    expect(queue.sent).toHaveLength(205)
  })

  it('still saves the release when the queue is down', async () => {
    queue.restore()
    const outage = failNotifications()
    const product = await seedProduct()
    await holders(product.id, product.slug)

    try {
      const response = await admin(`/products/${product.id}/releases`, {
        method: 'POST',
        body: JSON.stringify({ version: '4.0.0', title: 'Four', status: 'published' }),
      })
      expect(response.status).toBe(201)
    } finally {
      outage.restore()
    }
  })
})

describe('marketplace.review_reply', () => {
  it('is published to the review\'s author on the first answer, and not on an edit', async () => {
    const product = await seedProduct({ slug: 'openbattery', name: 'OpenBattery' })
    const review = await seedReview({ productId: product.id, userId: 'reviewer-1', email: 'r@example.com', authorName: 'Ada' })
    const path = `/products/${product.id}/reviews/${review.id}/reply`

    expect((await admin(path, { method: 'PUT', body: JSON.stringify({ body: 'Thanks!' }) })).status).toBe(200)
    await admin(path, { method: 'PUT', body: JSON.stringify({ body: 'Thanks! Fixed in 2.7.' }) })

    expect(queue.sent).toEqual([
      expect.objectContaining({
        version: 1,
        type: 'marketplace.review_reply',
        user: expect.objectContaining({ id: 'reviewer-1', email: 'r@example.com', name: 'Ada' }),
        data: { product_name: 'OpenBattery', product_slug: 'openbattery' },
        url: '/product/openbattery',
      }),
    ])
  })

  it('saves the reply when the queue is down', async () => {
    queue.restore()
    const outage = failNotifications()
    const product = await seedProduct()
    const review = await seedReview({ productId: product.id })

    try {
      const response = await admin(`/products/${product.id}/reviews/${review.id}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ body: 'Thanks!' }),
      })
      expect(response.status).toBe(200)
    } finally {
      outage.restore()
    }
  })
})
