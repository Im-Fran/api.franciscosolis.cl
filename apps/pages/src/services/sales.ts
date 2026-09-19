import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { purchases } from '@/db/schema'
import type { Env } from '@/env'
import { ENTITLING_STATUS, PURCHASE_STATUSES, type PurchaseStatus } from '@/lib/config'
import { refundPayment, resolveEnvironment } from '@/lib/mercadopago'
import { CURRENCY } from '@/lib/pricing'
import {
  isManualSource,
  type PaymentEnvironment,
  type RefundReason,
  SALE_SOURCES,
  type SaleSource,
  UNLINKED_USER_ID,
} from '@/lib/sales'
import { applyPaymentStatus, purchaseClauses, type Purchase, type PurchaseFilters } from '@/services/purchases'

/**
 * Administering a sale, as opposed to taking one.
 *
 * `routes/store.ts` is where money *arrives*: a buyer, a preference, a redirect. This is the other
 * side of the same rows — recording money that arrived somewhere this Worker cannot see, giving it
 * back, and adding it up. The two are deliberately separate services because the second one is
 * reachable only by an authenticated editor and writes columns the first must never touch.
 *
 * **Why a manual sale is allowed to exist at all**, when the webhook's whole design is that nobody
 * may declare a payment approved: the two are not the same endpoint and not the same trust. The
 * webhook is public, so it believes nothing and reads every status back from the provider. This is
 * behind `requireEditor` — a verified token, an accepted audience, an allowed email domain — every
 * row it writes carries the editor's address in `created_by`, its `source` says on its face that no
 * provider was involved, and the write is audited. Money genuinely does change hands outside
 * MercadoPago: cash at a stand, a transfer, a copy given to somebody. The alternative is not "no
 * unverified approvals", it is a spreadsheet beside the database, which is worse in every way that
 * matters — nothing links it to the entitlement, and nobody can refund from it.
 */

type CreateManualSaleInput = {
  applicationId: string
  applicationSlug: string
  applicationName: string
  /** `purchase` grants the licence; `donation` records support for an optional-pay application. */
  kind: 'purchase' | 'donation'
  /** Where the money came from. Never `mercadopago` — the route refuses that before it gets here. */
  source: Exclude<SaleSource, 'mercadopago'>
  /** Address the sale is filed under and the voucher is sent to. */
  email: string
  /** The SSO account, when the editor knows it. Otherwise the sale is found by its address. */
  userId?: string | null
  /** Whole units of `CURRENCY`. Zero is valid and is what a gift is. */
  amount: number
  /** Which stand, which transfer, who the copy was for. Free text, and the reason this is auditable. */
  note?: string | null
  /** Our own reference, when the editor has one (a transfer id). Generated when they do not. */
  reference?: string | null
  /** When the money actually changed hands, which is routinely not when it was typed in. */
  occurredAt?: Date | null
  /** Editor recording it. Written to `created_by`, and never null. */
  createdBy: string
  environment: PaymentEnvironment
}

/**
 * Records a sale that happened outside MercadoPago.
 *
 * It is written `approved` and dated, because that is what it is: the money is already in. There is
 * no pending state for cash — a pending manual sale would be a note to self, and this table is the
 * entitlement.
 *
 * `occurredAt` sets `approved_at` *and* `created_at`, which is what makes the withdrawal window and
 * every date-bounded total line up with the day the sale really happened. A sale entered a week late
 * whose statutory ten days ran from the day it was typed would give the buyer three days too many,
 * and one entered early would take days off them.
 */
const createManualSale = async (db: Database, input: CreateManualSaleInput): Promise<Purchase> => {
  const now = new Date()
  const occurred = input.occurredAt ?? now

  const row: Purchase = {
    id: crypto.randomUUID(),
    applicationId: input.applicationId,
    applicationSlug: input.applicationSlug,
    kind: input.kind,
    userId: input.userId ?? UNLINKED_USER_ID,
    email: input.email.toLowerCase(),
    status: ENTITLING_STATUS,
    amount: input.amount,
    currency: CURRENCY,
    // `manual` rather than `mercadopago`: the provider holds no transaction for this row, and a
    // reconciliation that trusted `provider` would go looking for one.
    provider: 'manual',
    source: input.source,
    environment: input.environment,
    preferenceId: null,
    paymentId: null,
    // An editor's own reference when they have one — a transfer id is what a bank statement is
    // matched against — and a generated one otherwise, because the column is uniquely indexed and is
    // how anything ever finds this row again.
    externalReference: input.reference?.trim() || `manual:${crypto.randomUUID()}`,
    approvedAt: occurred,
    refundedAt: null,
    refundedAmount: null,
    refundReason: null,
    refundedBy: null,
    refundId: null,
    chargedBackAt: null,
    chargebackId: null,
    note: input.note?.trim() || null,
    createdBy: input.createdBy,
    metadata: JSON.stringify({ application_name: input.applicationName, recorded: 'manual' }),
    createdAt: occurred,
    updatedAt: now,
  }

  await db.insert(purchases).values(row)
  return row
}

