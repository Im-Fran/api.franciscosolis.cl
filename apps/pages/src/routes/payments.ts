import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { paymentEvents } from '@/db/schema'
import type { AppEnv, Env } from '@/env'
import type { PurchaseStatus } from '@/lib/config'
import { isUniqueViolation } from '@/lib/errors'
import {
  getChargeback,
  getOrder,
  getPayment,
  mapOrderStatus,
  mapPaymentStatus,
  orderPaymentIds,
  toAmount,
  TOPICS,
  verifyWebhookSignature,
} from '@/lib/mercadopago'
import {
  applyPaymentStatus,
  findPurchaseByAnyPaymentId,
  findPurchaseByPaymentId,
  findPurchaseByReference,
  type Purchase,
} from '@/services/purchases'
import { issueVoucherForApproval } from '@/services/vouchers'

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
 *    says *which* resource changed; what it changed *to* comes from reading that resource back with
 *    our own credential. Anybody can post a body claiming an approval.
 * 3. **It is idempotent.** MercadoPago retries until it gets a 2xx and sends several notifications per
 *    payment, so the transition is recorded under a unique key and a repeat is a no-op that still
 *    answers 200 — anything else has it retrying forever.
 *
 * **Three topics, two generations of API.** `payment` is the classic notification; `order` is the
 * orders API that replaces it; `topic_chargebacks_wh` is the classic dispute topic. All three are
 * accepted so that switching the dashboard from "Pagos (legacy)" to "Order" is a checkbox rather than
 * an outage. Where two of them describe the same money — an order and the payment inside it — the
 * idempotency key is built from the **payment id** wherever one is known, so the same transition
 * arriving down both channels is applied once and logged once.
 *
 * A notification for something we have never heard of also answers 200. It is not an error on our
 * side, and a 4xx would have the provider retrying a notification that will never become relevant.
 *
 * **The approval is also where the receipt comes from.** A payment that settles issues and emails a
 * voucher, which is the only moment at which anybody knows both that the money arrived and what
 * language the buyer was reading in. That send can fail — a mail binding is one more thing that can
 * be down — and it must not turn a notification into a retry: `issueVoucherForApproval` swallows its
 * own failures and leaves the sale with no live voucher, which is a state the editor can see on the
 * Sales screen and fix with one click. Re-applying a payment that was already applied would be far
 * worse than a receipt that has to be re-sent.
 */
const app = new Hono<AppEnv>()

/** What a notification names, once read out of whichever shape it arrived in. */
type Notification = {
  topic: string | undefined
  /** The `action` field, e.g. `order.charged_back`. Logged; never used to decide a status. */
  action: string | undefined
  dataId: string | undefined
  /** `data.payment_id`, which only the chargeback topic carries. */
  paymentId: string | undefined
}

const asId = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined

/**
 * Reads the notification out of the body, falling back to the query string.
 *
 * MercadoPago sends `type`/`topic` plus `data.id` in the body for a webhook, and `topic`/`id` in the
 * query for the older IPN shape. Both are read because both arrive, and which one a given account is
 * configured for is dashboard configuration this repo cannot see.
 */
const readNotification = async (c: {
  req: { json: () => Promise<unknown>; query: (key: string) => string | undefined }
}): Promise<Notification & { body: Record<string, unknown> }> => {
  let body: Record<string, unknown> = {}
  try {
    body = ((await c.req.json()) ?? {}) as Record<string, unknown>
  } catch {
    // An empty or unparseable body is normal for the query-string form.
  }

  const data = (body.data ?? {}) as Record<string, unknown>
  const dataId = asId(data.id) ?? c.req.query('data.id') ?? c.req.query('id')
  const topic =
    (typeof body.type === 'string' ? body.type : undefined) ??
    (typeof body.topic === 'string' ? body.topic : undefined) ??
    c.req.query('topic') ??
    c.req.query('type')

  return {
    topic,
    action: typeof body.action === 'string' ? body.action : undefined,
    dataId,
    paymentId: asId(data.payment_id),
    body,
  }
}

