import { and, count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { productReviewReports, productReviews } from '@/db/schema'
import type { AppEnv } from '@/env'
import { PAGINATION } from '@/lib/config'
import { replySchema, REPORT_STATUSES, reportResolutionSchema, REVIEW_STATUSES } from '@/lib/reviews'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import type { Product } from '@/services/products'
import { findProductById } from '@/services/products'
import { findReviewById, listReviews, toAdminReview, type ReviewSort } from '@/services/reviews'

/**
 * Moderation: hiding, deleting, answering, and the queue of what readers flagged.
 *
 * Two shapes here are deliberate and both mirror something that already exists in this Worker.
 *
 * Per-product routes are nested under `:productId`, like the releases and the wiki, so a review of
 * one product cannot be hidden through another's URL. The **reports queue is not**, exactly as
 * `GET /admin/purchases` is not: it answers "what needs moderating anywhere", which is the only
 * thing it is for, and nesting it would mean checking every product to find the one with a problem.
 *
 * Hiding and deleting are separate events rather than one `review.moderated`. One is reversible and
 * one is not, and "how often does somebody's review get removed here" is a question whose answer
 * matters.
 */
const app = new Hono<AppEnv>()

const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

const requireReview = async (db: Database, product: Product, id: string) => {
  const review = await findReviewById(db, product.id, id)
  if (!review) {
    throw new HTTPException(404, { message: 'Review not found' })
  }
  return review
}

const reviewShape = v.looseObject({ id: v.string(), rating: v.number(), status: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(reviewShape) })
const itemResponseSchema = v.object({ code: v.literal(200), data: reviewShape })

app.get(
  '/products/:productId/reviews',
  describeRoute({
    description:
      'Every review of one product, hidden ones included, with the reporter counts beside them. Unlike the public listing this one carries the reviewer\'s address — a moderator may need to reach them.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reviews', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator(
    'query',
    v.object({
      status: v.optional(v.picklist(REVIEW_STATUSES)),
      sort: v.optional(v.picklist(['recent', 'rating_desc', 'rating_asc'])),
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { status, sort = 'recent', limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const rows = await listReviews(db, {
      productId: product.id,
      status,
      sort: sort as ReviewSort,
      limit,
      offset,
    })
    return c.json({ code: 200, data: rows.map(toAdminReview) })
  },
)

const hideSchema = v.object({
  reason: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(300)))),
})

app.post(
  '/products/:productId/reviews/:id/hide',
  describeRoute({
    description:
      'Hides a review: invisible publicly and counted toward no average, but still there to be looked at and still reversible. Deleting is the other door, and it is not.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The hidden review', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or review' },
    },
  }),
  validator('json', hideSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))
    const review = await requireReview(db, product, c.req.param('id'))

    const fields = { status: 'hidden', hiddenAt: now, hiddenBy: editor.email, hiddenReason: body.reason ?? null }
    await db.update(productReviews).set({ ...fields, updatedAt: now }).where(eq(productReviews.id, review.id))

    await recordAudit(db, {
      event: 'review.hidden',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_reviews',
      resourceId: review.id,
      metadata: { product: product.slug, rating: review.rating, reason: body.reason ?? null },
    })

    return c.json({ code: 200, data: toAdminReview({ ...review, ...fields, updatedAt: now }) })
  },
)

