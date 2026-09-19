import { and, desc, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { purchases } from '@/db/schema'
import { ENTITLING_STATUS, type PurchaseStatus } from '@/lib/config'
import { CURRENCY } from '@/lib/pricing'
import {
  describeWithdrawal,
  isLinkedToAccount,
  type PaymentEnvironment,
  type RefundReason,
  type SaleSource,
} from '@/lib/sales'

type Purchase = typeof purchases.$inferSelect

/**
 * One payment as its own buyer reads it back.
 *
 * `preference_id` and the provider's ids are in here on purpose: they are what somebody quotes at
 * support when a payment went missing, and they are not secrets — a MercadoPago payment id is only
 * useful to the account that owns it and to us. The metadata blob is not exposed: it is ours.
 */
const toPublicPurchase = (purchase: Purchase) => ({
  id: purchase.id,
  application_id: purchase.applicationId,
  application_slug: purchase.applicationSlug,
  kind: purchase.kind,
  status: purchase.status,
  /** Whether this row is what currently entitles the account to a download. */
  active: purchase.status === ENTITLING_STATUS,
  amount: purchase.amount,
  currency: purchase.currency,
  provider: purchase.provider,
  /** How the money arrived. A buyer's own receipt should say "cash" when it was cash. */
  source: purchase.source,
  /** What went back, when something did. Null on a sale that was never refunded. */
  refunded_amount: purchase.refundedAmount,
  payment_id: purchase.paymentId,
  reference: purchase.externalReference,
  approved_at: purchase.approvedAt?.toISOString() ?? null,
  refunded_at: purchase.refundedAt?.toISOString() ?? null,
  charged_back_at: purchase.chargedBackAt?.toISOString() ?? null,
  created_at: purchase.createdAt.toISOString(),
  updated_at: purchase.updatedAt.toISOString(),
})

/**
 * Same row for an editor, with the buyer on it. The admin list is a revenue and support screen.
 *
 * Three things are here and not on the buyer's copy, for one reason each: `environment` is ours and
 * would mean nothing to them, `note` is what an editor wrote about the sale rather than to them, and
 * `withdrawal` is the statutory window — it is the answer to "may I still refund this", and an
 * editor who has to work it out from a date will work it out wrongly.
 */
const toAdminPurchase = (purchase: Purchase, now: Date = new Date()) => ({
  ...toPublicPurchase(purchase),
  user_id: purchase.userId,
  /** Whether the sale is tied to an SSO account, or so far only to an address. */
  linked_to_account: isLinkedToAccount(purchase.userId),
  email: purchase.email,
  environment: purchase.environment,
  preference_id: purchase.preferenceId,
  refund_reason: purchase.refundReason,
  refunded_by: purchase.refundedBy,
  refund_id: purchase.refundId,
  note: purchase.note,
  created_by: purchase.createdBy,
  withdrawal: describeWithdrawal(purchase.approvedAt, now),
  metadata: purchase.metadata ? (JSON.parse(purchase.metadata) as Record<string, unknown>) : null,
})

type CreatePurchaseInput = {
  applicationId: string
  applicationSlug: string
  kind: 'purchase' | 'donation'
  userId: string
  email: string
  amount: number
  /**
   * Which MercadoPago account is about to be charged.
   *
   * Passed in rather than read off `env` here, so the one module that knows the configuration
   * (`lib/mercadopago.ts`) is the only one that decides — and so a test payment can never be
   * recorded as live by a service that guessed.
   */
  environment: PaymentEnvironment
  metadata?: Record<string, unknown>
}

/**
 * Opens a purchase in `pending` before the buyer is ever sent to MercadoPago.
 *
 * The row exists first, and its id *is* the `external_reference`, which is what makes the webhook
 * able to find it. Creating the row after the redirect would leave a window in which a payment can
 * arrive for something this database has never heard of — and that window is exactly where a
 * successful payment goes missing.
 */
const createPendingPurchase = async (db: Database, input: CreatePurchaseInput): Promise<Purchase> => {
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    applicationId: input.applicationId,
    applicationSlug: input.applicationSlug,
    kind: input.kind,
    userId: input.userId,
    email: input.email.toLowerCase(),
    status: 'pending' as PurchaseStatus,
    amount: input.amount,
    currency: CURRENCY,
    provider: 'mercadopago',
    source: 'mercadopago' as SaleSource,
    environment: input.environment,
    preferenceId: null,
    paymentId: null,
    externalReference: crypto.randomUUID(),
    approvedAt: null,
    refundedAt: null,
    refundedAmount: null,
    refundReason: null,
    refundedBy: null,
    refundId: null,
    chargedBackAt: null,
    chargebackId: null,
    note: null,
    createdBy: null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: now,
    updatedAt: now,
  }

  await db.insert(purchases).values(row)
  return row
}