/** What one topic's handler resolved the notification into. */
type Resolution = {
  purchase: Purchase | null
  status: PurchaseStatus
  /** Identity of this transition, for the idempotency index. */
  eventKey: string
  paymentId: string | null
  chargebackId: string | null
  amount: number | null
  /** Trimmed provider payload, for the event log. */
  payload: Record<string, unknown>
}

/**
 * Records the transition, or reports that it was already recorded.
 *
 * The unique index on `(provider, event_id)` is what collapses a retry. Anything other than a unique
 * violation is re-raised: a database that is failing must not look like a duplicate notification.
 */
const claimEvent = async (
  db: Database,
  input: { eventId: string; topic: string | undefined; paymentId: string | null; purchaseId: string | null; status: string; payload: unknown },
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

/**
 * The classic payment notification.
 *
 * `external_reference` is our own purchase id, round-tripped through the preference, so it is the
 * first way back to the row. A payment that lost it — one taken through a preference created before
 * this Worker existed — is still matched by its payment id.
 */
const resolvePayment = async (env: Env, db: Database, dataId: string): Promise<Resolution> => {
  const payment = await getPayment(env, dataId)
  const status = mapPaymentStatus(payment.status)
  const paymentId = String(payment.id)

  const purchase = payment.external_reference
    ? await findPurchaseByReference(db, payment.external_reference)
    : await findPurchaseByPaymentId(db, paymentId)

  return {
    purchase,
    status,
    eventKey: `${paymentId}:${status}`,
    paymentId,
    chargebackId: null,
    amount: toAmount(payment.transaction_amount),
    payload: {
      id: payment.id,
      status: payment.status,
      status_detail: payment.status_detail,
      transaction_amount: payment.transaction_amount,
      currency_id: payment.currency_id,
      external_reference: payment.external_reference,
    },
  }
}

/**
 * The orders API notification, which is what replaces the one above.
 *
 * The order's own `status` is what decides — `processed` is this API's word for "the money is in" —
 * and the payment inside it is used for the idempotency key so that an account with *both* dashboard
 * topics enabled applies the transition once rather than twice. An order with no payment yet (one
 * still `created`, or expired unpaid) has no payment id to key on, so it keys on the order.
 */
const resolveOrder = async (env: Env, db: Database, dataId: string): Promise<Resolution> => {
  const order = await getOrder(env, dataId)
  const status = mapOrderStatus(order.status)
  const paymentIds = orderPaymentIds(order)
  const paymentId = paymentIds[0] ?? null

  const purchase = order.external_reference
    ? await findPurchaseByReference(db, order.external_reference)
    : await findPurchaseByAnyPaymentId(db, paymentIds)

  return {
    purchase,
    status,
    eventKey: paymentId ? `${paymentId}:${status}` : `order:${order.id}:${status}`,
    paymentId,
    chargebackId: null,
    // What was actually collected, not what was asked for: a donor who edited the total on the
    // checkout paid what they paid.
    amount: toAmount(order.total_paid_amount) ?? toAmount(order.total_amount),
    payload: {
      id: order.id,
      status: order.status,
      status_detail: order.status_detail,
      external_reference: order.external_reference,
      total_paid_amount: order.total_paid_amount,
      payments: paymentIds,
    },
  }
}

/**
 * The classic chargeback topic.
 *
 * Unlike the other two this one does not carry a status worth mapping: a chargeback exists, therefore
 * the money is gone and the entitlement with it. `coverage_applied` says whether MercadoPago absorbed
 * the loss, which matters to the accounts and not at all to the download — recorded, never acted on.
 *
 * The disputed payment comes from the notification when it is there and from the chargeback otherwise,
 * and the key is that payment's, so the `charged_back` that also arrives on the payment or order topic
 * collapses onto this one.
 */
const resolveChargeback = async (
  env: Env,
  db: Database,
  dataId: string,
  notifiedPaymentId: string | undefined,
): Promise<Resolution> => {
  const chargeback = await getChargeback(env, dataId)
  const paymentIds = [notifiedPaymentId, ...(chargeback.payments ?? []).map(String)].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
  const paymentId = paymentIds[0] ?? null

  return {
    purchase: await findPurchaseByAnyPaymentId(db, paymentIds),
    status: 'charged_back',
    eventKey: paymentId ? `${paymentId}:charged_back` : `chargeback:${chargeback.id}`,
    paymentId,
    chargebackId: String(chargeback.id),
    // Deliberately not written onto the row: the disputed amount can differ from what was charged,
    // and overwriting the purchase's own amount with it would misstate what the person paid.
    amount: null,
    payload: {
      id: chargeback.id,
      payments: chargeback.payments,
      amount: chargeback.amount,
      currency: chargeback.currency,
      coverage_applied: chargeback.coverage_applied,
      documentation_status: chargeback.documentation_status,
      status: chargeback.status,
    },
  }
}

/** Whether this topic says anything about an entitlement. Everything else is acknowledged and dropped. */
const isActionable = (topic: string | undefined): boolean =>
  topic === TOPICS.payment ||
  topic === 'payment.updated' ||
  topic === TOPICS.order ||
  topic === TOPICS.chargeback

app.post(
  '/payments/mercadopago/webhook',
  describeRoute({
    description:
      'MercadoPago notifications: the classic `payment` topic, the orders API\'s `order` topic and the `topic_chargebacks_wh` dispute topic. Requires a valid `x-signature` for the configured webhook secret; the status is then read from the provider\'s API rather than from the request body. Idempotent per payment-and-status across all three topics, and it answers 200 for anything it does not recognise so the provider stops retrying.',
    tags: ['Store'],
    responses: {
      200: { description: 'The notification was processed, or was one we had already seen' },
      401: { description: 'Missing or invalid signature' },
      503: { description: 'Payments are not configured on this service' },
    },
  }),
  async (c) => {
    const { topic, action, dataId, paymentId: notifiedPaymentId } = await readNotification(c)

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
      // Logged with its topic: the manifest for the orders API is not settled upstream (see
      // `lib/mercadopago.ts`), so "orders are refused and payments are not" is the shape of that bug,
      // and it is invisible without this line.
      console.warn('mercadopago notification refused: signature did not verify', topic, action)
      throw new HTTPException(401, { message: 'The notification signature could not be verified' })
    }

    if (!dataId || !isActionable(topic)) {
      return c.json({ code: 200, data: { received: true, handled: false } })
    }

    const db = getDb(c.env)
    const resolved =
      topic === TOPICS.order
        ? await resolveOrder(c.env, db, dataId)
        : topic === TOPICS.chargeback
          ? await resolveChargeback(c.env, db, dataId, notifiedPaymentId)
          : await resolvePayment(c.env, db, dataId)

    const fresh = await claimEvent(db, {
      eventId: resolved.eventKey,
      topic,
      paymentId: resolved.paymentId,
      purchaseId: resolved.purchase?.id ?? null,
      status: resolved.status,
      // The provider's payload, trimmed to what was acted on. Never the request headers, which carry
      // the signature, and never the raw body, which carries more of the payer than this needs to keep.
      payload: { ...resolved.payload, notification: { topic, action, data_id: dataId } },
    })

    if (!resolved.purchase) {
      console.warn('mercadopago notification for an unknown purchase', topic, dataId)
      return c.json({ code: 200, data: { received: true, handled: false } })
    }

    if (fresh) {
      const updated = await applyPaymentStatus(db, resolved.purchase, {
        status: resolved.status,
        paymentId: resolved.paymentId,
        amount: resolved.amount,
        chargebackId: resolved.chargebackId,
      })

      if (updated.status === 'approved') {
        // The application's name and the buyer's language were snapshotted onto the purchase at
        // checkout, which is what lets the receipt be written here — the browser that knew either of
        // them is long gone, and this Worker holds no session for the buyer.
        const metadata = updated.metadata
          ? (JSON.parse(updated.metadata) as { application_name?: unknown; locale?: unknown })
          : {}
        await issueVoucherForApproval(db, c.env, {
          purchase: updated,
          applicationName:
            typeof metadata.application_name === 'string' ? metadata.application_name : updated.applicationSlug,
          locale: typeof metadata.locale === 'string' ? metadata.locale : null,
        })
      }
    }

    return c.json({ code: 200, data: { received: true, handled: fresh } })
  },
)

export default app
