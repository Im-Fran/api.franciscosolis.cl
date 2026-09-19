import type { Env } from '@/env'
import type { PurchaseStatus } from '@/lib/config'
import { CURRENCY } from '@/lib/pricing'
import { type PaymentEnvironment, parsePaymentEnvironment } from '@/lib/sales'

/**
 * The MercadoPago half of the payment flow: Checkout Pro, and nothing else.
 *
 * **Checkout Pro rather than the Checkout API.** A card form on franciscosolis.cl would put this
 * monorepo on the path of card data — tokenisation in the browser, 3-D Secure to carry, and a PCI
 * scope for a product page. Checkout Pro is a preference created here and a redirect away, so the
 * only thing that ever reaches this Worker is a payment id.
 *
 * **The notification is never believed on its own.** A webhook body says "payment 123 changed"; what
 * the status *is* comes from asking MercadoPago about payment 123 with our own credential. That is
 * not belt-and-braces: the notification endpoint is public, and treating its body as the truth would
 * let anybody with the URL approve their own purchase. The signature check below is the first gate
 * and the payment fetch is the second, and the second is the one that decides.
 *
 * **CLP has no minor unit**, so `unit_price` is the amount itself. Sending 1990.0 for 1990 pesos is
 * correct here and would be 19.90 anywhere with cents — which is why every amount in this Worker is
 * an integer and never a float.
 *
 * **Two generations of notification, on purpose.** MercadoPago is midway through replacing the
 * payment-centric model with an order-centric one, and the dashboard offers both as separate
 * checkboxes ("Pagos (legacy)" and "Order (Mercado Pago)"). This module reads all of them:
 *
 * - `payment` — `GET /v1/payments/{id}`, the classic notification. Still what Checkout Pro sends today.
 * - `order` — `GET /v1/orders/{id}`, the replacement. One order wraps the payments that settled it,
 *   and `order.charged_back` is how a dispute arrives in that model.
 * - `topic_chargebacks_wh` — `GET /v1/chargebacks/{id}`, the classic chargeback topic, which carries
 *   the disputed `payment_id` in the notification itself.
 *
 * Supporting all three costs one `switch`, and it is what makes the day "Pagos (legacy)" is switched
 * off a configuration change rather than an outage in which payments silently stop being credited.
 * Preferences are deliberately *not* migrated: `POST /checkout/preferences` is how a Checkout Pro
 * flow is still created, and the Orders API is a different integration whose own checkout this
 * Worker does not use.
 *
 * **Which account the money goes to is configuration, and which URL the browser gets follows from
 * it.** `MERCADOPAGO_ENVIRONMENT` is `sandbox` on the development stack and `live` in production,
 * and it decides one thing here: whether a created preference is answered with its
 * `sandbox_init_point` or its `init_point`. It is an explicit variable rather than a guess at the
 * shape of the credential because both are inferable and neither is reliable — a test *user*'s
 * application credential is spelled exactly like a production one, so "does the token start with
 * TEST-" is a check that passes a live credential off as a test one. The variable is also what is
 * stamped onto the purchase, which is how a refund knows which account to ask.
 */

const API_BASE = 'https://api.mercadopago.com'

/** What a created preference gives back: the id to store and the URL to send the browser to. */
type Preference = {
  id: string
  /** Checkout URL for a live credential. */
  init_point: string
  /** Checkout URL for a test credential. Present only on a test preference. */
  sandbox_init_point?: string
}

/** The fields of a payment this Worker reads. MercadoPago sends a great many more. */
type Payment = {
  id: number | string
  status: string
  status_detail?: string
  transaction_amount?: number
  currency_id?: string
  external_reference?: string | null
  date_approved?: string | null
  payer?: { email?: string | null } | null
}

/**
 * Notification topics this Worker acts on, as the provider spells them.
 *
 * Taken from the notification's `type` (webhooks) or `topic` (the older query-string form). Anything
 * not in here is acknowledged and dropped — a merchant order, a Point integration or a subscription
 * says nothing about whether somebody may download a build.
 */
