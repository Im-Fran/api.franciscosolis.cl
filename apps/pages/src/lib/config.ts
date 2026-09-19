import { DEFAULT_TIMEOUT_MS, MAX_SOURCE_CHARS } from '@franciscosolis/translate'

/** Publication states shared by applications, updates and wiki pages. */
const CONTENT_STATUS = ['draft', 'published', 'archived'] as const
type ContentStatus = (typeof CONTENT_STATUS)[number]

/** How long a fetched JWKS is reused before the auth Worker is asked again, in seconds. */
const JWKS_CACHE_TTL = 3600

/** Listing bounds shared by every paginated route. */
const PAGINATION = {
  defaultLimit: 50,
  maxLimit: 200,
} as const

/** Ceilings on the Markdown documents an editor may store, in characters. */
const BODY_LIMITS = {
  /** The Overview and Contact tabs, and a wiki page. */
  page: 200_000,
  /** One release note. Deliberately smaller: a changelog entry that long is a wiki page. */
  update: 50_000,
} as const

/**
 * The API's own cap on each translatable prose field, in characters.
 *
 * One map rather than a number written at each use, because it is read in two places that must
 * agree: the valibot fragments in `lib/validation.ts` that refuse an over-long override on save,
 * and the translation route that refuses a model answer over the cap. A draft the API would reject
 * is not a draft, it is a dead end the editor discovers at the save button.
 *
 * `body` takes the *smaller* of the two caps it has — a release note's 50 000 rather than a wiki
 * page's 200 000 — because the field name is all the translation route is told, and the conservative
 * number is always a valid answer for either. It never bites: a translation is bounded far below
 * both by `TRANSLATION.maxSourceChars`.
 */
const TRANSLATABLE_FIELD_LIMITS = {
  name: 120,
  tagline: 200,
  summary: 600,
  title: 200,
  overview_body: BODY_LIMITS.page,
  contact_body: BODY_LIMITS.page,
  body: BODY_LIMITS.update,
} as const

/**
 * Bounds on `POST /admin/translate`.
 *
 * Workers AI is billed per neuron with no per-Worker spend cap, so the hourly limit is not about
 * CPU: it is the cheap ceiling on what a loop in the CMS front-end — which is where these pages are
 * edited — can cost. It is set well above what translating a whole application page by hand takes,
 * so an editor working normally will never meet it.
 */
const TRANSLATION = {
  /** Draft translations one editor may ask for per hour, successful or not. */
  hourlyLimitPerEditor: 120,
  /** Milliseconds before the model call is abandoned. Bounds the response, not the spend. */
  timeoutMs: DEFAULT_TIMEOUT_MS,
  /** Longest source text a single call carries. A body over this is translated in pieces. */
  maxSourceChars: MAX_SOURCE_CHARS,
} as const

/** `public, max-age=` value on published content, the only responses a shared cache may keep. */
const PUBLIC_CACHE_SECONDS = 60

/**
 * States a payment row moves through. A superset of what the provider reports, mapped in
 * `src/lib/mercadopago.ts` — `in_process` covers everything that is neither settled nor refused, so
 * a front-end has one "we are waiting" state rather than a provider's vocabulary.
 *
 * Only `approved` grants access. `refunded` is deliberately in the same column rather than a boolean
 * beside it: a refund is the payment's current state, and a row that says both "paid" and "refunded"
 * is a row two code paths will disagree about.
 *
 * `charged_back` is kept apart from `refunded` even though both end the entitlement. A refund is us
 * giving money back; a chargeback is the payer's bank taking it, with a dispute, a deadline and a fee
 * attached. Collapsing them would make "how often does this get disputed" unanswerable from the data,
 * and that is the number that decides whether an application should be sold at all.
 */
const PURCHASE_STATUSES = [
  'pending',
  'in_process',
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
] as const
type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]

/** The one status that entitles an account to a download. Stated once so nothing widens it locally. */
const ENTITLING_STATUS: PurchaseStatus = 'approved'

export {
  BODY_LIMITS,
  CONTENT_STATUS,
  ENTITLING_STATUS,
  JWKS_CACHE_TTL,
  PAGINATION,
  PUBLIC_CACHE_SECONDS,
  PURCHASE_STATUSES,
  TRANSLATABLE_FIELD_LIMITS,
  TRANSLATION,
}
export type { ContentStatus, PurchaseStatus }
