import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { productReleases } from '@/db/schema'
import { parseChannel, type ReleaseChannel, STABLE_CHANNEL } from '@/lib/channels'
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
    channel: parseChannel(release.channel),
    resets_rating: release.resetsRating,
    ...localize({ title: release.title, body: release.body }, translations, locale, RELEASE_TRANSLATABLE_FIELDS),
    locale,
    available_locales: availableLocales(translations),
    released_at: release.releasedAt?.toISOString() ?? null,
    links: parseLinks(release.links),
    stats: { view_count: release.viewCount, download_count: release.downloadCount },
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
  /**
   * Channels to include. `null` means every channel — the `?channel=all` case — and an absent
   * filter is decided by the caller rather than here, because the public feed's default (`release`
   * only) and the editorial listing's default (everything) are not the same default.
   */
  channels?: ReleaseChannel[] | null
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
  if (filters.channels && filters.channels.length > 0) {
    clauses.push(inArray(productReleases.channel, filters.channels))
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

/**
 * A release addressed the way the website addresses it: by channel *and* version, inside one
 * product.
 *
 * The channel is part of the address because it is part of the key. `1.4.0` can exist as an `rc`
 * and, a week later, as a `release`; a lookup by version alone would answer with whichever row
 * SQLite happened to reach first, and the one it reached could be the gated one.
 */
const findReleaseByVersion = async (
  db: Database,
  productId: string,
  channel: ReleaseChannel,
  version: string,
): Promise<ProductRelease | null> => {
  const [release] = await db
    .select()
    .from(productReleases)
    .where(
      and(
        eq(productReleases.productId, productId),
        eq(productReleases.channel, channel),
        eq(productReleases.version, version),
      ),
    )
    .limit(1)
  return release ?? null
}

/**
 * The newest published release on the stable line, which is what "latest version" means everywhere
 * a product summarises itself — the overview sidebar above all.
 *
 * Never a nightly, whatever its date. A product whose sidebar advertised last night's build as its
 * current version would be telling every visitor to install something nobody has finished.
 */
const findLatestStableRelease = async (db: Database, productId: string): Promise<ProductRelease | null> => {
  const [release] = await db
    .select()
    .from(productReleases)
    .where(
      and(
        eq(productReleases.productId, productId),
        eq(productReleases.channel, STABLE_CHANNEL),
        eq(productReleases.status, 'published'),
      ),
    )
    .orderBy(...listOrder)
    .limit(1)
  return release ?? null
}

export {
  findLatestStableRelease,
  findReleaseById,
  findReleaseByVersion,
  listReleases,
  toAdminRelease,
  toPublicRelease,
}
export type { ProductRelease, ReleaseFilters }
