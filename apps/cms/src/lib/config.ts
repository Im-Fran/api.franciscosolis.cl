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

export { CONTENT_STATUS, EMAIL_LIMITS, JWKS_CACHE_TTL, PAGINATION, PUBLIC_CACHE_SECONDS }
export type { ContentStatus }