type UpdateSaleInput = {
  /** Corrects where the receipt goes. A re-issue is what actually re-sends it. */
  email?: string
  /** Attaches the SSO account to a manual sale, once the recipient has one. */
  userId?: string
  /** Replaces the editor's note. An explicit null clears it. */
  note?: string | null
}

/**
 * The only three things about a settled sale an editor may change.
 *
 * Deliberately not the amount, the status, the source or any date. Those are what the sale *is*;
 * correcting one of them is not an edit, it is a refund plus a new sale, and an endpoint that let
 * them be typed over would be an endpoint that rewrites history with no trace of the previous
 * value. What is here instead is the three things that can be *wrong about the world* rather than
 * about the sale: a mistyped address, an account that did not exist yet, and a note.
 */
const updateSaleDetails = async (
  db: Database,
  purchase: Purchase,
  input: UpdateSaleInput,
): Promise<Purchase> => {
  const now = new Date()
  const updated: Purchase = {
    ...purchase,
    email: input.email ? input.email.toLowerCase() : purchase.email,
    userId: input.userId ?? purchase.userId,
    note: input.note === undefined ? purchase.note : (input.note?.trim() || null),
    updatedAt: now,
  }

  await db
    .update(purchases)
    .set({ email: updated.email, userId: updated.userId, note: updated.note, updatedAt: now })
    .where(eq(purchases.id, purchase.id))

  return updated
}

type RefundSaleInput = {
  purchase: Purchase
  /** Partial amount, or null/undefined for the whole sale. */
  amount?: number | null
  reason: RefundReason
  /** Editor issuing it. */
  refundedBy: string
}

/**
 * Gives a sale back.
 *
 * For a MercadoPago sale this asks the provider first and records second, in that order and never
 * the other way round: a row marked refunded for money that was never returned is a buyer who has
 * lost their download and still has the charge. The notification that follows applies the same
 * transition again, and lands on the timestamps this already stamped — `applyPaymentStatus` keeps
 * the first of each.
 *
 * For a manual sale there is nothing to ask. The money goes back the way it arrived, by hand, and
 * this records that it was.
 *
 * The idempotency key is the purchase and the amount, so an editor's double-click is one refund at
 * the provider — and so a deliberate second *partial* refund of a different amount still goes
 * through, which is the one case a key of the purchase alone would silently swallow.
 */
const refundSale = async (db: Database, env: Env, input: RefundSaleInput): Promise<Purchase> => {
  const { purchase } = input
  const amount = input.amount ?? null
  let refundId: string | null = null

  if (!isManualSource(purchase.source as SaleSource) && purchase.paymentId) {
    const refund = await refundPayment(env, purchase.paymentId, {
      idempotencyKey: `refund:${purchase.id}:${amount ?? 'total'}`,
      amount,
    })
    refundId = String(refund.id)
  }

  return applyPaymentStatus(db, purchase, {
    status: 'refunded',
    refundedAmount: amount ?? purchase.amount,
    refundReason: input.reason,
    refundedBy: input.refundedBy,
    refundId,
  })
}

/** Statuses that mean money actually arrived at some point, whatever happened to it afterwards. */
const SETTLED_STATUSES: readonly PurchaseStatus[] = ['approved', 'refunded', 'charged_back']

