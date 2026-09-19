import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { PAGINATION, PURCHASE_STATUSES } from '@/lib/config'
import { CURRENCY } from '@/lib/pricing'
import { listPurchases, toAdminPurchase } from '@/services/purchases'

/**
 * What came in, and what went out with it.
 *
 * Read-only, and cross-application: it is the "everything that ever came in" screen, whatever product
 * it came in for. Administering the sales *of one application* — recording one taken in cash, issuing
 * and re-sending its voucher, refunding it — is `routes/admin/sales.ts`, which is nested under the
 * application for the same reason the updates and the wiki are.
 *
 * Nothing here writes, and that is not because writing a payment is forbidden outright: it is because
 * this listing spans applications and a total over it is the only thing it is for. The narrow set of
 * writes that are allowed, why they are allowed at all, and what stays refused are documented on that
 * file.
 */
const app = new Hono<AppEnv>()

const purchaseSchema = v.looseObject({ id: v.string(), status: v.string(), amount: v.number(), email: v.string() })

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(purchaseSchema),
  /** Totals over the rows returned, so a revenue screen needs no second request. */
  summary: v.object({
    currency: v.string(),
    count: v.number(),
    approved_count: v.number(),
    approved_total: v.number(),
  }),
})

app.get(
  '/purchases',
  describeRoute({
    description:
      'Every payment taken through this service, newest first, narrowed by application, status or buyer address. Read-only: a payment\'s status is the provider\'s to change, and it arrives over the webhook.',
    tags: ['Admin · Store'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Payments and their totals', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator(
    'query',
    v.object({
      application_id: v.optional(v.string()),
      status: v.optional(v.picklist(PURCHASE_STATUSES)),
      email: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { application_id: applicationId, status, email, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')

    const rows = await listPurchases(getDb(c.env), { applicationId, status, email, limit, offset })
    const approved = rows.filter((row) => row.status === 'approved')

    return c.json({
      code: 200,
      // Wrapped rather than passed by reference: `toAdminPurchase` takes an optional `now`, which
      // `Array.prototype.map` would fill with the index.
      data: rows.map((row) => toAdminPurchase(row)),
      summary: {
        currency: CURRENCY,
        count: rows.length,
        approved_count: approved.length,
        // Over this page only, and named so: a total over a paginated listing that claimed to be the
        // lifetime figure is a number somebody would quote.
        approved_total: approved.reduce((total, row) => total + row.amount, 0),
      },
    })
  },
)

export default app