const TOPICS = {
  /** Classic payment notification. `data.id` is a payment id. */
  payment: 'payment',
  /** Orders API notification. `data.id` is an order id, e.g. `ORD01JQ4S4KY8HWQ6NA5PXB65B3D3`. */
  order: 'order',
  /** Classic chargeback topic. `data.id` is a chargeback id and `data.payment_id` the disputed payment. */
  chargeback: 'topic_chargebacks_wh',
} as const

/** One payment inside an order's `transactions`. Only the fields this Worker reads. */
type OrderPayment = {
  id: string | number
  status?: string
  status_detail?: string
  amount?: string | number
}

/**
 * The fields of an order this Worker reads.
 *
 * `total_paid_amount` rather than `total_amount` is what was actually collected, and amounts come back
 * as *strings* in this API where the payments API sends numbers — which is why every amount here goes
 * through `toAmount` instead of being trusted as a number.
 */
type Order = {
  id: string
  status: string
  status_detail?: string
  external_reference?: string | null
  total_amount?: string | number | null
  total_paid_amount?: string | number | null
  transactions?: { payments?: OrderPayment[] | null } | null
}

/** The fields of a chargeback this Worker reads. `payments` holds the disputed payment ids. */
type Chargeback = {
  id: string | number
  payments?: (string | number)[] | null
  amount?: string | number | null
  currency?: string | null
  /** Whether MercadoPago absorbed the loss. Recorded, never acted on — the entitlement ends either way. */
  coverage_applied?: boolean | null
  documentation_status?: string | null
  status?: string | null
}

type CreatePreferenceInput = {
  /** Our own id for the payment, echoed back on the payment. How a notification finds its row. */
  externalReference: string
  title: string
  description: string
  amount: number
  /** Verified address of the signed-in buyer, prefilled on the checkout. */
  payerEmail: string
  /** Absolute URL MercadoPago posts notifications to — this Worker's public one, via the gateway. */
  notificationUrl: string
  /** Where the browser comes back to on each outcome. Pages on the website, never on the API. */
  backUrls: { success: string; failure: string; pending: string }
  metadata?: Record<string, unknown>
}

const request = async <T>(env: Env, path: string, init: RequestInit = {}): Promise<T> => {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN is not configured, so no payment can be taken')
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  })

  if (!response.ok) {
    // The body is read but deliberately not returned to the caller: it can echo the request back,
    // and the request carries the buyer's address. The status is what a route needs to react.
    const detail = await response.text().catch(() => '')
    console.error('mercadopago request failed', path, response.status, detail.slice(0, 500))
    throw new Error(`MercadoPago answered ${response.status}`)
  }

  return (await response.json()) as T
}

/**
 * Creates a Checkout Pro preference.
 *
 * `X-Idempotency-Key` is the external reference, so a retried checkout on the same purchase row
 * cannot leave two preferences — and therefore two payments — behind for one intent.
 */
const createPreference = async (env: Env, input: CreatePreferenceInput): Promise<Preference> =>
  request<Preference>(env, '/checkout/preferences', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': input.externalReference },
    body: JSON.stringify({
      items: [
        {
          id: input.externalReference,
          title: input.title,
          description: input.description,
          quantity: 1,
          currency_id: CURRENCY,
          unit_price: input.amount,
        },
      ],
      payer: { email: input.payerEmail },
      external_reference: input.externalReference,
      notification_url: input.notificationUrl,
      back_urls: input.backUrls,
      // Sends the browser back by itself once the payment is approved, so the buyer lands on the
      // application page rather than on a MercadoPago receipt they have to close.
      auto_return: 'approved',
      metadata: input.metadata ?? {},
    }),
  })

/** Reads a payment. This, not the notification body, is what a status change is taken from. */
const getPayment = async (env: Env, paymentId: string): Promise<Payment> =>
  request<Payment>(env, `/v1/payments/${encodeURIComponent(paymentId)}`)

/** Reads an order. Same rule as `getPayment`: the notification names it, this says what it is. */
const getOrder = async (env: Env, orderId: string): Promise<Order> =>
  request<Order>(env, `/v1/orders/${encodeURIComponent(orderId)}`)