/** Attaches the Checkout Pro preference to the row it was created for. */
const attachPreference = async (db: Database, id: string, preferenceId: string) => {
  await db.update(purchases).set({ preferenceId, updatedAt: new Date() }).where(eq(purchases.id, id))
}

const findPurchaseById = async (db: Database, id: string): Promise<Purchase | null> => {
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1)
  return purchase ?? null
}

const findPurchaseByReference = async (db: Database, reference: string): Promise<Purchase | null> => {
  const [purchase] = await db
    .select()
    .from(purchases)
    .where(eq(purchases.externalReference, reference))
    .limit(1)
  return purchase ?? null
}

/** The fallback lookup for a notification whose payment carries no external reference of ours. */
const findPurchaseByPaymentId = async (db: Database, paymentId: string): Promise<Purchase | null> => {
  const [purchase] = await db.select().from(purchases).where(eq(purchases.paymentId, paymentId)).limit(1)
  return purchase ?? null
}

/**
 * The same lookup for the several payment ids an order or a chargeback can name.
 *
 * An order settles with one payment here — there is a single item and no split — but the API models a
 * list, and a chargeback names every payment being disputed. Taking the first row that matches keeps
 * a partially-paid order from being silently ignored, which is the failure that would leave somebody
 * who paid without their download.
 */
const findPurchaseByAnyPaymentId = async (db: Database, paymentIds: readonly string[]): Promise<Purchase | null> => {
  if (paymentIds.length === 0) {
    return null
  }
  const [purchase] = await db
    .select()
    .from(purchases)
    .where(inArray(purchases.paymentId, [...paymentIds]))
    .limit(1)
  return purchase ?? null
}

/**
 * Writes the provider's verdict onto the row.
 *
 * Every timestamp here is stamped once and kept. `approvedAt` survives a later refund or chargeback
 * rather than being erased, because "this was paid, and then it was taken back" is what a receipt, a
 * dispute and an accountant all need — a row that only remembers its current state cannot answer when
 * the money arrived. The same rule gives `refundedAt` and `chargedBackAt` a column each: they are
 * different events with different consequences, and one of them has a deadline attached.
 */
const applyPaymentStatus = async (
  db: Database,
  purchase: Purchase,
  input: {
    status: PurchaseStatus
    paymentId?: string | null
    amount?: number | null
    chargebackId?: string | null
    /** What went back. Defaults to the whole sale on a refund, because that is the usual one. */
    refundedAmount?: number | null
    refundReason?: RefundReason | null
    /** Editor who issued it. Null when the refund was made in the provider's console. */
    refundedBy?: string | null
    refundId?: string | null
  },
): Promise<Purchase> => {
  const now = new Date()
  const refunding = input.status === 'refunded'
  const updated: Purchase = {
    ...purchase,
    status: input.status,
    paymentId: input.paymentId ?? purchase.paymentId,
    amount: input.amount ?? purchase.amount,
    chargebackId: input.chargebackId ?? purchase.chargebackId,
    approvedAt: input.status === ENTITLING_STATUS ? (purchase.approvedAt ?? now) : purchase.approvedAt,
    refundedAt: refunding ? (purchase.refundedAt ?? now) : purchase.refundedAt,
    // A refund that names no amount refunded everything, which is what the provider's console does
    // and what a notification carries no figure for. Stamped once, like every other timestamp here.
    refundedAmount: refunding
      ? (purchase.refundedAmount ?? input.refundedAmount ?? purchase.amount)
      : purchase.refundedAmount,
    refundReason: refunding ? (purchase.refundReason ?? input.refundReason ?? null) : purchase.refundReason,
    refundedBy: refunding ? (purchase.refundedBy ?? input.refundedBy ?? null) : purchase.refundedBy,
    refundId: refunding ? (purchase.refundId ?? input.refundId ?? null) : purchase.refundId,
    chargedBackAt: input.status === 'charged_back' ? (purchase.chargedBackAt ?? now) : purchase.chargedBackAt,
    updatedAt: now,
  }

  await db
    .update(purchases)
    .set({
      status: updated.status,
      paymentId: updated.paymentId,
      amount: updated.amount,
      chargebackId: updated.chargebackId,
      approvedAt: updated.approvedAt,
      refundedAt: updated.refundedAt,
      refundedAmount: updated.refundedAmount,
      refundReason: updated.refundReason,
      refundedBy: updated.refundedBy,
      refundId: updated.refundId,
      chargedBackAt: updated.chargedBackAt,
      updatedAt: updated.updatedAt,
    })
    .where(eq(purchases.id, purchase.id))

  return updated
}

