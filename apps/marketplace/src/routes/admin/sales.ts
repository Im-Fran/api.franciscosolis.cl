import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { PAGINATION, PURCHASE_STATUSES } from '@/lib/config'
import { LOCALES } from '@/lib/locales'
import { resolveEnvironment } from '@/lib/mercadopago'
import { AMOUNT_LIMITS, CURRENCY } from '@/lib/pricing'
import {
  isManualSource,
  isRefundable,
  MANUAL_SALE_SOURCES,
  PAYMENT_ENVIRONMENTS,
  REFUND_REASONS,
  SALE_SOURCES,
  type SaleSource,
  VOUCHER_STATUSES,
  WITHDRAWAL_DAYS,
} from '@/lib/sales'
import { dateInput } from '@/lib/validation'
import { findProductById, type Product } from '@/services/products'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { listDownloadsForProduct } from '@/services/downloads'
import { findPurchaseById, listPurchases, toAdminPurchase, type Purchase } from '@/services/purchases'
import { sendRefundNotice } from '@/services/mail'
import { notifyPurchaseCompleted, notifyPurchaseRefunded } from '@/services/notify'
import { createManualSale, refundSale, summarizeSales, updateSaleDetails } from '@/services/sales'
import {
  findVoucherById,
  issueVoucher,
  listVouchers,
  sendVoucher,
  toAdminVoucher,
  voidVoucher,
  type Voucher,
} from '@/services/vouchers'

/**
 * Administering the sales of **one product**.
 *
 * Every route here is nested under `/admin/products/:productId/…`, exactly like the updates
 * and the wiki, and for the same reason: it is what stops a sale of one product being read,
 * refunded or receipted through another's URL, and it makes a 404 mean the same thing whichever half
 * of the pair is wrong. The cross-product view is the older `GET /admin/purchases`, which stays
 * where it is — "everything that ever came in" and "the sales of this product" are two screens.
 *
 * **This file is the exception to "there is no endpoint that marks a payment approved", and the
 * exception is narrow.** The rule exists for the webhook, which is public and therefore believes
 * nothing it is told. Everything here sits behind `requireEditor`; a manual sale carries the
 * editor's address in `created_by`, a `source` that says on its face no provider was involved, and
 * an audit row. Money does change hands outside MercadoPago — cash, a transfer, a copy given away —
 * and the alternative to recording it is a spreadsheet nothing can refund from.
 *
 * What is still refused, on purpose: setting a status directly, editing an amount, and recording a
 * sale whose `source` claims MercadoPago took it.
 */
const app = new Hono<AppEnv>()

/** Resolves the product in the URL, or 404s. Every route below starts here. */
const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

/**
 * Resolves a sale *of this product*, or 404s.
 *
 * The product check is the point: a sale id from another product answers 404 rather than being
 * refunded through this URL, and an editor who has the wrong id in either position gets the same
 * answer either way.
 */
const requireSale = async (db: Database, productId: string, saleId: string): Promise<Purchase> => {
  const purchase = await findPurchaseById(db, saleId)
  if (!purchase || purchase.productId !== productId) {
    throw new HTTPException(404, { message: 'Sale not found' })
  }
  return purchase
}

/** Same rule for a voucher. */
const requireVoucher = async (db: Database, productId: string, voucherId: string): Promise<Voucher> => {
  const voucher = await findVoucherById(db, voucherId)
  if (!voucher || voucher.productId !== productId) {
    throw new HTTPException(404, { message: 'Voucher not found' })
  }
  return voucher
}

/** The name a voucher prints. Falls back to the slug for a product deleted since the sale. */
const productNameFor = (product: Product | null, purchase: Purchase): string =>
  product?.name ?? purchase.productSlug

const emailInput = v.pipe(v.string(), v.trim(), v.email(), v.maxLength(320))

const saleSchema = v.looseObject({ id: v.string(), status: v.string(), amount: v.number(), email: v.string() })
const voucherSchema = v.looseObject({ id: v.string(), number: v.string(), status: v.string() })

/* ── Listing and totals ─────────────────────────────────────────────────────── */

