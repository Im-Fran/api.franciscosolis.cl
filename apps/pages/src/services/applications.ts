import { and, asc, desc, eq, like, or, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { applications } from '@/db/schema'
import type { ContentStatus } from '@/lib/config'
import { parseLinks } from '@/lib/links'
import {
  APPLICATION_TRANSLATABLE_FIELDS,
  availableLocales,
  DEFAULT_LOCALE,
  localize,
  parseTranslations,
  resolveLocale,
  type Locale,
} from '@/lib/locales'
import { parseTabs } from '@/lib/tabs'

type Application = typeof applications.$inferSelect

/**
 * Shape returned by the public routes and consumed by the website, rendered in one locale.
 *
 * The prose fields arrive already resolved — a caller reads `name`, never `translations.es.name` —
 * so a website asking for `es` needs no merging logic of its own and a half-translated page simply
 * shows the fields that were translated. `locale` says which language the text came out in and
 * `available_locales` which ones could have been asked for.
 */
const toPublicApplication = (application: Application, requested: Locale = DEFAULT_LOCALE) => {
  const translations = parseTranslations(application.translations)
  const locale = resolveLocale(translations, requested)

  const localized = localize(
    {
      name: application.name,
      tagline: application.tagline,
      summary: application.summary,
      overview_body: application.overviewBody,
      contact_body: application.contactBody,
    },
    translations,
    locale,
    APPLICATION_TRANSLATABLE_FIELDS,
  )

  return {
    id: application.id,
    slug: application.slug,
    ...localized,
    locale,
    available_locales: availableLocales(translations),
    featured: application.featured,
    position: application.position,
    banner_image_url: application.bannerImageUrl,
    icon_image_url: application.iconImageUrl,
    accent_color: application.accentColor,
    tabs: parseTabs(application.tabs),
    links: parseLinks(application.links),
    published_at: application.publishedAt?.toISOString() ?? null,
    updated_at: application.updatedAt.toISOString(),
  }
}

/**
 * The same application without its two tab bodies, which is what a listing wants.
 *
 * They are Markdown documents capped at 200 kB apiece, so a list of twenty applications carrying
 * both is several megabytes of text nobody on that screen is going to read. The single-application
 * read is where the bodies live.
 */
const toPublicApplicationSummary = (application: Application, requested: Locale = DEFAULT_LOCALE) => {
  const { overview_body: _overview, contact_body: _contact, ...summary } = toPublicApplication(application, requested)
  return summary
}

/**
 * Same application, plus the editorial fields only an authenticated editor may see.
 *
 * Always the default locale, with the raw `translations` map beside it: an editor edits the source
 * text and its translations together, and a localized `name` here would be an editor saving the
 * Spanish text back over the English row.
 */
const toAdminApplication = (application: Application) => ({
  ...toPublicApplication(application, DEFAULT_LOCALE),
  translations: parseTranslations(application.translations),
  status: application.status,
  created_by: application.createdBy,
  updated_by: application.updatedBy,
  created_at: application.createdAt.toISOString(),
})

type ListFilters = {
  status?: ContentStatus
  featured?: boolean
  /** Substring match against name, tagline, summary and slug. */
  search?: string
  limit: number
  offset: number
}

/**
 * Ordering every listing shares: the manual `position` first so an editor can pin things, then the
 * most recently published (SQLite sorts NULLs last under DESC, which is what an unpublished draft
 * wants), then name for a stable tie-break.
 */
const listOrder = [asc(applications.position), desc(applications.publishedAt), asc(applications.name)]

const buildFilters = (filters: ListFilters): SQL | undefined => {
  const clauses: (SQL | undefined)[] = []

  if (filters.status) {
    clauses.push(eq(applications.status, filters.status))
  }
  if (filters.featured !== undefined) {
    clauses.push(eq(applications.featured, filters.featured))
  }
  if (filters.search) {
    const pattern = `%${filters.search.toLowerCase()}%`
    clauses.push(
      or(
        like(applications.name, pattern),
        like(applications.tagline, pattern),
        like(applications.summary, pattern),
        like(applications.slug, pattern),
      ),
    )
  }

  const present = clauses.filter((clause): clause is SQL => clause !== undefined)
  return present.length > 0 ? and(...present) : undefined
}

const listApplications = async (db: Database, filters: ListFilters): Promise<Application[]> =>
  db
    .select()
    .from(applications)
    .where(buildFilters(filters))
    .orderBy(...listOrder)
    .limit(filters.limit)
    .offset(filters.offset)

const findApplicationById = async (db: Database, id: string): Promise<Application | null> => {
  const [application] = await db.select().from(applications).where(eq(applications.id, id)).limit(1)
  return application ?? null
}

const findApplicationBySlug = async (db: Database, slug: string): Promise<Application | null> => {
  const [application] = await db.select().from(applications).where(eq(applications.slug, slug)).limit(1)
  return application ?? null
}

export {
  findApplicationById,
  findApplicationBySlug,
  listApplications,
  toAdminApplication,
  toPublicApplication,
  toPublicApplicationSummary,
}
export type { Application, ListFilters }
