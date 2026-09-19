import { DEFAULT_TIMEOUT_MS, MAX_SOURCE_CHARS } from '@franciscosolis/translate'

/** Publication states shared by content entries and legal pages. */
const CONTENT_STATUS = ['draft', 'published', 'archived'] as const
type ContentStatus = (typeof CONTENT_STATUS)[number]

/** How long a fetched JWKS is reused before the auth Worker is asked again, in seconds. */
const JWKS_CACHE_TTL = 3600

/** Listing bounds shared by every paginated route. */
const PAGINATION = {
  defaultLimit: 50,
  maxLimit: 200,
} as const

/** Ceilings on what a single email may carry, so one call cannot blow the Worker's memory. */
const EMAIL_LIMITS = {
  maxRecipients: 20,
  maxSubjectLength: 200,
  maxBodyLength: 200_000,
} as const

/** `public, max-age=` value on published content, the only responses a shared cache may keep. */
const PUBLIC_CACHE_SECONDS = 60

/**
 * The API's own cap on each translatable prose field, in characters.
 *
 * One map rather than a number written at each use, because it is read in three places that must
 * agree: the valibot fragments in `lib/validation.ts` that refuse an over-long override on save,
 * the translation route that refuses a model answer over the cap, and the CMS front-end, which
 * reads them off `openapi.json`. A translation the API would reject is not a draft, it is a
 * dead end the editor discovers at the save button.
 *
 * A legal page's `body` is the one exception and states its own, larger cap where it is used: a
 * privacy policy is longer than any content entry, and the smaller number here is the one that
 * matters for a *translation*, which is bounded far below either by `TRANSLATION.maxSourceChars`.
 */
const TRANSLATABLE_FIELD_LIMITS = {
  title: 200,
  subtitle: 200,
  summary: 600,
  body: 100_000,
} as const

type TranslatableFieldLimit = keyof typeof TRANSLATABLE_FIELD_LIMITS

/**
 * Bounds on `POST /admin/translate`.
 *
 * Workers AI is billed per neuron with no per-Worker spend cap, so the hourly limit is not about
 * CPU: it is the cheap ceiling on what a loop in the CMS front-end can cost. It is set well above
 * what translating a whole entry by hand takes — four fields in one other language is four calls —
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

export {
  CONTENT_STATUS,
  EMAIL_LIMITS,
  JWKS_CACHE_TTL,
  PAGINATION,
  PUBLIC_CACHE_SECONDS,
  TRANSLATABLE_FIELD_LIMITS,
  TRANSLATION,
}
export type { ContentStatus, TranslatableFieldLimit }
