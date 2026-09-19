import { count, eq, and } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { productReviewReports, productReviews } from '@/db/schema'
import type { AppEnv } from '@/env'
import { PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { reportSchema, reviewSchema } from '@/lib/reviews'
import { optionalAccount, requireAccount } from '@/middleware/account'
import type { Product } from '@/services/products'
import { findProductBySlug } from '@/services/products'
import { productRatingDetail } from '@/services/ratings'
import {
  bumpReportCount,
  countsTowardRating,
  findOwnReview,
  findReviewById,
  listReviews,
  resolveAnchorRelease,
  resolveEligibility,
  toOwnReview,
  toPublicReview,
  type Review,
  type ReviewSort,
} from '@/services/reviews'

/**
 * Reviews: the public tab, and the four things an account can do with its own.
 *
 * The product rules live in `src/services/reviews.ts` and `src/lib/reviews.ts`; what is worth
 * knowing here is the shape. A review is **created or replaced** rather than appended, because
 * there is exactly one per person per product — so the write is a `PUT`, and the unique index is
 * what actually enforces it. Publication is immediate: an editor hides or deletes afterwards, and
 * both are audit events.
 */
const app = new Hono<AppEnv>()

const requirePublishedProduct = async (db: Database, slug: string): Promise<Product> => {
  const product = await findProductBySlug(db, slug)
  if (!product || product.status !== 'published') {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

/** What the page prints beside an editor's answer. Never the editor's own address. */
const replyName = (product: Product) => product.name

const reviewShape = v.looseObject({ id: v.string(), rating: v.number() })

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    summary: v.looseObject({ average: v.nullable(v.number()), count: v.number(), total: v.number() }),
    reviews: v.array(reviewShape),
    pagination: v.object({ limit: v.number(), offset: v.number(), total: v.number() }),
  }),
})