const saleFilterSchema = v.object({
  status: v.optional(v.picklist(PURCHASE_STATUSES)),
  source: v.optional(v.picklist(SALE_SOURCES)),
  environment: v.optional(v.picklist(PAYMENT_ENVIRONMENTS)),
  kind: v.optional(v.picklist(['purchase', 'donation'] as const)),
  email: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(320))),
  /** Inclusive bounds on when the sale was taken, as ISO dates. */
  from: v.optional(dateInput),
  to: v.optional(dateInput),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/products/:productId/sales/summary',
  describeRoute({
    description:
      'Totals over one product\'s sales, computed in the database over exactly the rows the listing with the same filters returns — not over a page of them. Three figures rather than one, because the question has three honest answers: `gross` is what ever settled, `returned` is what went back out (a refund at its refunded amount, a chargeback at the whole sale), and `net` is the difference. Also carries which MercadoPago account this service is currently configured against, so a screen can badge itself when it is looking at test money.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The totals',
        content: {
          'application/json': {
            schema: resolver(
              v.object({
                code: v.literal(200),
                data: v.looseObject({ currency: v.string(), gross: v.number(), net: v.number() }),
              }),
            ),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator('query', saleFilterSchema),
  async (c) => {
    const filters = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const summary = await summarizeSales(db, c.env, { ...filters, productId: product.id })
    return c.json({ code: 200, data: summary })
  },
)

app.get(
  '/products/:productId/sales',
  describeRoute({
    description:
      'One product\'s sales, newest first: payments taken through MercadoPago and sales recorded by hand alike, narrowed by status, source, environment, kind, buyer address or a date range. Each row carries the statutory withdrawal window, so a refund decision needs no date arithmetic.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The sales',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: v.array(saleSchema) })) } },
      },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator('query', saleFilterSchema),
  async (c) => {
    const { limit = PAGINATION.defaultLimit, offset = 0, ...filters } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const rows = await listPurchases(db, { ...filters, productId: product.id, limit, offset })
    const now = new Date()
    return c.json({ code: 200, data: rows.map((row) => toAdminPurchase(row, now)) })
  },
)

/* ── Recording a sale by hand ───────────────────────────────────────────────── */

const manualSaleSchema = v.object({
  /** Address the sale is filed under and the receipt goes to. */
  email: emailInput,
  /**
   * Where the money came from. `mercadopago` is not offered: a row claiming the provider took money
   * it has no record of would be indistinguishable from a real payment and grants the same access.
   */
  source: v.picklist(MANUAL_SALE_SOURCES),
  kind: v.optional(v.picklist(['purchase', 'donation'] as const)),
  /**
   * Whole pesos. Zero is allowed and is exactly what a gift is — the floor that applies to a
   * checkout is about the provider's fee eating the payment, and there is no provider here.
   */
  amount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(AMOUNT_LIMITS.max)),
  /** The SSO account, when it is known. Otherwise the sale is matched by its address. */
  user_id: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  /** Which stand, which transfer, who the copy was for. */
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1000))),
  /** An existing reference — a bank transfer id — so the row can be matched to a statement. */
  reference: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  /** When the money changed hands, if that was not now. Sets the withdrawal window too. */
  occurred_at: v.optional(dateInput),
  /** Language the receipt is written in. */
  locale: v.optional(v.picklist(LOCALES)),
  /** Whether to issue a voucher for it straight away. Defaults to true — a sale has a receipt. */
  issue_voucher: v.optional(v.boolean()),
  /** Whether to email that voucher. Defaults to true. */
  notify: v.optional(v.boolean()),
})

