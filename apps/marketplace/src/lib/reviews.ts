import * as v from 'valibot'

/**
 * The vocabulary a review is written in: the star bounds, the two statuses, and why somebody
 * flagged one.
 *
 * The product rules the schema enforces, restated here because this is where they are read from:
 * one review per person per product (a unique index, not a service check), written only by somebody
 * who actually obtained the product, published the moment it is written, and answerable once by the
 * editor.
 */

/** Stars. Bounded here rather than by a SQLite CHECK, which cannot be altered without a rebuild. */
const RATING_BOUNDS = { min: 1, max: 5 } as const

/** Every star value, ascending — what a distribution is keyed by, so the histogram is never sparse. */
const RATING_VALUES = [1, 2, 3, 4, 5] as const

/**
 * `visible` | `hidden`.
 *
 * Two states and no third, for the reason a voucher has two: hiding is reversible and deleting is
 * not, so a moderator has one action that can be undone and one that is spelled `DELETE`. A hidden
 * review is invisible publicly and counts toward no average, but it is still there to be looked at.
 */
const REVIEW_STATUSES = ['visible', 'hidden'] as const

type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** Why a reader flagged a review. Closed, so the moderation queue can be grouped and counted. */
const REPORT_REASONS = ['spam', 'abuse', 'off_topic', 'not_a_review', 'personal_data', 'other'] as const

type ReportReason = (typeof REPORT_REASONS)[number]

/** `open` | `dismissed` | `actioned`. `actioned` means the review was hidden or deleted because of it. */
const REPORT_STATUSES = ['open', 'dismissed', 'actioned'] as const

type ReportStatus = (typeof REPORT_STATUSES)[number]

/** Resolutions a moderator may set. `open` is where a report starts, never where it is put back. */
const REPORT_RESOLUTIONS = ['dismissed', 'actioned'] as const

const REVIEW_LIMITS = {
  title: 120,
  body: 4_000,
  /** The editor's answer. Shorter than a review on purpose: a reply is a reply, not a rebuttal. */
  reply: 2_000,
  reportNote: 500,
  resolutionNote: 500,
} as const

/**
 * Why somebody may not write a review right now, as a closed set, so a front-end can word its empty
 * state without inventing copy and without parsing a sentence.
 */
const INELIGIBILITY_REASONS = [
  /** No approved purchase and no download on record for this account. */
  'not_obtained',
  /** Signed out. The front-end's move here is a sign-in button, not an explanation. */
  'not_authenticated',
  /** Nothing published to anchor a review to. */
  'no_release',
] as const

type IneligibilityReason = (typeof INELIGIBILITY_REASONS)[number]

/** How the caller came to be eligible. Reported so a UI can say "verified purchase". */
const ELIGIBILITY_SOURCES = ['purchase', 'download'] as const

type EligibilitySource = (typeof ELIGIBILITY_SOURCES)[number]

const isReviewStatus = (value: string): value is ReviewStatus =>
  (REVIEW_STATUSES as readonly string[]).includes(value)

/** Lenient on read, like every stored vocabulary here. An unreadable status reads as `visible`… */
const parseReviewStatus = (raw: string | null): ReviewStatus => (raw && isReviewStatus(raw) ? raw : 'visible')

const ratingInput = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(RATING_BOUNDS.min),
  v.maxValue(RATING_BOUNDS.max),
)

const reviewSchema = v.strictObject({
  rating: ratingInput,
  title: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(REVIEW_LIMITS.title)))),
  body: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(REVIEW_LIMITS.body)))),
})

const replySchema = v.strictObject({
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(REVIEW_LIMITS.reply)),
})

const reportSchema = v.strictObject({
  reason: v.picklist(REPORT_REASONS),
  note: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(REVIEW_LIMITS.reportNote)))),
})

const reportResolutionSchema = v.strictObject({
  status: v.picklist(REPORT_RESOLUTIONS),
  resolution_note: v.optional(
    v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(REVIEW_LIMITS.resolutionNote))),
  ),
})

/** An empty distribution, so a product with no reviews still answers a full histogram of zeros. */
const emptyDistribution = (): Record<string, number> =>
  Object.fromEntries(RATING_VALUES.map((value) => [String(value), 0]))

export {
  ELIGIBILITY_SOURCES,
  emptyDistribution,
  INELIGIBILITY_REASONS,
  isReviewStatus,
  parseReviewStatus,
  ratingInput,
  RATING_BOUNDS,
  RATING_VALUES,
  replySchema,
  REPORT_REASONS,
  REPORT_RESOLUTIONS,
  REPORT_STATUSES,
  reportResolutionSchema,
  reportSchema,
  REVIEW_LIMITS,
  REVIEW_STATUSES,
  reviewSchema,
}
export type { EligibilitySource, IneligibilityReason, ReportReason, ReportStatus, ReviewStatus }