type SalesSummary = {
  currency: string
  /** The environment this Worker is *currently* configured for, so a screen can badge itself. */
  environment: PaymentEnvironment
  count: number
  /** Sales currently entitling somebody. What "how many licences are live" means. */
  active_count: number
  /** Everything that ever settled, at what it was charged. Money in. */
  gross: number
  /** Everything given back: a refund at its refunded amount, a chargeback at the whole sale. */
  returned: number
  /** `gross - returned`. The only figure here that is safe to call revenue. */
  net: number
  /** Distinct addresses among the settled sales. Buyers, not payments. */
  buyers: number
  by_status: Record<string, { count: number; total: number }>
  by_source: Record<string, { count: number; total: number }>
  first_sale_at: string | null
  last_sale_at: string | null
}

const emptyBuckets = <T extends string>(keys: readonly T[]): Record<string, { count: number; total: number }> =>
  Object.fromEntries(keys.map((key) => [key, { count: 0, total: 0 }]))

/**
 * The totals a sales screen opens with, over exactly the rows the listing beside it shows.
 *
 * Grouped in the database rather than summed over a page of results, which is the difference between
 * a lifetime figure and "the total of the fifty rows you happen to be looking at" — the existing
 * `GET /admin/purchases` deliberately reports the second and says so, and this reports the first.
 *
 * Three figures rather than one, because "how much did this application make" has three honest
 * answers and quoting the wrong one is how a refund gets counted as income. `gross` is what arrived,
 * `returned` is what went back out, `net` is the difference. A chargeback returns the whole sale
 * regardless of the disputed amount: the fee is not modelled here, so the conservative reading is
 * the correct one.
 *
 * Every bucket of the closed sets is present at zero rather than absent, so a front-end renders a
 * stable set of rows instead of a shape that changes with the data.
 */
const summarizeSales = async (
  db: Database,
  env: Env,
  filters: Omit<PurchaseFilters, 'limit' | 'offset'>,
): Promise<SalesSummary> => {
  const clauses = purchaseClauses(filters)
  const where = clauses.length > 0 ? and(...clauses) : undefined

  const byStatus = await db
    .select({
      status: purchases.status,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${purchases.amount}), 0)`,
      returned: sql<number>`coalesce(sum(${purchases.refundedAmount}), 0)`,
    })
    .from(purchases)
    .where(where)
    .groupBy(purchases.status)

  const bySource = await db
    .select({
      source: purchases.source,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${purchases.amount}), 0)`,
    })
    .from(purchases)
    .where(where)
    .groupBy(purchases.source)

  const [settled] = await db
    .select({
      buyers: sql<number>`count(distinct ${purchases.email})`,
      first: sql<number | null>`min(${purchases.createdAt})`,
      last: sql<number | null>`max(${purchases.createdAt})`,
    })
    .from(purchases)
    .where(where ? and(where, eq(purchases.status, ENTITLING_STATUS)) : eq(purchases.status, ENTITLING_STATUS))

  const statusBuckets = emptyBuckets(PURCHASE_STATUSES)
  const sourceBuckets = emptyBuckets(SALE_SOURCES)

  let count = 0
  let gross = 0
  let returned = 0
  let activeCount = 0

  for (const row of byStatus) {
    statusBuckets[row.status] = { count: row.count, total: row.total }
    count += row.count
    if (SETTLED_STATUSES.includes(row.status as PurchaseStatus)) {
      gross += row.total
    }
    if (row.status === 'refunded') {
      returned += row.returned
    }
    if (row.status === 'charged_back') {
      returned += row.total
    }
    if (row.status === ENTITLING_STATUS) {
      activeCount = row.count
    }
  }

  for (const row of bySource) {
    sourceBuckets[row.source] = { count: row.count, total: row.total }
  }

  // D1 gives a unix-second integer back for a `min()`/`max()` over a timestamp column: Drizzle's
  // `mode: 'timestamp'` mapping applies to the column, not to an aggregate over it.
  const toIso = (seconds: number | null | undefined) =>
    typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null

  return {
    currency: CURRENCY,
    environment: resolveEnvironment(env),
    count,
    active_count: activeCount,
    gross,
    returned,
    net: gross - returned,
    buyers: settled?.buyers ?? 0,
    by_status: statusBuckets,
    by_source: sourceBuckets,
    first_sale_at: toIso(settled?.first),
    last_sale_at: toIso(settled?.last),
  }
}

export { createManualSale, refundSale, SETTLED_STATUSES, summarizeSales, updateSaleDetails }
export type { CreateManualSaleInput, RefundSaleInput, SalesSummary, UpdateSaleInput }