/** Reads a chargeback, for the amount, the coverage and the ids of the payments being disputed. */
const getChargeback = async (env: Env, chargebackId: string): Promise<Chargeback> =>
  request<Chargeback>(env, `/v1/chargebacks/${encodeURIComponent(chargebackId)}`)

/**
 * An amount from either API as whole pesos.
 *
 * The orders API sends amounts as strings (`"4990.00"`) where the payments API sends numbers, and CLP
 * has no minor unit — so both are normalised to an integer here rather than at four call sites.
 */
const toAmount = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

/** The payment ids an order settled with, newest API shape. Empty for an order nobody paid. */
const orderPaymentIds = (order: Order): string[] =>
  (order.transactions?.payments ?? []).map((payment) => String(payment.id)).filter((id) => id.length > 0)

/**
 * MercadoPago's payment states, mapped onto the ones a purchase row holds.
 *
 * An unknown state maps to `pending`, never to `approved`: a state this Worker has never heard of is
 * a state it cannot claim entitles anybody, and the provider adds them without asking.
 */
const mapPaymentStatus = (status: string): PurchaseStatus => {
  switch (status) {
    case 'approved':
      return 'approved'
    case 'authorized':
    case 'in_process':
    case 'in_mediation':
      return 'in_process'
    case 'rejected':
      return 'rejected'
    case 'cancelled':
      return 'cancelled'
    case 'refunded':
      return 'refunded'
    case 'charged_back':
      return 'charged_back'
    default:
      return 'pending'
  }
}

/**
 * The orders API's states, mapped onto the same set.
 *
 * Two of them are worth naming. `processed` is this API's word for "the money is in" — it is the only
 * one that entitles, and reading it as anything else would sell builds nobody paid for. `expired` and
 * `canceled` both collapse onto `cancelled`: the difference is whether the payer walked away or ran
 * out of time, and neither produced a payment, so nothing downstream can act on the distinction.
 */
const mapOrderStatus = (status: string): PurchaseStatus => {
  switch (status) {
    case 'processed':
      return 'approved'
    case 'processing':
    case 'action_required':
      return 'in_process'
    case 'failed':
      return 'rejected'
    case 'canceled':
    case 'expired':
      return 'cancelled'
    case 'refunded':
      return 'refunded'
    case 'charged_back':
      return 'charged_back'
    case 'created':
    default:
      return 'pending'
  }
}

/**
 * Which MercadoPago account this Worker is configured against.
 *
 * Falls back to `sandbox` on an unset or unrecognised value, because the fallback has to be the
 * side that cannot take real money by accident.
 */
const resolveEnvironment = (env: Env): PaymentEnvironment => parsePaymentEnvironment(env.MERCADOPAGO_ENVIRONMENT)

/**
 * The URL the browser is sent to, for the environment this Worker is running as.
 *
 * A test credential answers both `init_point` and `sandbox_init_point`, and they are not the same
 * checkout: the first runs the live flow against the test account and the second is the sandbox one
 * the provider's test cards work on. Preferring `init_point` for everybody — which is what this used
 * to do — meant the development stack never actually reached the sandbox, and a test card was
 * refused there for reasons that look like a broken integration.
 *
 * In `live` the sandbox URL is never used as a fallback. A production preference has no
 * `sandbox_init_point` to begin with, and were one ever to appear, sending a real buyer into the
 * sandbox would take no money while telling them it had.
 */
const checkoutUrlFor = (preference: Preference, environment: PaymentEnvironment): string | null => {
  // An empty string is treated as absent rather than as a URL: `??` would hand one straight back,
  // and the caller's only check on the result is whether it is falsy — which would leave a browser
  // redirected to the page it is already on with no error anywhere.
  const usable = (value: string | undefined) => (value && value.length > 0 ? value : null)

  if (environment === 'sandbox') {
    return usable(preference.sandbox_init_point) ?? usable(preference.init_point)
  }
  return usable(preference.init_point)
}

