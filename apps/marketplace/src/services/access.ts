import type { Database } from '@/db/client'
import { COOLDOWN_SECONDS } from '@/lib/downloads'
import { describePricing, mustOfferPayment, type Pricing } from '@/lib/pricing'
import type { Account } from '@/middleware/account'
import type { Product } from '@/services/products'
import { findActivePurchase, type Purchase } from '@/services/purchases'

/**
 * Whether this caller may download this product, and what the page has to show them first.
 *
 * Every route that could possibly answer that question goes through here — the status endpoint the
 * website polls, and the endpoint that mints a download ticket — so the two can never disagree. A
 * second place deciding whether the modal is skippable is a second place to get it wrong, and the one
 * that gets it wrong is the one that gives a paid build away.
 */
type Access = {
  pricing: Pricing
  /** The payment that entitles this caller, or null. */
  purchase: Purchase | null
  /** True when an approved payment exists for this account. */
  has_paid: boolean
  /**
   * Whether the payment modal must be shown. True for every non-payer of a paying product,
   * with no exceptions — which is the product rule, stated in `src/lib/pricing.ts`.
   */
  must_offer_payment: boolean
  /** Whether a download is possible at all right now. */
  can_download: boolean
  /** Seconds this caller waits before their download starts. Zero once they have paid. */
  cooldown_seconds: number
  /** Whether the caller is signed in, so a front-end knows whether to sign them in before checkout. */
  authenticated: boolean
}

/**
 * Resolves the access of `account` (possibly nobody) to `product`.
 *
 * The cooldown is attached to the *caller* rather than to the product: it is five seconds for a
 * non-payer and nothing for somebody who paid, which is the only difference between the two download
 * experiences once the modal is out of the way. A free product has no payer and no non-payer, so
 * it has no cooldown either — the wait exists to make the offer worth reading, and there is no offer.
 */
const resolveAccess = async (
  db: Database,
  product: Product,
  account: Account | undefined,
): Promise<Access> => {
  const pricing = describePricing(product)
  const purchase = account && pricing.accepts_payment ? await findActivePurchase(db, product.id, account) : null
  const hasPaid = purchase !== null

  return {
    pricing,
    purchase,
    has_paid: hasPaid,
    must_offer_payment: mustOfferPayment(pricing, hasPaid),
    // A paid product is downloadable only once it has been paid for; the other two always are.
    can_download: !pricing.requires_payment || hasPaid,
    cooldown_seconds: !pricing.accepts_payment || hasPaid ? 0 : COOLDOWN_SECONDS,
    authenticated: account !== undefined,
  }
}

/** The access shape as a response body, with the entitling payment summarised rather than inlined. */
const toPublicAccess = (access: Access) => ({
  pricing: access.pricing,
  has_paid: access.has_paid,
  must_offer_payment: access.must_offer_payment,
  can_download: access.can_download,
  cooldown_seconds: access.cooldown_seconds,
  authenticated: access.authenticated,
  purchase: access.purchase
    ? {
        id: access.purchase.id,
        kind: access.purchase.kind,
        amount: access.purchase.amount,
        currency: access.purchase.currency,
        approved_at: access.purchase.approvedAt?.toISOString() ?? null,
      }
    : null,
})

export { resolveAccess, toPublicAccess }
export type { Access }
