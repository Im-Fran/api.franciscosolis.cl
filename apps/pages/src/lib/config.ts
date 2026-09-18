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

/** `public, max-age=` value on published content, the only responses a shared cache may keep. */
const PUBLIC_CACHE_SECONDS = 60

export { BODY_LIMITS, CONTENT_STATUS, JWKS_CACHE_TTL, PAGINATION, PUBLIC_CACHE_SECONDS }
export type { ContentStatus }