/** What the provider says about a refund it accepted. */
type Refund = {
  id: number | string
  payment_id?: number | string
  amount?: number | string | null
  status?: string | null
}

/**
 * Refunds a payment, in full or in part.
 *
 * Total and partial refunds are the same endpoint: a body with no `amount` refunds everything, and
 * one with an amount refunds that much. This is the only call in this module that *moves money*,
 * which is why the idempotency key is mandatory rather than convenient — MercadoPago treats two
 * unkeyed refund requests for one payment as two refunds, and a double-click in an editor's browser
 * is exactly how that happens.
 *
 * The refund is not what changes the purchase row. The notification that follows is, exactly as with
 * a payment: this asks for the refund and the webhook records that it happened. The caller applies
 * the status anyway so an editor is not left looking at an unchanged screen waiting for a webhook —
 * both paths converge, and `applyPaymentStatus` stamps `refunded_at` once.
 */
const refundPayment = async (
  env: Env,
  paymentId: string,
  input: { idempotencyKey: string; amount?: number | null },
): Promise<Refund> =>
  request<Refund>(env, `/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
    method: 'POST',
    headers: { 'X-Idempotency-Key': input.idempotencyKey },
    // An empty object rather than no body: the endpoint expects JSON, and a total refund is the
    // absence of an amount inside it rather than the absence of the document.
    body: JSON.stringify(input.amount ? { amount: input.amount } : {}),
  })

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Verifies the `x-signature` header MercadoPago sends with a notification.
 *
 * The signed manifest is a fixed string — `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` — HMAC'd
 * with the webhook secret from the dashboard. Two details are easy to get wrong and expensive to
 * debug, because a mismatch and a forgery look identical from here:
 *
 * - the id is lowercased when it is not purely numeric, which is what MercadoPago signs;
 * - every part named in the manifest must be present, so a notification with no `x-request-id` is
 *   refused rather than signed over an empty string.
 *
 * The lowercasing is not cosmetic and it is not settled upstream: MercadoPago's own SDKs disagree
 * about it (sdk-go lowercases, sdk-java does not — mercadopago/sdk-java#420), and it only became
 * visible with the orders API, whose ids are uppercase (`ORD01JQ…`) where payment ids are numeric.
 * That same issue reports order notifications failing validation under *either* rule. So an order
 * notification refused here may be this Worker's bug or the provider's, and the route logs which
 * topic was refused for exactly that reason. What it must not do is skip the check to find out:
 * the read-back below is what makes a notification harmless, not what makes it authentic.
 *
 * Returns false rather than throwing: the route answers the same 401 whichever way it failed.
 */
const verifyWebhookSignature = async (
  secret: string,
  input: { signature: string | undefined; requestId: string | undefined; dataId: string | undefined },
): Promise<boolean> => {
  if (!secret || !input.signature || !input.requestId || !input.dataId) {
    return false
  }

  const parts = new Map(
    input.signature.split(',').map((part) => {
      const [key, ...rest] = part.split('=')
      return [key?.trim() ?? '', rest.join('=').trim()] as const
    }),
  )
  const ts = parts.get('ts')
  const v1 = parts.get('v1')
  if (!ts || !v1) {
    return false
  }

  const id = /^\d+$/.test(input.dataId) ? input.dataId : input.dataId.toLowerCase()
  const manifest = `id:${id};request-id:${input.requestId};ts:${ts};`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)))

  // Both sides are fixed-length hex of a value the caller cannot grind, but the comparison is still
  // written to run in constant time rather than leaving it to `===` and a comment.
  if (expected.length !== v1.length) {
    return false
  }
  let difference = 0
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ v1.charCodeAt(index)
  }
  return difference === 0
}

export {
  checkoutUrlFor,
  createPreference,
  getChargeback,
  getOrder,
  getPayment,
  mapOrderStatus,
  mapPaymentStatus,
  orderPaymentIds,
  refundPayment,
  resolveEnvironment,
  toAmount,
  TOPICS,
  verifyWebhookSignature,
}
export type { Chargeback, CreatePreferenceInput, Order, OrderPayment, Payment, Preference, Refund }