app.post(
  '/products/:productId/sales',
  describeRoute({
    description:
      'Records a sale that happened outside MercadoPago — cash, a bank transfer, or a copy given away — as an approved payment that entitles its recipient to the downloads exactly as a paid one does. Written approved and dated, because the money is already in; there is no pending state for cash. `occurred_at` backdates both the approval and the row, so the statutory withdrawal window runs from the day the sale really happened. Unless asked not to, it issues a voucher and emails it.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'The sale was recorded',
        content: {
          'application/json': {
            schema: resolver(
              v.object({
                code: v.literal(201),
                data: v.object({ sale: saleSchema, voucher: v.nullable(voucherSchema) }),
              }),
            ),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
      422: { description: 'The body is not a sale this service will record' },
      502: { description: 'The sale was recorded but its receipt could not be sent' },
    },
  }),
  validator('json', manualSaleSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const editor = c.get('editor')

    const sale = await createManualSale(db, {
      productId: product.id,
      productSlug: product.slug,
      productName: product.name,
      kind: body.kind ?? 'purchase',
      source: body.source,
      email: body.email,
      userId: body.user_id,
      amount: body.amount,
      note: body.note,
      reference: body.reference,
      occurredAt: body.occurred_at,
      createdBy: editor.email,
      environment: resolveEnvironment(c.env),
    })

    await recordAudit(db, {
      event: 'sale.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'purchases',
      resourceId: sale.id,
      // The amount and the source are in the trail on purpose: this is the one write in this Worker
      // that grants an entitlement without a provider's confirmation behind it, so what was granted
      // and on what basis has to be readable without joining back to a row that can still be edited.
      metadata: {
        product_id: product.id,
        source: sale.source,
        kind: sale.kind,
        amount: sale.amount,
        email: sale.email,
      },
    })

    // The bell, published before the voucher rather than after it: the send below can end this request
    // in a 502, and the sale it reports on is recorded either way. `notify: false` is the editor
    // saying "do not tell the buyer" — a gift being prepared, a sale being back-filled — and it is
    // honoured here too rather than read as being only about email. A sale for an address with no
    // account yet publishes nothing; see `notifyPurchaseCompleted`.
    if (body.notify !== false) {
      await notifyPurchaseCompleted(c.env, { purchase: sale, productName: product.name, locale: body.locale })
    }

    let voucher: Voucher | null = null
    if (body.issue_voucher !== false) {
      voucher = await issueVoucher(db, {
        purchase: sale,
        productName: product.name,
        issuedBy: editor.email,
        locale: body.locale,
      })
      await recordAudit(db, {
        event: 'voucher.issued',
        ...getActorContext(c),
        ...getRequestContext(c),
        resourceType: 'sale_vouchers',
        resourceId: voucher.id,
        metadata: { number: voucher.number, purchase_id: sale.id },
      })

      if (body.notify !== false) {
        try {
          voucher = await sendVoucher(db, c.env, voucher)
        } catch (error) {
          // The sale and the voucher are both written by now, and neither is wrong. Only the send
          // failed, so that is what the editor is told — and "Resend" is one click away on the same
          // screen. Rolling the sale back would lose a payment that genuinely happened.
          console.error('failed to email a voucher for a manual sale', voucher.id, error)
          throw new HTTPException(502, {
            message: 'The sale and its voucher were recorded, but the receipt could not be emailed',
          })
        }
      }
    }

    // The voucher travels *inside* `data` rather than beside it, unlike the `summary` on
    // `GET /admin/purchases`: every client here unwraps the envelope's `data` and drops its
    // siblings, so a sibling is a field only the OpenAPI document can see.
    return c.json(
      {
        code: 201,
        data: { sale: toAdminPurchase(sale), voucher: voucher ? toAdminVoucher(voucher) : null },
      },
      201,
    )
  },
)

/* ── One sale ───────────────────────────────────────────────────────────────── */

app.get(
  '/products/:productId/sales/:saleId',
  describeRoute({
    description:
      'One sale in full: the payment, the statutory withdrawal window, every voucher ever issued for it, and how much of it is refundable. What a support conversation about a payment is answered from.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The sale',
        content: {
          'application/json': {
            schema: resolver(
              v.object({
                code: v.literal(200),
                data: v.object({
                  sale: saleSchema,
                  vouchers: v.array(voucherSchema),
                  refund: v.looseObject({ refundable: v.boolean() }),
                }),
              }),
            ),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such sale of it' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const sale = await requireSale(db, product.id, c.req.param('saleId'))

    const vouchers = await listVouchers(db, { purchaseId: sale.id, limit: PAGINATION.maxLimit, offset: 0 })
    const environment = resolveEnvironment(c.env)

    const status = sale.status as (typeof PURCHASE_STATUSES)[number]

    return c.json({
      code: 200,
      data: {
        sale: toAdminPurchase(sale),
        vouchers: vouchers.map(toAdminVoucher),
        refund: {
          refundable: isRefundable(status) && sale.environment === environment,
          // Why not, when not, so the front-end never has to re-derive which rule refused it.
          reason: !isRefundable(status) ? 'status' : sale.environment !== environment ? 'environment' : null,
          withdrawal_days: WITHDRAWAL_DAYS,
          currency: CURRENCY,
        },
      },
    })
  },
)

const updateSaleSchema = v.object({
  email: v.optional(emailInput),
  user_id: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  note: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(1000)))),
})

app.patch(
  '/products/:productId/sales/:saleId',
  describeRoute({
    description:
      'Corrects the three things about a sale that can be wrong about the world rather than about the sale: a mistyped address, the SSO account it belongs to once that account exists, and the editor\'s note. The amount, the status, the source and the dates are deliberately not editable — correcting one of those is a refund and a new sale, not an edit. Changing the address does not re-send anything; issuing a new voucher does.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The sale', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: saleSchema })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such sale of it' },
    },
  }),
  validator('json', updateSaleSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const sale = await requireSale(db, product.id, c.req.param('saleId'))

    const updated = await updateSaleDetails(db, sale, {
      email: body.email,
      userId: body.user_id,
      note: body.note,
    })

    await recordAudit(db, {
      event: 'sale.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'purchases',
      resourceId: sale.id,
      metadata: { product_id: product.id, fields: Object.keys(body) },
    })

    return c.json({ code: 200, data: toAdminPurchase(updated) })
  },
)