app.post(
  '/products/:productId/reviews/:id/unhide',
  describeRoute({
    description: 'Puts a hidden review back. It counts toward the average again from that moment.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The review', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or review' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))
    const review = await requireReview(db, product, c.req.param('id'))

    const fields = { status: 'visible', hiddenAt: null, hiddenBy: null, hiddenReason: null }
    await db.update(productReviews).set({ ...fields, updatedAt: now }).where(eq(productReviews.id, review.id))

    await recordAudit(db, {
      event: 'review.unhidden',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_reviews',
      resourceId: review.id,
      metadata: { product: product.slug },
    })

    return c.json({ code: 200, data: toAdminReview({ ...review, ...fields, updatedAt: now }) })
  },
)

app.delete(
  '/products/:productId/reviews/:id',
  describeRoute({
    description:
      'Deletes a review outright, and its reports with it. Irreversible, which is why hiding exists; the audit entry snapshots what was removed, because nothing else will.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The review was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or review' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const review = await requireReview(db, product, c.req.param('id'))

    await db.delete(productReviews).where(eq(productReviews.id, review.id))

    await recordAudit(db, {
      event: 'review.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_reviews',
      resourceId: review.id,
      // Snapshotted because the row is gone: an audit entry that only says "a review was deleted"
      // cannot answer the one question anybody asks afterwards.
      metadata: {
        product: product.slug,
        rating: review.rating,
        title: review.title,
        body: review.body,
        author: review.email,
      },
    })

    return c.body(null, 204)
  },
)

app.put(
  '/products/:productId/reviews/:id/reply',
  describeRoute({
    description:
      'Writes the product owner\'s public answer to a review, creating it or replacing the one already there. One per review — the page prints the product\'s name beside it, never the editor\'s address.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The review with its reply', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or review' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', replySchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))
    const review = await requireReview(db, product, c.req.param('id'))

    const fields = {
      replyBody: body.body,
      replyBy: editor.email,
      // Kept from the first answer, so editing a typo does not re-date the reply.
      replyAt: review.replyAt ?? now,
      replyUpdatedAt: now,
    }
    await db.update(productReviews).set(fields).where(eq(productReviews.id, review.id))

    await recordAudit(db, {
      event: 'review.replied',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_reviews',
      resourceId: review.id,
      metadata: { product: product.slug, edited: review.replyBody !== null },
    })

    return c.json({ code: 200, data: toAdminReview({ ...review, ...fields }) })
  },
)

app.delete(
  '/products/:productId/reviews/:id/reply',
  describeRoute({
    description: 'Removes the owner\'s answer, leaving the review itself alone.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The reply was removed' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, review or reply' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const review = await requireReview(db, product, c.req.param('id'))
    if (!review.replyBody) {
      throw new HTTPException(404, { message: 'Reply not found' })
    }

    await db
      .update(productReviews)
      .set({ replyBody: null, replyBy: null, replyAt: null, replyUpdatedAt: null })
      .where(eq(productReviews.id, review.id))

    await recordAudit(db, {
      event: 'review.reply_deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_reviews',
      resourceId: review.id,
      metadata: { product: product.slug },
    })

    return c.body(null, 204)
  },
)

const reportShape = v.looseObject({ id: v.string(), reason: v.string(), status: v.string() })

/**
 * Cross-product, deliberately, exactly like `GET /admin/purchases`. It answers "what needs
 * moderating anywhere", and nesting it under a product would mean opening every product to find
 * the one with a problem.
 */
app.get(
  '/reviews/reports',
  describeRoute({
    description:
      'The moderation queue, across every product: what readers flagged and why, newest first. Filter by `status` to see what is still open.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reports', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: v.array(reportShape) })) } } },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator(
    'query',
    v.object({
      status: v.optional(v.picklist(REPORT_STATUSES)),
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { status, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)

    const rows = await db
      .select()
      .from(productReviewReports)
      .where(status ? eq(productReviewReports.status, status) : undefined)
      .orderBy(desc(productReviewReports.createdAt))
      .limit(limit)
      .offset(offset)

    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id,
        review_id: row.reviewId,
        product_id: row.productId,
        reason: row.reason,
        note: row.note,
        status: row.status,
        reporter: { id: row.reporterUserId, email: row.reporterEmail },
        resolved_at: row.resolvedAt?.toISOString() ?? null,
        resolved_by: row.resolvedBy,
        resolution_note: row.resolutionNote,
        created_at: row.createdAt.toISOString(),
      })),
    })
  },
)

app.patch(
  '/reviews/reports/:id',
  describeRoute({
    description:
      'Resolves one report: `dismissed` when the review is fine, `actioned` when it was hidden or deleted because of it. A resolved report stops counting toward the review\'s report count.',
    tags: ['Admin · Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The resolved report' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such report' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', reportResolutionSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const [report] = await db
      .select()
      .from(productReviewReports)
      .where(eq(productReviewReports.id, c.req.param('id')))
      .limit(1)
    if (!report) {
      throw new HTTPException(404, { message: 'Report not found' })
    }

    await db
      .update(productReviewReports)
      .set({
        status: body.status,
        resolvedAt: now,
        resolvedBy: editor.email,
        resolutionNote: body.resolution_note ?? null,
      })
      .where(eq(productReviewReports.id, report.id))

    // Recounted from the table rather than decremented, so the denormalised number on the review
    // cannot drift away from the reports it is supposed to describe.
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(productReviewReports)
      .where(and(eq(productReviewReports.reviewId, report.reviewId), eq(productReviewReports.status, 'open')))
    await db.update(productReviews).set({ reportCount: total }).where(eq(productReviews.id, report.reviewId))

    await recordAudit(db, {
      event: 'report.resolved',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_review_reports',
      resourceId: report.id,
      metadata: { review: report.reviewId, status: body.status, reason: report.reason },
    })

    return c.json({ code: 200, data: { id: report.id, status: body.status } })
  },
)

export default app