/**
 * The entitlement, resolved from the payments themselves.
 *
 * Matched on the account id *or* the verified address, and that second half is what makes a purchase
 * survive the account it was made on: somebody who paid, lost access to that sign-in provider and came
 * back through a magic link on the same address keeps what they bought. The address is only ever one
 * this Worker verified on a token, never one a client sent.
 */
const findActivePurchase = async (
  db: Database,
  applicationId: string,
  account: { id: string; email: string },
): Promise<Purchase | null> => {
  const [purchase] = await db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.applicationId, applicationId),
        eq(purchases.status, ENTITLING_STATUS),
        or(eq(purchases.userId, account.id), eq(purchases.email, account.email.toLowerCase())),
      ),
    )
    .orderBy(desc(purchases.approvedAt))
    .limit(1)
  return purchase ?? null
}

/** Everything one account ever paid for, newest first. The purchase history. */
const listPurchasesForAccount = async (
  db: Database,
  account: { id: string; email: string },
  page: { limit: number; offset: number },
): Promise<Purchase[]> =>
  db
    .select()
    .from(purchases)
    .where(or(eq(purchases.userId, account.id), eq(purchases.email, account.email.toLowerCase())))
    .orderBy(desc(purchases.createdAt))
    .limit(page.limit)
    .offset(page.offset)

type PurchaseFilters = {
  applicationId?: string
  status?: PurchaseStatus
  email?: string
  /** How the money arrived: what separates a cash sale from a card one in a listing. */
  source?: SaleSource
  /** Which MercadoPago account took it. The filter a revenue screen sets to hide test payments. */
  environment?: PaymentEnvironment
  kind?: 'purchase' | 'donation'
  /** Inclusive lower bound on `created_at`. */
  from?: Date
  /** Inclusive upper bound on `created_at`. */
  to?: Date
  limit: number
  offset: number
}

/** Every clause a sales listing and its totals have to agree on, built once for both. */
const purchaseClauses = (filters: Omit<PurchaseFilters, 'limit' | 'offset'>): SQL[] => {
  const clauses: SQL[] = []
  if (filters.applicationId) {
    clauses.push(eq(purchases.applicationId, filters.applicationId))
  }
  if (filters.status) {
    clauses.push(eq(purchases.status, filters.status))
  }
  if (filters.email) {
    clauses.push(eq(purchases.email, filters.email.toLowerCase()))
  }
  if (filters.source) {
    clauses.push(eq(purchases.source, filters.source))
  }
  if (filters.environment) {
    clauses.push(eq(purchases.environment, filters.environment))
  }
  if (filters.kind) {
    clauses.push(eq(purchases.kind, filters.kind))
  }
  if (filters.from) {
    clauses.push(gte(purchases.createdAt, filters.from))
  }
  if (filters.to) {
    clauses.push(lte(purchases.createdAt, filters.to))
  }
  return clauses
}

/**
 * The editorial listing: every payment, newest first, narrowed by the filters above.
 *
 * The clause builder is shared with `summarizeSales` on purpose. A summary computed over a different
 * `WHERE` than the table under it is a screen whose total does not match its rows, and that is the
 * one bug in a revenue view nobody forgives.
 */
const listPurchases = async (db: Database, filters: PurchaseFilters): Promise<Purchase[]> => {
  const clauses = purchaseClauses(filters)

  return db
    .select()
    .from(purchases)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(purchases.createdAt))
    .limit(filters.limit)
    .offset(filters.offset)
}

export {
  applyPaymentStatus,
  purchaseClauses,
  attachPreference,
  createPendingPurchase,
  findActivePurchase,
  findPurchaseByAnyPaymentId,
  findPurchaseById,
  findPurchaseByPaymentId,
  findPurchaseByReference,
  listPurchases,
  listPurchasesForAccount,
  toAdminPurchase,
  toPublicPurchase,
}
export type { CreatePurchaseInput, Purchase, PurchaseFilters }