/* ── Refunds ────────────────────────────────────────────────────────────────── */

const refundSchema = v.object({
  /**
   * Why the money is going back. `withdrawal` is the statutory *derecho a retracto* and is kept
   * distinct from the rest precisely so "how many of these were obligatory" stays answerable.
   */
  reason: v.picklist(REFUND_REASONS),
  /** A partial amount. Left out, the whole sale goes back, which is the usual case. */
  amount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(AMOUNT_LIMITS.max))),
  /** Whether to email the buyer that it happened. Defaults to true. */
  notify: v.optional(v.boolean()),
})

app.post(
  '/products/:productId/sales/:saleId/refund',
  describeRoute({
    description:
      'Gives a sale back, in full or in part. For a MercadoPago sale the provider is asked first and the row is written second — a row marked refunded for money that never moved is a buyer with no download and a charge. For a sale recorded by hand there is nothing to ask: the money goes back the way it arrived and this records that it did. The entitlement ends either way, and unless asked not to the buyer is emailed. Only an approved sale can be refunded, and only in the environment it was taken in.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The refunded sale', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: saleSchema })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such sale of it' },
      409: { description: 'This sale cannot be refunded in its current status, or was taken in the other environment' },
      422: { description: 'The amount is larger than the sale' },
      502: { description: 'The payment provider refused the refund' },
    },
  }),
  validator('json', refundSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const sale = await requireSale(db, product.id, c.req.param('saleId'))

    if (!isRefundable(sale.status as (typeof PURCHASE_STATUSES)[number])) {
      throw new HTTPException(409, { message: `A sale in status ${sale.status} cannot be refunded` })
    }

    const environment = resolveEnvironment(c.env)
    if (sale.environment !== environment) {
      // The provider answers 404 for an id from the other account, which is indistinguishable from a
      // payment that never existed — so this refuses first and says which rule refused it.
      throw new HTTPException(409, {
        message: `This sale was taken in the ${sale.environment} environment and this service is configured for ${environment}`,
      })
    }

    if (body.amount !== undefined && body.amount > sale.amount) {
      throw new HTTPException(422, { message: 'A refund cannot be larger than the sale' })
    }

    // A provider sale with no payment id cannot be refunded through the provider, and marking it
    // refunded anyway would record money as returned that nobody returned. It should not happen —
    // an approved payment always carries an id — so it is refused rather than worked around.
    if (!isManualSource(sale.source as SaleSource) && !sale.paymentId) {
      throw new HTTPException(409, {
        message: 'This sale has no provider payment id, so it cannot be refunded through MercadoPago',
      })
    }

    let refunded: Purchase
    try {
      refunded = await refundSale(db, c.env, {
        purchase: sale,
        amount: body.amount ?? null,
        reason: body.reason,
        refundedBy: c.get('editor').email,
      })
    } catch (error) {
      console.error('failed to refund a sale', sale.id, error)
      throw new HTTPException(502, { message: 'The payment provider refused the refund' })
    }

    await recordAudit(db, {
      event: 'sale.refunded',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'purchases',
      resourceId: sale.id,
      metadata: {
        product_id: product.id,
        reason: body.reason,
        amount: refunded.refundedAmount,
        source: sale.source,
        payment_id: sale.paymentId,
        refund_id: refunded.refundId,
      },
    })

    if (body.notify !== false) {
      const [live] = await listVouchers(db, { purchaseId: sale.id, status: 'issued', limit: 1, offset: 0 })
      try {
        await sendRefundNotice(c.env, {
          purchase: refunded,
          productName: product.name,
          reason: body.reason,
          voucherNumber: live?.number ?? null,
          locale: live?.locale ?? null,
        })
      } catch (error) {
        // The money is already back. A failed notice is worth logging and not worth turning into an
        // error the editor has to interpret as "did the refund happen?" — it did, and the answer to
        // that question must not depend on a mail binding.
        console.error('failed to email a refund notice', sale.id, error)
      }
      // Beside the email, and gated by the same `notify`. Never throws, like the notice above it.
      await notifyPurchaseRefunded(c.env, { purchase: refunded, productName: product.name, locale: live?.locale ?? null })
    }

    return c.json({ code: 200, data: toAdminPurchase(refunded) })
  },
)

