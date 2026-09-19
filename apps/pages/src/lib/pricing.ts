import * as v from 'valibot'

/**
 * How an application is paid for, as a closed set of three modes.
 *
 * The set is deliberately small, and it is the same kind of decision as the tab registry: a page
 * says *which* of these three it is, and nothing else about how money reaches it is configurable.
 * Tiers, regional prices, subscriptions and upgrade paths are all absent on purpose — each one turns
 * a product page into a store, and the house standard is that these pages are product pages.
 *
 * - `free` — no payments at all. The downloads are downloads.
 * - `donation` — "pago opcional": the build is free to take, and a modal offers to pay for it first.
 *   Refusing is an offered, visible choice rather than a dark pattern, and refusing still downloads.
 * - `paid` — a download needs an approved purchase on the account. Every build does, the new release
 *   and the archive alike; there is no "first version was free" state to reason about.
 *
 * Both paid modes show the payment modal to everybody who has not paid, *every* time. That is the
 * product decision, not an implementation detail, and it is why `mustOfferPayment` is derived from
 * the mode and the entitlement rather than from anything the client sends.
 */

const PRICING_MODES = ['free', 'donation', 'paid'] as const

type PricingMode = (typeof PRICING_MODES)[number]

/**
 * The one currency. MercadoPago settles this account in Chilean pesos, and a second currency is not
 * a column — it is a conversion, a rounding rule and a receipt that disagrees with the price shown.
 * Purchases still store their own `currency` so a row remains readable if that ever changes.
 */
const CURRENCY = 'CLP'

/**
 * Bounds on any amount this Worker will charge, in whole pesos.
 *
 * CLP has no minor unit, so these are the amounts themselves rather than cents — an integer schema
 * is the whole validation. The floor is not MercadoPago's; it is the point below which the provider's
 * fee eats the payment, and it also bounds what a donation may be talked down to.
 */
const AMOUNT_LIMITS = {
  min: 500,
  max: 5_000_000,
} as const

/** An amount an editor or a donor may send: whole pesos, inside the bounds above. */
const amountInput = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(AMOUNT_LIMITS.min),
  v.maxValue(AMOUNT_LIMITS.max),
)

/** A settable, clearable amount on a PATCH body. */
const optionalAmount = v.optional(v.nullable(amountInput))

const isPricingMode = (value: string): value is PricingMode => (PRICING_MODES as readonly string[]).includes(value)

/**
 * Reads a stored mode back, falling back to `free` on anything unknown.
 *
 * Lenient for the same reason `parseTabs` is: the read path runs over whatever is in the column, and
 * a mode retired in a later version of this Worker must degrade to "this page takes no money" rather
 * than 500-ing the product page. Falling back *open* would be the dangerous direction — `free` is
 * the mode that grants the least.
 */
const parsePricingMode = (raw: string | null): PricingMode => (raw && isPricingMode(raw) ? raw : 'free')

/** The pricing half of an application row, as every public route serializes it. */
type Pricing = {
  mode: PricingMode
  currency: string
  /** What a purchase costs. Only ever set in `paid` mode. */
  price: number | null
  /** What a donation modal prefills. Only ever set in `donation` mode. */
  suggested_amount: number | null
  /** Lowest amount checkout will accept, so a front-end can validate before it redirects. */
  minimum_amount: number
  /** Whether a visitor may decline and download anyway. False only in `paid` mode. */
  allows_skip: boolean
  /** Whether a download is gated on an approved purchase. True only in `paid` mode. */
  requires_payment: boolean
  /** Whether checkout is available at all for this application. */
  accepts_payment: boolean
}

type PricedApplication = {
  pricingMode: string | null
  priceAmount: number | null
  suggestedAmount: number | null
}

/**
 * The pricing of an application, with every field the front-end needs derived here rather than
 * inferred there.
 *
 * `price` and `suggested_amount` are nulled outside the mode they belong to on purpose: switching a
 * paid application to `donation` leaves the old price in the column (an editor who switches back
 * should not have to retype it), and a website that read the raw column would quote a price for an
 * application that is now free.
 */
const describePricing = (application: PricedApplication): Pricing => {
  const mode = parsePricingMode(application.pricingMode)

  return {
    mode,
    currency: CURRENCY,
    price: mode === 'paid' ? application.priceAmount : null,
    suggested_amount: mode === 'donation' ? application.suggestedAmount : null,
    minimum_amount: AMOUNT_LIMITS.min,
    allows_skip: mode !== 'paid',
    requires_payment: mode === 'paid',
    accepts_payment: mode !== 'free',
  }
}

/**
 * Whether the payment modal has to be shown before a download.
 *
 * Every non-payer of a `donation` or `paid` application, every single time — that is the rule, and
 * it is stated once here so no route can quietly make an exception of itself. Somebody who has paid
 * gets the direct link instead.
 */
const mustOfferPayment = (pricing: Pricing, hasPaid: boolean): boolean => pricing.accepts_payment && !hasPaid

/**
 * What a checkout should charge, or a message saying why it cannot.
 *
 * In `paid` mode the amount is the price, whatever the caller asked for — a client that could name
 * its own price for a paid application is a client that pays 500 pesos for it. In `donation` mode
 * the caller's amount wins, the configured suggestion is the fallback, and the floor is the one in
 * `AMOUNT_LIMITS`: the suggestion is a suggestion, and refusing a smaller donation would make it a
 * price with extra steps.
 */
const resolveChargeAmount = (
  pricing: Pricing,
  requested: number | undefined,
): { amount: number } | { error: string } => {
  if (!pricing.accepts_payment) {
    return { error: 'This application does not take payments' }
  }

  if (pricing.mode === 'paid') {
    if (pricing.price === null) {
      // A paid application with no price is an editor halfway through a change, not a free one.
      return { error: 'This application has no price set yet' }
    }
    return { amount: pricing.price }
  }

  const amount = requested ?? pricing.suggested_amount ?? AMOUNT_LIMITS.min
  if (amount < AMOUNT_LIMITS.min) {
    return { error: `The smallest amount accepted is ${AMOUNT_LIMITS.min} ${CURRENCY}` }
  }
  if (amount > AMOUNT_LIMITS.max) {
    return { error: `The largest amount accepted is ${AMOUNT_LIMITS.max} ${CURRENCY}` }
  }
  return { amount }
}

/** What a payment for this mode is called on the row and on the receipt. */
const purchaseKindFor = (mode: PricingMode): 'purchase' | 'donation' => (mode === 'paid' ? 'purchase' : 'donation')

export {
  AMOUNT_LIMITS,
  amountInput,
  CURRENCY,
  describePricing,
  isPricingMode,
  mustOfferPayment,
  optionalAmount,
  parsePricingMode,
  PRICING_MODES,
  purchaseKindFor,
  resolveChargeAmount,
}
export type { Pricing, PricingMode }
