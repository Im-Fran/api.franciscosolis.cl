import { renderSaleReceiptEmail, resolveEmailLocale } from '@franciscosolis/emails'
import { and, desc, eq, like, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { saleVouchers } from '@/db/schema'
import type { Env } from '@/env'
import { isUniqueViolation } from '@/lib/errors'
import { formatVoucherNumber, parseSaleSource, voucherNumberPrefix, type VoucherStatus } from '@/lib/sales'
import { formatMailDate, sendMail } from '@/services/mail'
import type { Purchase } from '@/services/purchases'

/**
 * The voucher: the receipt for a sale, as a row and as an email.
 *
 * Three rules hold this together and none of them are convenience:
 *
 * 1. **A voucher is a document, not a view of the sale.** Everything it prints — the amount, the
 *    address, the product's name — is copied onto the row when it is issued. A receipt emailed
 *    in March has to still say in December what it said then, for a sale whose price has since
 *    changed and whose product page may since have been deleted.
 * 2. **It is never edited.** Every copy already in an inbox would become a forgery of the row.
 *    Correcting one means voiding it and issuing the next, which is the whole reason `status` exists.
 * 3. **At most one is live per sale.** Two valid receipts for one payment is how the same sale gets
 *    claimed twice, so issuing voids whatever was live first, in that order.
 */

type Voucher = typeof saleVouchers.$inferSelect

/** How many times a colliding number is retried before the caller sees a failure. */
const NUMBER_ATTEMPTS = 5

/**
 * Allocates the next voucher number for the current year.
 *
 * Counted out of the table rather than kept in a counter row, because a counter is a second thing
 * that can disagree with the vouchers themselves and there is no volume here that makes the count
 * expensive. The unique index is what actually guarantees the number, which is why the caller
 * retries on a collision rather than locking: two editors issuing at the same moment both read the
 * same count, one of them loses the insert, and the loser simply counts again.
 *
 * `LIKE 'FS-2026-%'` rather than a range on `issued_at`: the number carries its own year, and a
 * voucher whose issue timestamp was corrected must not change which sequence it belongs to.
 */
const nextVoucherNumber = async (db: Database, year: number): Promise<string> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(saleVouchers)
    .where(like(saleVouchers.number, `${voucherNumberPrefix(year)}%`))

  return formatVoucherNumber(year, (row?.count ?? 0) + 1)
}

/** The live voucher of a sale, if it has one. */
const findLiveVoucher = async (db: Database, purchaseId: string): Promise<Voucher | null> => {
  const [voucher] = await db
    .select()
    .from(saleVouchers)
    .where(and(eq(saleVouchers.purchaseId, purchaseId), eq(saleVouchers.status, 'issued')))
    .orderBy(desc(saleVouchers.issuedAt))
    .limit(1)
  return voucher ?? null
}

const findVoucherById = async (db: Database, id: string): Promise<Voucher | null> => {
  const [voucher] = await db.select().from(saleVouchers).where(eq(saleVouchers.id, id)).limit(1)
  return voucher ?? null
}

/** Marks a voucher void. Idempotent: voiding one twice keeps the first reason and the first date. */
const voidVoucher = async (
  db: Database,
  voucher: Voucher,
  input: { by: string | null; reason: string | null },
): Promise<Voucher> => {
  if (voucher.status === 'void') {
    return voucher
  }

  const now = new Date()
  const updated: Voucher = {
    ...voucher,
    status: 'void' as VoucherStatus,
    voidedAt: now,
    voidedBy: input.by,
    voidReason: input.reason,
    updatedAt: now,
  }

  await db
    .update(saleVouchers)
    .set({
      status: updated.status,
      voidedAt: updated.voidedAt,
      voidedBy: updated.voidedBy,
      voidReason: updated.voidReason,
      updatedAt: now,
    })
    .where(eq(saleVouchers.id, voucher.id))

  return updated
}

type IssueVoucherInput = {
  purchase: Purchase
  /** Name of the product as the receipt should print it. Snapshotted onto the row. */
  productName: string
  /** Editor issuing it, or null when the payment's own approval did. */
  issuedBy: string | null
  /** Language the receipt is written in. Falls back to English, as every template does. */
  locale?: string | null
  /** Address to issue to, when it differs from the sale's — a corrected typo, a second copy. */
  email?: string | null
}