/* ── Vouchers ───────────────────────────────────────────────────────────────── */

const issueVoucherSchema = v.object({
  /** Address to issue to, when it is not the sale's. A second copy for a work address. */
  email: v.optional(emailInput),
  locale: v.optional(v.picklist(LOCALES)),
  /** Whether to email it. Defaults to true. */
  notify: v.optional(v.boolean()),
})

app.post(
  '/products/:productId/sales/:saleId/vouchers',
  describeRoute({
    description:
      'Issues a voucher for a sale, voiding whatever was live for it and allocating the next number of the year. This is how a receipt is corrected — a voucher is never edited, because every copy already in an inbox would become a forgery of the row — and how one is produced for a sale whose automatic receipt failed to render or send.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The voucher', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(201), data: voucherSchema })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such sale of it' },
      502: { description: 'The voucher was issued but could not be emailed' },
    },
  }),
  validator('json', issueVoucherSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const sale = await requireSale(db, product.id, c.req.param('saleId'))
    const editor = c.get('editor')

    let voucher = await issueVoucher(db, {
      purchase: sale,
      productName: productNameFor(product, sale),
      issuedBy: editor.email,
      locale: body.locale,
      email: body.email,
    })

    await recordAudit(db, {
      event: 'voucher.issued',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'sale_vouchers',
      resourceId: voucher.id,
      metadata: { number: voucher.number, purchase_id: sale.id, email: voucher.email },
    })

    if (body.notify !== false) {
      try {
        voucher = await sendVoucher(db, c.env, voucher)
      } catch (error) {
        console.error('failed to email an issued voucher', voucher.id, error)
        throw new HTTPException(502, { message: 'The voucher was issued but could not be emailed' })
      }
    }

    return c.json({ code: 201, data: toAdminVoucher(voucher) }, 201)
  },
)

