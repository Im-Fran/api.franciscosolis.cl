import { and, count, eq, max, min, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { productReleases, purchases } from '@/db/schema'
import { describeCategory } from '@/lib/categories'
import { parseChannel, RELEASE_CHANNELS, type ReleaseChannel } from '@/lib/channels'
import { ENTITLING_STATUS } from '@/lib/config'
import { DEFAULT_LOCALE, type Locale } from '@/lib/locales'
import { describePricing } from '@/lib/pricing'
import { compatibilityFor } from '@/services/compatibility'
import type { Product } from '@/services/products'
import { productRating, releaseRating } from '@/services/ratings'
import { findLatestStableRelease, toPublicRelease } from '@/services/releases'

/**
 * The panel down the right-hand side of a product's Overview tab, in one request.
 *
 * It is **not a tab**, and that distinction matters: the tab registry describes what a visitor
 * clicks, and this is chrome beside the banner in the same way the links row is. The day it becomes
 * a tab key the tab list stops describing the page.
 *
 * Everything it needs is gathered here rather than by six calls from the front-end, because it is
 * the first thing a visitor sees and it is cacheable for everybody. The reads that do not depend on
 * each other run together.
 */

type Overview = Awaited<ReturnType<typeof buildOverview>>

/** Approved purchases of a product, optionally only those taken since a moment. */
const countPurchases = async (db: Database, productId: string, since?: Date | null): Promise<number> => {
  const clauses = [eq(purchases.productId, productId), eq(purchases.status, ENTITLING_STATUS)]
  if (since) {
    clauses.push(sql`${purchases.approvedAt} >= ${Math.floor(since.getTime() / 1000)}`)
  }
  const [row] = await db.select({ total: count() }).from(purchases).where(and(...clauses))
  return row?.total ?? 0
}

/**
 * First and last release date, derived rather than stored.
 *
 * Two columns on the product would drift the moment somebody back-dates a release they forgot, and
 * `released_at` is exactly the field editors do back-date — which is why the Releases tab is
 * ordered by it. `MIN`/`MAX` over the published rows cannot drift.
 */
const releaseDates = async (db: Database, productId: string) => {
  const [row] = await db
    .select({ first: min(productReleases.releasedAt), last: max(productReleases.releasedAt) })
    .from(productReleases)
    .where(and(eq(productReleases.productId, productId), eq(productReleases.status, 'published')))
  return row ?? { first: null, last: null }
}

/** How many published releases sit on each line, so a front-end can label its channel picker. */
const channelCounts = async (db: Database, productId: string): Promise<Record<ReleaseChannel, number>> => {
  const rows = await db
    .select({ channel: productReleases.channel, total: count() })
    .from(productReleases)
    .where(and(eq(productReleases.productId, productId), eq(productReleases.status, 'published')))
    .groupBy(productReleases.channel)

  // Every channel present at zero rather than absent, so a picker renders a stable set of options —
  // the same rule `summarizeSales` states for its buckets.
  const counts = Object.fromEntries(RELEASE_CHANNELS.map((channel) => [channel, 0])) as Record<
    ReleaseChannel,
    number
  >
  for (const row of rows) {
    counts[parseChannel(row.channel)] = row.total
  }
  return counts
}

const toIso = (value: Date | number | null): string | null => {
  if (value === null) {
    return null
  }
  // `min`/`max` come back as the raw unix seconds rather than through Drizzle's timestamp mode.
  return value instanceof Date ? value.toISOString() : new Date(value * 1000).toISOString()
}

const buildOverview = async (db: Database, product: Product, locale: Locale = DEFAULT_LOCALE) => {
  const [dates, channels, rating, purchaseCount, latest] = await Promise.all([
    releaseDates(db, product.id),
    channelCounts(db, product.id),
    productRating(db, product.id),
    countPurchases(db, product.id),
    findLatestStableRelease(db, product.id),
  ])

  const pricing = describePricing(product)

  const latestBlock = latest
    ? await (async () => {
        const [entries, ratingOfRelease, boughtSince] = await Promise.all([
          compatibilityFor(db, [latest.id]),
          releaseRating(db, latest.id),
          // "Bought while this version was current" — an approximation, and labelled as one in the
          // README. A purchase entitles the whole product and never names a release, so there is no
          // exact answer to give.
          countPurchases(db, product.id, latest.publishedAt),
        ])
        const { stats, ...release } = toPublicRelease(latest, locale)
        return {
          ...release,
          download_count: stats.download_count,
          view_count: stats.view_count,
          purchase_count: pricing.accepts_payment ? boughtSince : null,
          rating: ratingOfRelease,
          compatibility: entries.get(latest.id) ?? [],
        }
      })()
    : null

  return {
    product: {
      id: product.id,
      slug: product.slug,
      name: product.name,
      tagline: product.tagline,
      icon_image_url: product.iconImageUrl,
      accent_color: product.accentColor,
      category: describeCategory(product.category),
    },
    pricing,
    stats: {
      // The headline number, the way a plugin listing shows "Total Downloads".
      download_count: product.downloadCount,
      // Beside it rather than instead of it, and null when the product never took a payment —
      // "0 purchases" on a free product is a number nobody asked about.
      purchase_count: pricing.accepts_payment ? purchaseCount : null,
      view_count: product.viewCount,
      first_released_at: toIso(dates.first),
      last_released_at: toIso(dates.last),
    },
    rating,
    latest_version: latestBlock,
    channels,
  }
}

export { buildOverview, channelCounts, countPurchases, releaseDates }
export type { Overview }