/**
 * Issues a voucher for a sale, voiding whatever was live for it.
 *
 * The number is allocated and retried here rather than at the route, because a collision is not
 * something a caller can do anything useful about: it means somebody else issued in the same
 * instant, and the answer is to take the next number.
 */
const issueVoucher = async (db: Database, input: IssueVoucherInput): Promise<Voucher> => {
  const live = await findLiveVoucher(db, input.purchase.id)
  if (live) {
    await voidVoucher(db, live, { by: input.issuedBy, reason: 'superseded' })
  }

  const now = new Date()
  const year = now.getUTCFullYear()

  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt++) {
    const row: Voucher = {
      id: crypto.randomUUID(),
      number: await nextVoucherNumber(db, year),
      purchaseId: input.purchase.id,
      productId: input.purchase.productId,
      productSlug: input.purchase.productSlug,
      productName: input.productName,
      email: (input.email ?? input.purchase.email).toLowerCase(),
      kind: input.purchase.kind,
      amount: input.purchase.amount,
      currency: input.purchase.currency,
      source: input.purchase.source,
      status: 'issued' as VoucherStatus,
      locale: resolveEmailLocale(input.locale),
      issuedBy: input.issuedBy,
      issuedAt: now,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      sentCount: 0,
      lastSentAt: null,
      lastSentTo: null,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(saleVouchers).values(row)
      return row
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === NUMBER_ATTEMPTS - 1) {
        throw error
      }
    }
  }

  // Unreachable: the loop either returns or rethrows on its last attempt. Present because the
  // compiler cannot see that, and an exception says more than an implicit undefined.
  throw new Error('Could not allocate a voucher number')
}

/**
 * Emails a voucher and records that it went out.
 *
 * The count is bumped only after the send resolves. A voucher that says it was sent three times
 * when two of them failed is worse than one that says nothing — this number is read when somebody
 * insists they never received it.
 *
 * `to` overrides the address for one send without touching the row: somebody asking for their
 * receipt at a work address is not a correction to the sale. Changing the address the voucher is
 * *issued* to is a re-issue, which is a new number.
 */
const sendVoucher = async (
  db: Database,
  env: Env,
  voucher: Voucher,
  options: { to?: string | null } = {},
): Promise<Voucher> => {
  const to = (options.to ?? voucher.email).toLowerCase()
  const locale = resolveEmailLocale(voucher.locale)

  const rendered = await renderSaleReceiptEmail({
    voucherNumber: voucher.number,
    productName: voucher.productName,
    kind: voucher.kind === 'donation' ? 'donation' : 'purchase',
    amount: voucher.amount,
    currency: voucher.currency,
    source: parseSaleSource(voucher.source),
    // Formatted here rather than in the template: the package renders markup and does no date work,
    // and this is the one place that knows the recipient's language and the issue date together.
    issuedAt: formatMailDate(voucher.issuedAt, locale),
    reference: voucher.number,
    url: `${env.SITE_BASE_URL.replace(/\/+$/, '')}/product/${voucher.productSlug}`,
    locale,
    brandName: env.MAIL_FROM_NAME,
  })

  await sendMail(env, { to, subject: rendered.subject, html: rendered.html, text: rendered.text })

  const now = new Date()
  await db
    .update(saleVouchers)
    .set({ sentCount: voucher.sentCount + 1, lastSentAt: now, lastSentTo: to, updatedAt: now })
    .where(eq(saleVouchers.id, voucher.id))

  return { ...voucher, sentCount: voucher.sentCount + 1, lastSentAt: now, lastSentTo: to, updatedAt: now }
}

/**
 * Issues and sends the voucher for a payment the provider has just approved.
 *
 * Called from the webhook, which is why it swallows everything: the notification has to be answered
 * 200 or MercadoPago retries it forever, and a receipt that did not render is not a reason to
 * re-apply a payment that was already applied. A failure leaves the sale with no live voucher, which
 * is a state the editor can see and fix with one click — and which is exactly what "generate
 * voucher" is for.
 */
