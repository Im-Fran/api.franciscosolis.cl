import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { paymentEvents } from '@/db/schema'
import type { AppEnv } from '@/env'
import { isUniqueViolation } from '@/lib/errors'
import { getPayment, mapPaymentStatus, verifyWebhookSignature } from '@/lib/mercadopago'
import { applyPaymentStatus, findPurchaseByPaymentId, findPurchaseByReference } from '@/services/purchases'

/**
 * The provider's way back in.
 *
 * This is the only unauthenticated **write** endpoint in this Worker, and the three things guarding it
 * are worth reading before touching any of them:
 *
 * 1. **The signature.** MercadoPago signs a fixed manifest with the secret from its dashboard
 *    (`verifyWebhookSignature`). Without a configured secret every notification is refused — failing
 *    closed is the only safe direction for an endpoint that can grant a licence.
 * 2. **The body is not evidence.** Nothing here reads a status out of the request. The notification
 *    says which payment changed; the *status* comes from asking MercadoPago about that payment with
 *    our own credential. Anyone can post a body claiming a payment was approved.
 * 3. **It is idempotent.** MercadoPago retries until it gets a 2xx and sends several notifications per
 *    payment, so the transition is recorded under a `<payment>:<status>` key on a unique index and a
 *    repeat is a no-op that still answers 200. Answering anything else would make it retry forever.
 *
 * A notification for a payment we have never heard of also answers 200. It is not an error on our
 * side, and a 4xx would have the provider retrying a notification that will never become relevant.
 */
const app = new Hono<AppEnv>()

/**
 * What the notification is about, from wherever MercadoPago put it this time.
 *
 * It sends `topic`/`type` and `data.id` in the body for a webhook, and `topic`/`id` in the query for
 * the older IPN shape. Both are read because both arrive, and which one a given account is configured
 * for is dashboard configuration this repo cannot see.
 */
const readNotification = async (c: { req: { json: () => Promise<unknown>; query: (key: string) => string | undefined } }) => {
  let body: Record<string, unknown> = {}
  try {
    body = ((await c.req.json()) ?? {}) as Record<string, unknown>
  } catch {
    // An empty or unparseable body is normal for the query-string form.
  }

  const data = (body.data ?? {}) as Record<string, unknown>
  const dataId = typeof data.id === 'string' || typeof data.id === 'number' ? String(data.id) : c.req.query('data.id') ?? c.req.query('id')
  const topic = (typeof body.type === 'string' ? body.type : undefined) ?? (typeof body.topic === 'string' ? body.topic : undefined) ?? c.req.query('topic') ?? c.req.query('type')

  return { topic, dataId, body }
}

/** Records the transition, or reports that it was already recorded. */
const claimEvent = async (
  db: Database,
  input: { eventId: string; topic: string | undefined; paymentId: string; purchaseId: string | null; status: string; payload: unknown },
): Promise<boolean> => {
  try {
    await db.insert(paymentEvents).values({
      id: crypto.randomUUID(),
      provider: 'mercadopago',
      eventId: input.eventId,
      topic: input.topic ?? null,
      paymentId: input.paymentId,
      purchaseId: input.purchaseId,
      status: input.status,
      payload: JSON.stringify(input.payload),
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false
    }
    throw error
  }
}

app.post(
  '/payments/mercadopago/webhook',
  describeRoute({
    description:
      'MercadoPago payment notifications. Requires a valid `x-signature` for the configured webhook secret; the status is then read from the provider\'s API rather than from the request body. Idempotent per payment-and-status, and it answers 200 for a payment it does not recognise so the provider stops retrying.',
    tags: ['Store'],
    responses: {
      200: { description: 'The notification was processed, or was one we had already seen' },
      401: { description: 'Missing or invalid signature' },
      503: { description: 'Payments are not configured on this service' },
    },
  }),
  async (c) => {
    const { topic, dataId, body } = await readNotification(c)

    if (!c.env.MERCADOPAGO_WEBHOOK_SECRET) {
      // Fails closed. A Worker that accepted unsigned notifications because a secret was missing is a
      // Worker that hands out licences to whoever finds the URL.
      throw new HTTPException(503, { message: 'Payments are not configured on this service' })
    }

    const signed = await verifyWebhookSignature(c.env.MERCADOPAGO_WEBHOOK_SECRET, {
      signature: c.req.header('x-signature'),
      requestId: c.req.header('x-request-id'),
      dataId,
    })
    if (!signed) {
      throw new HTTPException(401, { message: 'The notification signature could not be verified' })
    }

    // Only payment notifications say anything about an entitlement. Merchant orders and plan events
    // are acknowledged and dropped rather than refused, so the provider does not keep resending them.
    if (!dataId || (topic !== undefined && topic !== 'payment' && topic !== 'payment.updated')) {
      return c.json({ code: 200, data: { received: true, handled: false } })
    }

    const payment = await getPayment(c.env, dataId)
    const status = mapPaymentStatus(payment.status)
    const db = getDb(c.env)

    const purchase = payment.external_reference
      ? await findPurchaseByReference(db, payment.external_reference)
      : await findPurchaseByPaymentId(db, String(payment.id))

    const fresh = await claimEvent(db, {
      eventId: `${payment.id}:${status}`,
      topic,
      paymentId: String(payment.id),
      purchaseId: purchase?.id ?? null,
      status,
      // The provider's payload, trimmed to what was acted on. Never the headers, which carry the
      // signature, and never the raw body, which carries more of the payer than this needs to keep.
      payload: {
        id: payment.id,
        status: payment.status,
        status_detail: payment.status_detail,
        transaction_amount: payment.transaction_amount,
        currency_id: payment.currency_id,
        external_reference: payment.external_reference,
        notification: { topic, data_id: dataId, type: (body as { type?: unknown }).type },
      },
    })

    if (!purchase) {
      console.warn('mercadopago notification for an unknown purchase', payment.id, payment.external_reference)
      return c.json({ code: 200, data: { received: true, handled: false } })
    }

    if (fresh) {
      await applyPaymentStatus(db, purchase, {
        status,
        paymentId: String(payment.id),
        // The amount MercadoPago settled, which is the amount that matters on a receipt — a donor who
        // edited the total on the checkout would otherwise be recorded as having paid what we asked.
        amount: typeof payment.transaction_amount === 'number' ? Math.round(payment.transaction_amount) : null,
      })
    }

    return c.json({ code: 200, data: { received: true, handled: fresh } })
  },
)

export default app
