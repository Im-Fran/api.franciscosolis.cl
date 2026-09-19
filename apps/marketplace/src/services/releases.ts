import { and, asc, desc, eq, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { productReleases } from '@/db/schema'
import type { ContentStatus } from '@/lib/config'
import { parseLinks } from '@/lib/links'
import {
  availableLocales,
  DEFAULT_LOCALE,
  localize,
  parseTranslations,
  resolveLocale,
  RELEASE_TRANSLATABLE_FIELDS,
  type Locale,
} from '@/lib/locales'

type ProductRelease = typeof productReleases.$inferSelect

/** One release note as the Releases tab renders it, in one locale. */
const toPublicRelease = (release: ProductRelease, requested: Locale = DEFAULT_LOCALE) => {
  const translations = parseTranslations(release.translations)
  const locale = resolveLocale(translations, requested)

  return {
    id: release.id,
    product_id: release.productId,
    version: release.version,
    ...localize({ title: release.title, body: release.body }, translations, locale, RELEASE_TRANSLATABLE_FIELDS),
    locale,
    available_locales: availableLocales(translations),
    released_at: release.releasedAt?.toISOString() ?? null,
    links: parseLinks(release.links),
    published_at: release.publishedAt?.toISOString() ?? null,
    updated_at: release.updatedAt.toISOString(),
  }
}

const toAdminRelease = (release: ProductRelease) => ({
  ...toPublicRelease(release, DEFAULT_LOCALE),
  translations: parseTranslations(release.translations),
  status: release.status,
  created_by: release.createdBy,
  updated_by: release.updatedBy,
  created_at: release.createdAt.toISOString(),
})

type ReleaseFilters = {
  productId: string
  status?: ContentStatus
  limit: number
  offset: number
}

/**
 * Newest release first, which is what a changelog is.
 *
 * `releasedAt` and not `createdAt`: an editor writing up three versions in one sitting would
 * otherwise get them in the order they typed them, and back-dating an entry somebody forgot would
 * silently put it at the top. `createdAt` is the tie-break for two releases on the same day.
 */
const listOrder = [desc(productReleases.releasedAt), desc(productReleases.createdAt), asc(productReleases.version)]

const buildFilters = (filters: ReleaseFilters): SQL | undefined => {
  const clauses: SQL[] = [eq(productReleases.productId, filters.productId)]
  if (filters.status) {
    clauses.push(eq(productReleases.status, filters.status))
  }
  return and(...clauses)
}

const listReleases = async (db: Database, filters: ReleaseFilters): Promise<ProductRelease[]> =>
  db
    .select()
    .from(productReleases)
    .where(buildFilters(filters))
    .orderBy(...listOrder)
    .limit(filters.limit)
    .offset(filters.offset)

const findReleaseById = async (db: Database, id: string): Promise<ProductRelease | null> => {
  const [release] = await db.select().from(productReleases).where(eq(productReleases.id, id)).limit(1)
  return release ?? null
}

/** A release note addressed the way the website addresses it: by version, inside one product. */
const findReleaseByVersion = async (
  db: Database,
  productId: string,
  version: string,
): Promise<ProductRelease | null> => {
  const [release] = await db
    .select()
    .from(productReleases)
    .where(and(eq(productReleases.productId, productId), eq(productReleases.version, version)))
    .limit(1)
  return release ?? null
}

export { findReleaseById, findReleaseByVersion, listReleases, toAdminRelease, toPublicRelease }
export type { ProductRelease, ReleaseFilters }
