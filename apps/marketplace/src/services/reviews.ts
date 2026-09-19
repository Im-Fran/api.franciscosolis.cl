import { and, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { downloadEvents, productReviews } from '@/db/schema'
import type { ReleaseChannel } from '@/lib/channels'
import { parseChannel } from '@/lib/channels'
import { parseReviewStatus, type EligibilitySource, type IneligibilityReason } from '@/lib/reviews'
import type { Account } from '@/middleware/account'
import type { Product } from '@/services/products'
import { findActivePurchase } from '@/services/purchases'
import { findLatestStableRelease, listReleases, type ProductRelease } from '@/services/releases'

type Review = typeof productReviews.$inferSelect

/**
 * Who may write a review, what it is anchored to, and how one is serialized.
 *
 * **One review per person per product**, enforced by the unique index in `schema.ts` rather than by
 * a check here. Editing replaces it; there is no thread and no second opinion. That is what keeps
 * the average an average of people rather than of clicks.
 *
 * **Only somebody who actually obtained the product may write one.** Either an approved purchase
 * exists — matched by account id *or* verified address, which is what `findActivePurchase` already
 * does and what makes a manual cash sale count — or a download is on record for this account. Those
 * are the two ways the product can have reached a person, and nothing else is.
 */

/** Why this caller cannot write a review right now, or null if they can. */
type Eligibility = {
  can_review: boolean
  reason: IneligibilityReason | null
  /** How they came to be eligible, so a UI can say "verified purchase". */
  via: EligibilitySource | null
  /** The release a review written now would be anchored to. */
  anchor: { id: string; version: string; channel: ReleaseChannel; published_at: string | null } | null
}

/**
 * The release a reviewer "had": the newest published one on the **stable line**.
 *
 * The stable line and not "the newest thing they could have downloaded", which was the first shape
 * this took and is worse. A product that publishes a build every night would have anchored every
 * review to last night's, so the rating window would move daily and a `resets_rating` release would
 * be measured against something nobody installed. The sidebar names the latest stable version for
 * the same reason, and a review and the version beside it should agree.
 *
 * The fallback is for a product that has only ever published pre-releases: something shipping
 * nothing but betas is still reviewable by the people running those betas, and refusing there would
 * be a rule about the channel rather than about the review. A product with nothing published at all
 * has no anchor and cannot be reviewed — an unanchored review has nothing for a reset to be
 * measured against.
 */
const resolveAnchorRelease = async (db: Database, product: Product): Promise<ProductRelease | null> => {
  const stable = await findLatestStableRelease(db, product.id)
  if (stable) {
    return stable
  }

  const [newest] = await listReleases(db, {
    productId: product.id,
    status: 'published',
    channels: null,
    limit: 1,
    offset: 0,
  })
  return newest ?? null
}

const describeAnchor = (release: ProductRelease | null): Eligibility['anchor'] =>
  release
    ? {
        id: release.id,
        version: release.version,
        channel: parseChannel(release.channel),
        published_at: release.publishedAt?.toISOString() ?? null,
      }
    : null

/**
 * Whether `account` may write a review of `product`, and what it would be anchored to.
 *
 * Two things worth stating rather than leaving to be inferred. `download_events.user_id` is null
 * for an anonymous download — that is what makes a free build free — so only a download taken while
 * signed in confers eligibility; matching by address instead is not identity. And for a `free`
 * product that leaves the bar at "signed in and clicked download once", which is accepted: the
 * structural mitigation is one review per person, and the operational one is reports and hiding.
 */
const resolveEligibility = async (
  db: Database,
  product: Product,
  account: Account | undefined,
): Promise<Eligibility> => {
  if (!account) {
    return { can_review: false, reason: 'not_authenticated', via: null, anchor: null }
  }

  const purchase = await findActivePurchase(db, product.id, account)
  let via: EligibilitySource | null = purchase ? 'purchase' : null

  if (!via) {
    const [download] = await db
      .select({ id: downloadEvents.id })
      .from(downloadEvents)
      .where(and(eq(downloadEvents.productId, product.id), eq(downloadEvents.userId, account.id)))
      .limit(1)
    via = download ? 'download' : null
  }

  if (!via) {
    return { can_review: false, reason: 'not_obtained', via: null, anchor: null }
  }

  const anchor = await resolveAnchorRelease(db, product)

  if (!anchor) {
    return { can_review: false, reason: 'no_release', via, anchor: null }
  }

  return { can_review: true, reason: null, via, anchor: describeAnchor(anchor) }
}

/** The caller's own review, whatever state it is in — a hidden one is still theirs to see. */
const findOwnReview = async (db: Database, productId: string, userId: string): Promise<Review | null> => {
  const [review] = await db
    .select()
    .from(productReviews)
    .where(and(eq(productReviews.productId, productId), eq(productReviews.userId, userId)))
    .limit(1)
  return review ?? null
}

const findReviewById = async (db: Database, productId: string, id: string): Promise<Review | null> => {
  const [review] = await db
    .select()
    .from(productReviews)
    .where(and(eq(productReviews.id, id), eq(productReviews.productId, productId)))
    .limit(1)
  return review ?? null
}

type ReviewSort = 'recent' | 'rating_desc' | 'rating_asc'

const sortOrder = {
  recent: [desc(productReviews.createdAt)],
  rating_desc: [desc(productReviews.rating), desc(productReviews.createdAt)],
  rating_asc: [sql`${productReviews.rating} ASC`, desc(productReviews.createdAt)],
} satisfies Record<ReviewSort, unknown[]>

type ReviewFilters = {
  productId: string
  releaseId?: string
  /** Absent means visible only, which is what every public read wants. */
  status?: 'visible' | 'hidden'
  sort: ReviewSort
  limit: number
  offset: number
}

const listReviews = async (db: Database, filters: ReviewFilters): Promise<Review[]> => {
  const clauses = [eq(productReviews.productId, filters.productId)]
  if (filters.status) {
    clauses.push(eq(productReviews.status, filters.status))
  }
  if (filters.releaseId) {
    clauses.push(eq(productReviews.releaseId, filters.releaseId))
  }

  return db
    .select()
    .from(productReviews)
    .where(and(...clauses))
    .orderBy(...(sortOrder[filters.sort] as never[]))
    .limit(filters.limit)
    .offset(filters.offset)
}

/**
 * One review as the public Reviews tab renders it.
 *
 * The address is **never** in here. It is the eligibility key — `findActivePurchase` matches a
 * manual sale by address — and a review is a public document; the two must not be the same field in
 * the same response. `reply_by` is left out for the same kind of reason: the editor who answered is
 * a back-office identity, and the page renders the product's name.
 */
const toPublicReview = (review: Review, options: { countsTowardRating: boolean; replyName: string }) => ({
  id: review.id,
  rating: review.rating,
  title: review.title,
  body: review.body,
  author: { id: review.userId, name: review.authorName },
  release: review.releaseId
    ? { id: review.releaseId, version: review.releaseVersion, channel: review.releaseChannel }
    : null,
  /**
   * Whether this review is inside the current rating window.
   *
   * Serialized rather than left to be inferred: "older reviews still exist and are still readable,
   * they just do not count" is a rule a reader should be able to see, and a front-end cannot derive
   * it without the cutoff.
   */
  counts_toward_rating: options.countsTowardRating,
  /** True once the review has been rewritten. `updated_at` alone cannot say it. */
  edited: review.updatedAt.getTime() > review.createdAt.getTime() + 1000,
  reply: review.replyBody
    ? {
        body: review.replyBody,
        author_name: options.replyName,
        created_at: review.replyAt?.toISOString() ?? null,
        updated_at: review.replyUpdatedAt?.toISOString() ?? null,
      }
    : null,
  created_at: review.createdAt.toISOString(),
  updated_at: review.updatedAt.toISOString(),
})

/** The caller's own review, which may carry a moderation note the public shape hides. */
const toOwnReview = (review: Review, options: { countsTowardRating: boolean; replyName: string }) => ({
  ...toPublicReview(review, options),
  status: parseReviewStatus(review.status),
  hidden_reason: review.hiddenReason,
})

/** Same review, plus everything a moderator needs — the address included, because they may need it. */
const toAdminReview = (review: Review) => ({
  id: review.id,
  product_id: review.productId,
  rating: review.rating,
  title: review.title,
  body: review.body,
  author: { id: review.userId, name: review.authorName, email: review.email },
  release: review.releaseId
    ? { id: review.releaseId, version: review.releaseVersion, channel: review.releaseChannel }
    : null,
  anchored_at: review.anchoredAt.toISOString(),
  status: parseReviewStatus(review.status),
  hidden_at: review.hiddenAt?.toISOString() ?? null,
  hidden_by: review.hiddenBy,
  hidden_reason: review.hiddenReason,
  report_count: review.reportCount,
  reply: review.replyBody
    ? {
        body: review.replyBody,
        author_email: review.replyBy,
        created_at: review.replyAt?.toISOString() ?? null,
        updated_at: review.replyUpdatedAt?.toISOString() ?? null,
      }
    : null,
  created_at: review.createdAt.toISOString(),
  updated_at: review.updatedAt.toISOString(),
})

/**
 * Whether a review falls inside the current rating window.
 *
 * `reset_at` comes from `services/ratings.ts`, which is the one place the cutoff is computed. A
 * review whose anchor release has since been deleted has `release_id` null but keeps its
 * `anchored_at`, so it still answers this correctly — which is the whole reason that column is a
 * snapshot rather than a join.
 */
const countsTowardRating = (review: Review, resetAt: string | null): boolean => {
  if (review.status !== 'visible') {
    return false
  }
  if (!resetAt) {
    return true
  }
  return review.anchoredAt.getTime() >= Date.parse(resetAt)
}

/** Keeps `report_count` in step with the reports table without a read-then-write race. */
const bumpReportCount = async (db: Database, reviewId: string, by: number) => {
  await db
    .update(productReviews)
    .set({ reportCount: sql`MAX(0, ${productReviews.reportCount} + ${by})` })
    .where(eq(productReviews.id, reviewId))
}

export {
  bumpReportCount,
  countsTowardRating,
  describeAnchor,
  findOwnReview,
  findReviewById,
  listReviews,
  resolveAnchorRelease,
  resolveEligibility,
  toAdminReview,
  toOwnReview,
  toPublicReview,
}
export type { Eligibility, Review, ReviewFilters, ReviewSort }
