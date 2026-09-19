import type { Env } from '@/env'
import type { PurchaseStatus } from '@/lib/config'
import { CURRENCY } from '@/lib/pricing'

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

/** MercadoPago's payment states, mapped onto the ones a purchase row holds. */
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
    case 'charged_back':
      return 'refunded'
    default:
      return 'pending'
  }
}

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

export { createPreference, getPayment, mapPaymentStatus, verifyWebhookSignature }
export type { CreatePreferenceInput, Payment, Preference }