app.get(
  '/products/:slug/reviews',
  describeRoute({
    description:
      'The product\'s Reviews tab: what the people who bought or downloaded it thought, with the owner\'s answers. `summary.count` is how many reviews the current average is over and `summary.total` is how many exist — the two differ once a release has reset the rating, and each review says which side of that line it falls on. Never carries an address.',
    tags: ['Reviews'],
    responses: {
      200: { description: 'The reviews', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      404: { description: 'No published product with that slug' },
    },
  }),
  validator(
    'query',
    v.object({
      sort: v.optional(v.picklist(['recent', 'rating_desc', 'rating_asc'])),
      release_id: v.optional(v.string()),
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { sort = 'recent', release_id, limit = 20, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const [summary, rows] = await Promise.all([
      productRatingDetail(db, product.id),
      listReviews(db, {
        productId: product.id,
        releaseId: release_id,
        status: 'visible',
        sort: sort as ReviewSort,
        limit,
        offset,
      }),
    ])

    // Not cached. A review published a second ago has to appear, and sixty seconds of staleness on
    // the one surface a person watches after writing is the wrong trade.
    return c.json({
      code: 200,
      data: {
        summary,
        reviews: rows.map((review) =>
          toPublicReview(review, {
            countsTowardRating: countsTowardRating(review, summary.reset_at),
            replyName: replyName(product),
          }),
        ),
        pagination: { limit, offset, total: summary.total },
      },
    })
  },
)

const eligibilityShape = v.looseObject({ can_review: v.boolean(), reason: v.nullable(v.string()) })

app.get(
  '/products/:slug/reviews/me',
  optionalAccount,
  describeRoute({
    description:
      'The caller\'s own review, whatever state it is in — a hidden one is still theirs to see — plus whether they may write one and what it would be anchored to. `reason` comes from a closed set so a front-end can word its empty state without parsing a sentence.',
    tags: ['Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The caller\'s review and their eligibility',
        content: {
          'application/json': {
            schema: resolver(
              v.object({
                code: v.literal(200),
                data: v.object({ review: v.nullable(reviewShape), eligibility: eligibilityShape }),
              }),
            ),
          },
        },
      },
      404: { description: 'No published product with that slug' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const account = c.get('account')
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const eligibility = await resolveEligibility(db, product, account)
    const review = account ? await findOwnReview(db, product.id, account.id) : null
    const summary = review ? await productRatingDetail(db, product.id) : null

    return c.json({
      code: 200,
      data: {
        review: review
          ? toOwnReview(review, {
              countsTowardRating: countsTowardRating(review, summary?.reset_at ?? null),
              replyName: replyName(product),
            })
          : null,
        // Somebody who already wrote one is still eligible — that is what makes the PUT a replace.
        eligibility,
      },
    })
  },
)

app.put(
  '/products/:slug/reviews',
  requireAccount,
  describeRoute({
    description:
      'Writes the caller\'s review of this product, creating it or replacing the one they already wrote. A `PUT` rather than a `POST` because there is exactly one per person per product: editing is replacing, and the unique index is what enforces it. Publication is immediate. The review is re-anchored to the newest release the caller could have downloaded, which is what a later `resets_rating` release is measured against.',
    tags: ['Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The review', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: reviewShape })) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'This account has not bought or downloaded the product' },
      404: { description: 'No published product with that slug' },
      409: { description: 'The product has nothing published to anchor a review to' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', reviewSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const account = c.get('account')
    if (!account) {
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }
    const now = new Date()
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const eligibility = await resolveEligibility(db, product, account)
    if (!eligibility.can_review) {
      if (eligibility.reason === 'no_release') {
        throw new HTTPException(409, { message: 'This product has no published release to review yet' })
      }
      throw new HTTPException(403, {
        message: 'Only somebody who has bought or downloaded this product can review it',
      })
    }

    // Re-anchored on every write, including an edit. Somebody who rewrites their review after two
    // more versions is talking about the version they have now, and the rating window has to agree.
    const anchor = eligibility.anchor
    if (!anchor) {
      throw new HTTPException(409, { message: 'This product has no published release to review yet' })
    }

    const existing = await findOwnReview(db, product.id, account.id)
    const fields = {
      releaseId: anchor.id,
      releaseVersion: anchor.version,
      releaseChannel: anchor.channel,
      // The snapshot the whole rating window turns on. A published release always has a
      // `published_at`; the fallback is defensive rather than reachable.
      anchoredAt: anchor.published_at ? new Date(anchor.published_at) : now,
      rating: body.rating,
      title: body.title ?? null,
      body: body.body ?? null,
      updatedAt: now,
    }

    if (existing) {
      await db.update(productReviews).set(fields).where(eq(productReviews.id, existing.id))
      const updated = { ...existing, ...fields } as Review
      const summary = await productRatingDetail(db, product.id)
      return c.json({
        code: 200,
        data: toOwnReview(updated, {
          countsTowardRating: countsTowardRating(updated, summary.reset_at),
          replyName: replyName(product),
        }),
      })
    }

    const row = {
      id: crypto.randomUUID(),
      productId: product.id,
      userId: account.id,
      email: account.email.toLowerCase(),
      authorName: account.name,
      status: 'visible',
      reportCount: 0,
      createdAt: now,
      ...fields,
    }

    try {
      await db.insert(productReviews).values(row)
    } catch (error) {
      // The unique index is the real rule; this is the race between two tabs of the same person.
      throw asConflict(error, 'You have already reviewed this product')
    }

    const summary = await productRatingDetail(db, product.id)
    return c.json({
      code: 200,
      data: toOwnReview(row as Review, {
        countsTowardRating: countsTowardRating(row as Review, summary.reset_at),
        replyName: replyName(product),
      }),
    })
  },
)

app.delete(
  '/products/:slug/reviews',
  requireAccount,
  describeRoute({
    description: 'Withdraws the caller\'s own review. An editor hiding one is a different thing, and lives under /admin.',
    tags: ['Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The review was withdrawn' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No published product, or the caller has no review of it' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const account = c.get('account')
    if (!account) {
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const review = await findOwnReview(db, product.id, account.id)
    if (!review) {
      throw new HTTPException(404, { message: 'Review not found' })
    }

    await db.delete(productReviews).where(eq(productReviews.id, review.id))
    return c.body(null, 204)
  },
)

app.post(
  '/products/:slug/reviews/:id/report',
  requireAccount,
  describeRoute({
    description:
      'Flags a review for an editor to look at. One report per person per review: a review is not more reportable because somebody pressed the button eight times, and the count is what the moderation queue sorts on.',
    tags: ['Reviews'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The report was filed' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No published product, or no such review on it' },
      409: { description: 'This account has already reported that review' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', reportSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const account = c.get('account')
    if (!account) {
      throw new HTTPException(401, { message: 'A Bearer access token is required' })
    }
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const review = await findReviewById(db, product.id, c.req.param('id'))
    if (!review || review.status !== 'visible') {
      throw new HTTPException(404, { message: 'Review not found' })
    }

    try {
      await db.insert(productReviewReports).values({
        id: crypto.randomUUID(),
        reviewId: review.id,
        productId: product.id,
        reporterUserId: account.id,
        reporterEmail: account.email.toLowerCase(),
        reason: body.reason,
        note: body.note ?? null,
        status: 'open',
        createdAt: new Date(),
      })
    } catch (error) {
      throw asConflict(error, 'You have already reported this review')
    }

    // Denormalised onto the review so the queue sorts without a join. Recounted rather than
    // incremented blindly, so the number cannot drift away from the table it describes.
    const [{ total } = { total: 0 }] = await db
      .select({ total: count() })
      .from(productReviewReports)
      .where(and(eq(productReviewReports.reviewId, review.id), eq(productReviewReports.status, 'open')))
    await db.update(productReviews).set({ reportCount: total }).where(eq(productReviews.id, review.id))

    return c.json({ code: 201, data: { reported: true } }, 201)
  },
)

export default app
export { bumpReportCount }
