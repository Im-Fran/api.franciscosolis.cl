import type { Database } from '@/db/client'
import type { ReleaseChannel } from '@/lib/channels'
import { isPreRelease } from '@/lib/channels'
import { COOLDOWN_SECONDS } from '@/lib/downloads'
import { describePricing, mustOfferPayment, type Pricing } from '@/lib/pricing'
import type { Account } from '@/middleware/account'
import type { Product } from '@/services/products'
import type { ProductRelease } from '@/services/releases'
import { findActivePurchase, type Purchase } from '@/services/purchases'

/**
 * Whether this caller may download this product, and what the page has to show them first.
 *
 * Every route that could possibly answer that question goes through here — the status endpoint the
 * website polls, and the endpoint that mints a download ticket — so the two can never disagree. A
 * second place deciding whether the modal is skippable is a second place to get it wrong, and the one
 * that gets it wrong is the one that gives a paid build away.
 *
 * That rule is why the channel gate lives in this function rather than beside it. "Has this person
 * paid" and "is this build one only payers get" are the same question asked twice, and answering
 * the second one in `routes/downloads.ts` would mean the status endpoint the front-end polls and
 * the endpoint that actually mints the ticket could reach different conclusions.
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
  /**
   * *Why* a download is refused, from a closed set, so a front-end can word the modal without
   * parsing a sentence: `paid` is "this costs money", `pre_release` is "this build costs money".
   */
  gate: AccessGate
  /** The channel the answer is about, or null when asked without a release in hand. */
  channel: ReleaseChannel | null
  /** Seconds this caller waits before their download starts. Zero once they have paid. */
  cooldown_seconds: number
  /** Whether the caller is signed in, so a front-end knows whether to sign them in before checkout. */
  authenticated: boolean
}

const ACCESS_GATES = ['none', 'paid', 'pre_release'] as const

type AccessGate = (typeof ACCESS_GATES)[number]

/** What each gate is told to the caller. One sentence per reason, written once. */
const GATE_MESSAGES: Record<Exclude<AccessGate, 'none'>, string> = {
  paid: 'This product has to be paid for before it can be downloaded',
  pre_release: 'Pre-release builds of this product are available to people who have bought it',
}

/**
 * Whether *this channel* of this product is behind the purchase — a fact about the release, with
 * no caller in it.
 *
 * Separate from `Access.gate` on purpose. `gate` answers "why is this person refused", which for a
 * `paid` product is always the price; this answers "is this line reserved for supporters", which is
 * what a cacheable file listing has to say and what the `donation` case turns on. Asking `gate` for
 * it would make the answer depend on who was asking, and the listing is the same for everybody.
 */
const isChannelGated = (pricing: Pricing, channel: ReleaseChannel | null): boolean =>
  pricing.pre_release_requires_purchase && channel !== null && isPreRelease(channel)

/**
 * Resolves the access of `account` (possibly nobody) to `product`, optionally to one release of it.
 *
 * The cooldown is attached to the *caller* rather than to the product: it is five seconds for a
 * non-payer and nothing for somebody who paid, which is the only difference between the two download
 * experiences once the modal is out of the way. A free product has no payer and no non-payer, so
 * it has no cooldown either — the wait exists to make the offer worth reading, and there is no offer.
 *
 * Called with no release, this answers about the product: that is what the status endpoint wants
 * before a visitor has picked a build, and it is why `gate` can only be `paid` there.
 */
const resolveAccess = async (
  db: Database,
  product: Product,
  account: Account | undefined,
  options: { release?: Pick<ProductRelease, 'channel'> | null } = {},
): Promise<Access> => {
  const pricing = describePricing(product)
  // Written out rather than short-circuited on `accepts_payment` alone: the two gates are separate
  // questions, and the day a `donation` product wants gated nightlies this is the one boolean that
  // has to move. Today `pre_release_requires_purchase` is only ever true in `paid` mode, so the
  // condition costs nothing.
  const needsPurchase = pricing.accepts_payment || pricing.pre_release_requires_purchase
  const purchase = account && needsPurchase ? await findActivePurchase(db, product.id, account) : null
  const hasPaid = purchase !== null

  const channel = options.release ? (options.release.channel as ReleaseChannel) : null
  const gatedByPrice = pricing.requires_payment && !hasPaid
  const gatedByChannel = isChannelGated(pricing, channel) && !hasPaid

  return {
    pricing,
    purchase,
    has_paid: hasPaid,
    must_offer_payment: mustOfferPayment(pricing, hasPaid),
    can_download: !gatedByPrice && !gatedByChannel,
    gate: gatedByPrice ? 'paid' : gatedByChannel ? 'pre_release' : 'none',
    channel,
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
  gate: access.gate,
  channel: access.channel,
  channel_requires_purchase: isChannelGated(access.pricing, access.channel),
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

export { ACCESS_GATES, GATE_MESSAGES, isChannelGated, resolveAccess, toPublicAccess }
export type { Access, AccessGate }
