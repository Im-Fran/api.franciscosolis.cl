import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { PAGINATION, PURCHASE_STATUSES } from '@/lib/config'
import { CURRENCY } from '@/lib/pricing'
import { findApplicationById } from '@/services/applications'
import { listDownloadsForApplication } from '@/services/downloads'
import { listPurchases, toAdminPurchase } from '@/services/purchases'

/**
 * What came in, and what went out with it.
 *
 * Read-only on purpose. A payment is the provider's record of a fact, and an endpoint that let an
 * editor mark one `approved` would be an endpoint that grants a licence without a payment — the exact
 * thing the webhook's signature check exists to prevent. A refund is issued in MercadoPago's own
 * console and arrives here as a notification, which is the only way this column should ever change.
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
      data: rows.map(toAdminPurchase),
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

app.get(
  '/applications/:applicationId/downloads',
  describeRoute({
    description:
      'Served downloads of one application, newest first, with the version and filename as they were at the time and whether the download was a paid one.',
    tags: ['Admin · Store'],
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
      404: { description: 'No such application' },
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

    const application = await findApplicationById(db, c.req.param('applicationId'))
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    const rows = await listDownloadsForApplication(db, application.id, { limit, offset })
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