const issueVoucherForApproval = async (
  db: Database,
  env: Env,
  input: { purchase: Purchase; productName: string; locale?: string | null },
): Promise<Voucher | null> => {
  try {
    const existing = await findLiveVoucher(db, input.purchase.id)
    if (existing) {
      return existing
    }

    const voucher = await issueVoucher(db, {
      purchase: input.purchase,
      productName: input.productName,
      issuedBy: null,
      locale: input.locale,
    })
    return await sendVoucher(db, env, voucher)
  } catch (error) {
    console.error('failed to issue the voucher for an approved payment', input.purchase.id, error)
    return null
  }
}

type VoucherFilters = {
  productId?: string
  purchaseId?: string
  status?: VoucherStatus
  email?: string
  limit: number
  offset: number
}

/** The editorial listing, newest first. */
const listVouchers = async (db: Database, filters: VoucherFilters): Promise<Voucher[]> => {
  const clauses = [
    filters.productId ? eq(saleVouchers.productId, filters.productId) : undefined,
    filters.purchaseId ? eq(saleVouchers.purchaseId, filters.purchaseId) : undefined,
    filters.status ? eq(saleVouchers.status, filters.status) : undefined,
    filters.email ? eq(saleVouchers.email, filters.email.toLowerCase()) : undefined,
  ].filter((clause): clause is Exclude<typeof clause, undefined> => clause !== undefined)

  return db
    .select()
    .from(saleVouchers)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(saleVouchers.issuedAt))
    .limit(filters.limit)
    .offset(filters.offset)
}

/**
 * The receipts of one account, newest first.
 *
 * Matched on the address alone, because that is the only thing a voucher carries: it was issued to
 * an address and it printed that address, and a receipt is a document about an address rather than
 * about an account. The caller has verified it on a token — this is never an address a client sent.
 *
 * A void voucher is included on purpose. "I was sent this and you are telling me it is not valid" is
 * exactly the conversation the row exists to settle, and hiding it would leave the recipient holding
 * an email the system denies all knowledge of.
 */
const listVouchersForAccount = async (
  db: Database,
  account: { email: string },
  page: { limit: number; offset: number },
): Promise<Voucher[]> =>
  db
    .select()
    .from(saleVouchers)
    .where(eq(saleVouchers.email, account.email.toLowerCase()))
    .orderBy(desc(saleVouchers.issuedAt))
    .limit(page.limit)
    .offset(page.offset)

/** One voucher as its recipient reads it back. No editor, no void reason: those are ours. */
const toPublicVoucher = (voucher: Voucher) => ({
  id: voucher.id,
  number: voucher.number,
  purchase_id: voucher.purchaseId,
  product_slug: voucher.productSlug,
  product_name: voucher.productName,
  kind: voucher.kind,
  amount: voucher.amount,
  currency: voucher.currency,
  source: voucher.source,
  status: voucher.status,
  locale: voucher.locale,
  issued_at: voucher.issuedAt.toISOString(),
})

/** The same voucher for an editor: who issued it, where it was sent and how often. */
const toAdminVoucher = (voucher: Voucher) => ({
  ...toPublicVoucher(voucher),
  product_id: voucher.productId,
  email: voucher.email,
  issued_by: voucher.issuedBy,
  voided_at: voucher.voidedAt?.toISOString() ?? null,
  voided_by: voucher.voidedBy,
  void_reason: voucher.voidReason,
  sent_count: voucher.sentCount,
  last_sent_at: voucher.lastSentAt?.toISOString() ?? null,
  last_sent_to: voucher.lastSentTo,
  created_at: voucher.createdAt.toISOString(),
  updated_at: voucher.updatedAt.toISOString(),
})

export {
  findLiveVoucher,
  findVoucherById,
  issueVoucher,
  issueVoucherForApproval,
  listVouchers,
  listVouchersForAccount,
  nextVoucherNumber,
  sendVoucher,
  toAdminVoucher,
  toPublicVoucher,
  voidVoucher,
}
export type { IssueVoucherInput, Voucher, VoucherFilters }
