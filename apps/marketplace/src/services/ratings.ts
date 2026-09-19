import { and, avg, count, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { productReleases, productReviews } from '@/db/schema'
import { emptyDistribution, RATING_VALUES } from '@/lib/reviews'

/**
 * The star rating of a product, and the App Store rule behind it.
 *
 * Publishing a release marked `resets_rating` restarts the average. It **deletes nothing**: every
 * review written before that release is still stored, still readable in the Reviews tab and still
 * counted in `total`. It simply falls outside the window the *current* average is computed over —
 * which is the honest version of "this is a different product now" and the dishonest version would
 * be removing what people wrote.
 *
 * Two decisions here are load-bearing.
 *
 * **The cutoff and the aggregate are one statement, not two.** Two round trips means two snapshots:
 * an editor publishing a resetting release between them yields an average taken over a cutoff that
 * no longer applies. It is also half the latency on the read the whole overview sidebar waits on.
 *
 * **Nothing is denormalised onto `products`.** No `rating_average` column and no trigger. A cached
 * average is a second thing that can disagree with the reviews themselves, and it would have to be
 * recomputed when a release is *published* — a reset changes every average without touching a single
 * review, which is an invalidation nobody would remember to write. Same argument as counting
 * voucher numbers out of the table rather than keeping a counter row.
 */

type Rating = {
  /** The mean, rounded to one decimal. **Null**, never zero, when nothing counts toward it. */
  average: number | null
  /** How many reviews the average is over. */
  count: number
  /** When the window opened, or null if no resetting release was ever published. */
  reset_at: string | null
}

type RatingWithDistribution = Rating & {
  /** Stars 1–5, always all five keys present so a histogram is never sparse. */
  distribution: Record<string, number>
  /** Every visible review, reset or not. What "131 reviews, 88 since 2.0" is built from. */
  total: number
}

/**
 * The moment the current rating window opened, as a correlated subquery.
 *
 * Written **once**, here, and imported by every caller. Two places computing the cutoff is two
 * places to get the reset wrong, and the second one is always the batch path nobody re-reads.
 *
 * `COALESCE(…, 0)` is what makes "no resetting release was ever published" mean "everything counts":
 * every `anchored_at` is a unix timestamp above zero. The column references are Drizzle's rather
 * than string literals, so a rename in `schema.ts` is at least a compile error at the call site
 * even though the SQL itself is not typechecked.
 */
const ratingCutoff = (productId: string) => sql`COALESCE((
  SELECT MAX(${productReleases.publishedAt}) FROM ${productReleases}
   WHERE ${productReleases.productId} = ${productId}
     AND ${productReleases.status} = 'published'
     AND ${productReleases.resetsRating} = 1
     AND ${productReleases.publishedAt} IS NOT NULL), 0)`

/** The same expression, correlated to the outer row, for the batch path's `GROUP BY`. */
const ratingCutoffCorrelated = sql`COALESCE((
  SELECT MAX(${productReleases.publishedAt}) FROM ${productReleases}
   WHERE ${productReleases.productId} = ${productReviews.productId}
     AND ${productReleases.status} = 'published'
     AND ${productReleases.resetsRating} = 1
     AND ${productReleases.publishedAt} IS NOT NULL), 0)`

/** One decimal, because two would imply a precision four reviews do not have. */
const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10

/**
 * `AVG()` over an empty set answers NULL, and that has to survive all the way out.
 *
 * A product with no reviews serializing `average: 0` would render as a one-star product on every
 * listing card in the marketplace — the single worst rounding error available here.
 */
const toAverage = (raw: string | number | null): number | null => {
  if (raw === null) {
    return null
  }
  const value = typeof raw === 'number' ? raw : Number.parseFloat(raw)
  return Number.isFinite(value) ? round(value) : null
}

const toIsoOrNull = (raw: unknown): string | null => {
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null
}

/** The current rating of one product: one statement, cutoff included. */
const productRating = async (db: Database, productId: string): Promise<Rating> => {
  const [row] = await db
    .select({
      count: count(),
      average: avg(productReviews.rating),
      resetAt: ratingCutoff(productId),
    })
    .from(productReviews)
    .where(
      and(
        eq(productReviews.productId, productId),
        eq(productReviews.status, 'visible'),
        sql`${productReviews.anchoredAt} >= ${ratingCutoff(productId)}`,
      ),
    )

  return {
    average: toAverage(row?.average ?? null),
    count: row?.count ?? 0,
    reset_at: toIsoOrNull(row?.resetAt),
  }
}

/**
 * The rating of one product with the star histogram and the all-time count beside it.
 *
 * Three statements rather than one, and only the reviews list asks for it. The sidebar deliberately
 * asks for `productRating` instead: it is a cached-for-sixty-seconds read that a visitor waits on,
 * and every extra aggregate on it is another statement for a histogram the panel does not draw.
 */
const productRatingDetail = async (db: Database, productId: string): Promise<RatingWithDistribution> => {
  const visible = and(eq(productReviews.productId, productId), eq(productReviews.status, 'visible'))

  const [rating, buckets, [totals]] = await Promise.all([
    productRating(db, productId),
    db
      .select({ rating: productReviews.rating, count: count() })
      .from(productReviews)
      .where(and(visible, sql`${productReviews.anchoredAt} >= ${ratingCutoff(productId)}`))
      .groupBy(productReviews.rating),
    db.select({ count: count() }).from(productReviews).where(visible),
  ])

  const distribution = emptyDistribution()
  for (const bucket of buckets) {
    if ((RATING_VALUES as readonly number[]).includes(bucket.rating)) {
      distribution[String(bucket.rating)] = bucket.count
    }
  }

  return { ...rating, distribution, total: totals?.count ?? 0 }
}

/**
 * The rating of several products in one statement, for a listing.
 *
 * The same cutoff expression, correlated to the outer row rather than to a bound id. Without this
 * the product list would run one pair of statements per card.
 */
const ratingsForProducts = async (db: Database, productIds: string[]): Promise<Map<string, Rating>> => {
  const ratings = new Map<string, Rating>()
  if (productIds.length === 0) {
    return ratings
  }

  const rows = await db
    .select({
      productId: productReviews.productId,
      count: count(),
      average: avg(productReviews.rating),
      resetAt: sql<number>`MAX(${ratingCutoffCorrelated})`,
    })
    .from(productReviews)
    .where(
      and(
        inArray(productReviews.productId, productIds),
        eq(productReviews.status, 'visible'),
        sql`${productReviews.anchoredAt} >= ${ratingCutoffCorrelated}`,
      ),
    )
    .groupBy(productReviews.productId)

  for (const row of rows) {
    ratings.set(row.productId, {
      average: toAverage(row.average),
      count: row.count,
      reset_at: toIsoOrNull(row.resetAt),
    })
  }

  // A product with no counted reviews produces no group, and the caller still needs a shape.
  for (const id of productIds) {
    if (!ratings.has(id)) {
      ratings.set(id, { average: null, count: 0, reset_at: null })
    }
  }
  return ratings
}

/**
 * The rating of one release: the reviews written against *it*.
 *
 * No cutoff, and that is deliberate. A reset says "the product changed"; it says nothing about how
 * good version 1.4.0 was, and a version whose own rating moved because a later release reset the
 * product's would be reporting something that never happened.
 */
const releaseRating = async (db: Database, releaseId: string): Promise<Omit<Rating, 'reset_at'>> => {
  const [row] = await db
    .select({ count: count(), average: avg(productReviews.rating) })
    .from(productReviews)
    .where(and(eq(productReviews.releaseId, releaseId), eq(productReviews.status, 'visible')))

  return { average: toAverage(row?.average ?? null), count: row?.count ?? 0 }
}

export { productRating, productRatingDetail, ratingCutoff, ratingsForProducts, releaseRating }
export type { Rating, RatingWithDistribution }