app.get(
  '/products/:productId/vouchers',
  describeRoute({
    description:
      'Every voucher ever issued for one product, newest first, including the voided ones — a voided receipt is exactly what a dispute about a receipt is settled with. Narrowed by status, by the sale it belongs to, or by the address it was issued to.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The vouchers', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: v.array(voucherSchema) })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator(
    'query',
    v.object({
      status: v.optional(v.picklist(VOUCHER_STATUSES)),
      sale_id: v.optional(v.string()),
      email: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(320))),
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { status, sale_id: saleId, email, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const rows = await listVouchers(db, {
      productId: product.id,
      purchaseId: saleId,
      status,
      email,
      limit,
      offset,
    })
    return c.json({ code: 200, data: rows.map(toAdminVoucher) })
  },
)

app.get(
  '/products/:productId/vouchers/:voucherId',
  describeRoute({
    description: 'One voucher, as it was issued and as it was last sent.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The voucher', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: voucherSchema })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such voucher of it' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const voucher = await requireVoucher(db, product.id, c.req.param('voucherId'))

    return c.json({ code: 200, data: toAdminVoucher(voucher) })
  },
)

app.post(
  '/products/:productId/vouchers/:voucherId/send',
  describeRoute({
    description:
      'Emails a voucher again, to the address it was issued to or to another one for this send only. The row is not changed by a different `email` — sending somebody a copy at their work address is not a correction to the receipt, and correcting the receipt is a re-issue with a new number. A voided voucher is refused: re-sending one is telling somebody an invalid receipt is valid.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The voucher, with its send count', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: voucherSchema })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such voucher of it' },
      409: { description: 'This voucher is void' },
      502: { description: 'The receipt could not be emailed' },
    },
  }),
  validator('json', v.object({ email: v.optional(emailInput) })),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const voucher = await requireVoucher(db, product.id, c.req.param('voucherId'))

    if (voucher.status !== 'issued') {
      throw new HTTPException(409, { message: 'A void voucher cannot be sent' })
    }

    let sent: Voucher
    try {
      sent = await sendVoucher(db, c.env, voucher, { to: body.email })
    } catch (error) {
      console.error('failed to resend a voucher', voucher.id, error)
      throw new HTTPException(502, { message: 'The receipt could not be emailed' })
    }

    await recordAudit(db, {
      event: 'voucher.sent',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'sale_vouchers',
      resourceId: voucher.id,
      metadata: { number: voucher.number, to: sent.lastSentTo, sent_count: sent.sentCount },
    })

    return c.json({ code: 200, data: toAdminVoucher(sent) })
  },
)

app.post(
  '/products/:productId/vouchers/:voucherId/void',
  describeRoute({
    description:
      'Voids a voucher without issuing a replacement — a receipt sent to the wrong person, or one for a sale that turned out not to be one. Voiding is idempotent and keeps the first reason and the first date. The voucher itself is never deleted: a receipt somebody holds has to remain explainable.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The voided voucher', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: voucherSchema })) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, or no such voucher of it' },
    },
  }),
  validator('json', v.object({ reason: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))) })),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const voucher = await requireVoucher(db, product.id, c.req.param('voucherId'))
    const editor = c.get('editor')

    const voided = await voidVoucher(db, voucher, { by: editor.email, reason: body.reason ?? null })

    await recordAudit(db, {
      event: 'voucher.voided',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'sale_vouchers',
      resourceId: voucher.id,
      metadata: { number: voucher.number, reason: voided.voidReason },
    })

    return c.json({ code: 200, data: toAdminVoucher(voided) })
  },
)

/* ── Downloads of one product ───────────────────────────────────────────── */

app.get(
  '/products/:productId/downloads',
  describeRoute({
    description:
      'Served downloads of one product, newest first, with the version and filename as they were at the time and whether the download was a paid one.',
    tags: ['Admin · Sales'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The downloads',
        content: {
          'application/json': {
            schema: resolver(
              v.object({ code: v.literal(200), data: v.array(v.looseObject({ id: v.string(), filename: v.string() })) }),
            ),
          },
        },
      },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator(
    'query',
    v.object({
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const rows = await listDownloadsForProduct(db, product.id, { limit, offset })
    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id,
        file_id: row.fileId,
        version: row.version,
        filename: row.filename,
        user_id: row.userId,
        purchase_id: row.purchaseId,
        paid: row.paid,
        created_at: row.createdAt.toISOString(),
      })),
    })
  },
)

export default app
