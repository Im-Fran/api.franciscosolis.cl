import type { PurchaseStatus } from '@/lib/config'

/**
 * The administrative half of a payment: where the money came from, whether it can still be given
 * back, and what a voucher is.
 *
 * `pricing.ts` decides what somebody is *charged*. This module is about a sale once it exists —
 * which is a different job with a different audience. Everything in `pricing.ts` is read by the
 * website; everything here is read by whoever has to answer "was this paid, how, and can I refund
 * it" months later.
 */

/**
 * How the money reached us, as a closed set.
 *
 * `mercadopago` is the only one the Worker can produce by itself; the rest are what an editor
 * records by hand after taking money outside the provider — cash at a stand, a bank transfer, or a
 * copy given away. The source is kept apart from `provider` on the row because the two answer
 * different questions: `provider` is which system holds the transaction (`mercadopago` or
 * `manual`), and `source` is what the person actually did. A cash sale and a transfer are the same
 * provider and are not the same fact, and the second is what an accountant reconciles against.
 */
const SALE_SOURCES = ['mercadopago', 'cash', 'bank_transfer', 'gift', 'other'] as const
type SaleSource = (typeof SALE_SOURCES)[number]

/**
 * The sources an editor may record by hand.
 *
 * Deliberately every source except `mercadopago`: a row claiming the provider took money that the
 * provider has no record of would be indistinguishable from a real payment, and the entitlement it
 * grants is the same. A manual row is always visibly manual.
 */
const MANUAL_SALE_SOURCES = SALE_SOURCES.filter((source): source is Exclude<SaleSource, 'mercadopago'> =>
  source !== 'mercadopago',
)

const isSaleSource = (value: string): value is SaleSource => (SALE_SOURCES as readonly string[]).includes(value)

/** Reads a stored source back, falling back to `other` rather than to the provider's name. */
const parseSaleSource = (raw: string | null): SaleSource => (raw && isSaleSource(raw) ? raw : 'other')

/** True for a sale settled outside MercadoPago, which is what decides whether a refund calls an API. */
const isManualSource = (source: SaleSource): boolean => source !== 'mercadopago'

/** A gift is a sale of zero. It entitles exactly as a paid one does; it just never had an amount. */
const isFreeSource = (source: SaleSource): boolean => source === 'gift'

/**
 * Which MercadoPago account a sale was taken against.
 *
 * Recorded on the row rather than derived from the current configuration, because the configuration
 * is what changes: a development database repointed at a live credential would otherwise reprice
 * every test payment in it as real money. It is also what stops a refund being attempted against
 * the wrong account — the provider answers 404 for a payment id from the other environment, which
 * looks exactly like a payment that never existed.
 */
const PAYMENT_ENVIRONMENTS = ['live', 'sandbox'] as const
type PaymentEnvironment = (typeof PAYMENT_ENVIRONMENTS)[number]

const isPaymentEnvironment = (value: string): value is PaymentEnvironment =>
  (PAYMENT_ENVIRONMENTS as readonly string[]).includes(value)

/**
 * Reads a configured or stored environment back.
 *
 * Unknown values fall back to `sandbox`, which is the opposite direction from `parsePricingMode`'s
 * and for the same reason: the fallback has to be the one that grants the least. A misconfigured
 * Worker that quietly decided it was live would take real money for a test.
 */
const parsePaymentEnvironment = (raw: string | null | undefined): PaymentEnvironment =>
  raw && isPaymentEnvironment(raw) ? raw : 'sandbox'

/**
 * What `user_id` holds on a sale recorded before its recipient had an account.
 *
 * A sentinel rather than a nullable column, and the reason is migration safety rather than taste:
 * dropping `NOT NULL` in SQLite means rebuilding the table, and a `DROP TABLE`/rename on `purchases`
 * races the production deploy (see the root `CLAUDE.md`) — for the length of it every paid download
 * would 404 instead of degrading. Every migration on this table stays additive because of it.
 *
 * Nothing compares against the raw value: `isLinkedToAccount` is the one place that knows, and an
 * unlinked sale is found by its address, which is what `findActivePurchase` already matches on.
 */
const UNLINKED_USER_ID = ''

/** Whether this sale is tied to an SSO account yet, as opposed to only to an address. */
const isLinkedToAccount = (userId: string | null): boolean =>
  typeof userId === 'string' && userId !== UNLINKED_USER_ID

/**
 * Why a payment was given back.
 *
 * `withdrawal` is not a synonym for the others: it is the Chilean consumer statute's *derecho a
 * retracto*, a right the buyer holds unconditionally for ten days, and a refund issued under it is
 * not a favour we chose to do. Keeping it as its own reason is what makes "how many of these were
 * statutory" answerable, and that number is the one that says whether a product is being
 * mis-sold.
 */
const REFUND_REASONS = ['withdrawal', 'duplicate', 'not_delivered', 'goodwill', 'fraud', 'other'] as const
type RefundReason = (typeof REFUND_REASONS)[number]

/**
 * The statutory withdrawal window, in days.
 *
 * Ley 19.496 art. 3 bis b) gives a consumer ten days from the contract or from delivery to withdraw
 * from a distance sale, and a digital licence bought on a web page is exactly that. It is a constant
 * rather than a setting: it is not ours to shorten, and an editor who could would eventually.
 */
const WITHDRAWAL_DAYS = 10

const DAY_MS = 86_400_000

/** The day the buyer's unconditional right to withdraw runs out, or null if they never paid. */
const withdrawalDeadline = (approvedAt: Date | null): Date | null =>
  approvedAt ? new Date(approvedAt.getTime() + WITHDRAWAL_DAYS * DAY_MS) : null

/**
 * The withdrawal window as a screen has to show it.
 *
 * `days_left` is rounded *up*, so the last partial day still reads as one day rather than zero: a
 * buyer whose right expires in four hours has not lost it yet, and an editor told "0 days left"
 * would refuse a refund they are obliged to give.
 */
const describeWithdrawal = (
  approvedAt: Date | null,
  now: Date = new Date(),
): { deadline: string | null; days_left: number | null; within_period: boolean } => {
  const deadline = withdrawalDeadline(approvedAt)
  if (!deadline) {
    return { deadline: null, days_left: null, within_period: false }
  }

  const remaining = deadline.getTime() - now.getTime()
  return {
    deadline: deadline.toISOString(),
    days_left: Math.max(0, Math.ceil(remaining / DAY_MS)),
    within_period: remaining > 0,
  }
}

/**
 * Publication states of a voucher.
 *
 * A voucher is never deleted and never edited: it is a document somebody was sent, and rewriting
 * one would make every copy already in an inbox a forgery of the row. Correcting one means voiding
 * it and issuing the next, which is why there are two states and no third.
 */
const VOUCHER_STATUSES = ['issued', 'void'] as const
type VoucherStatus = (typeof VOUCHER_STATUSES)[number]

/** Prefix of every voucher number, so one is recognisable out of context. */
const VOUCHER_PREFIX = 'FS'

/**
 * Formats a voucher number from its year and sequence, e.g. `FS-2026-000042`.
 *
 * Per year rather than continuous, and zero-padded to six digits: the year is what a receipt is
 * filed under, and a fixed width is what makes a column of them line up and sort as text.
 */
const formatVoucherNumber = (year: number, sequence: number): string =>
  `${voucherNumberPrefix(year)}${String(sequence).padStart(6, '0')}`

/** What every voucher number of a given year starts with. What the sequence is counted by. */
const voucherNumberPrefix = (year: number): string => `${VOUCHER_PREFIX}-${year}-`

/**
 * Whether a sale in this status can still be refunded.
 *
 * Only an approved one. A pending payment has taken no money to give back, a rejected one never
 * took any, and a charged-back one has already had it taken — attempting a refund on that last case
 * is how an account ends up paying twice for one dispute.
 */
const isRefundable = (status: PurchaseStatus): boolean => status === 'approved'

export {
  describeWithdrawal,
  isLinkedToAccount,
  formatVoucherNumber,
  isFreeSource,
  isManualSource,
  isPaymentEnvironment,
  isRefundable,
  isSaleSource,
  MANUAL_SALE_SOURCES,
  parsePaymentEnvironment,
  parseSaleSource,
  PAYMENT_ENVIRONMENTS,
  REFUND_REASONS,
  SALE_SOURCES,
  UNLINKED_USER_ID,
  VOUCHER_PREFIX,
  VOUCHER_STATUSES,
  voucherNumberPrefix,
  WITHDRAWAL_DAYS,
  withdrawalDeadline,
}
export type { PaymentEnvironment, RefundReason, SaleSource, VoucherStatus }
