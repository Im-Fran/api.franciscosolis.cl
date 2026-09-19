import { and, eq, gte, lte, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { productDailyStats, productReleases, products } from '@/db/schema'
import {
  ALL_RELEASES,
  dayKey,
  dayRange,
  VIEW_DEDUP_WINDOW_SECONDS,
  viewToken,
} from '@/lib/analytics'

/**
 * How often a product was looked at and how often something was taken from it.
 *
 * Two counters on the row answer "how many in total"; `product_daily_stats` is what a chart is
 * drawn from. Each event writes both, batched into one D1 round trip.
 *
 * Every write here runs after the response — inside `waitUntil` — and swallows its own errors, for
 * the reason `recordDownload` already gives: the bytes are on their way, and losing a counter must
 * not turn a successful download into a 500. A view counter is an approximation on purpose;
 * `download_events` is the exact record, and nothing financial is ever derived from either number.
 */

type StatEvent = {
  productId: string
  /** The release it was about, or `ALL_RELEASES` for something that was about the product itself. */
  releaseId: string
  views?: number
  downloads?: number
}

/**
 * Increments the two counter columns and the two daily rows for one event.
 *
 * Two daily rows, not one: the product-wide row (`release_id = ALL_RELEASES`) is what the sidebar
 * and the product chart read, and the per-release row is what a version's own chart reads. Summing
 * the per-release rows would not give the first, because a view of the product page belongs to no
 * release at all.
 *
 * The upsert targets `(product_id, release_id, day)`. That is also why `ALL_RELEASES` is the empty
 * string rather than NULL — SQLite treats NULLs as distinct inside a unique index, so
 * `ON CONFLICT DO UPDATE` would never match and every event would insert a fresh row.
 */
const bump = async (db: Database, event: StatEvent, at: Date = new Date()) => {
  const views = event.views ?? 0
  const downloads = event.downloads ?? 0
  if (views === 0 && downloads === 0) {
    return
  }

  const day = dayKey(at)
  const rows = [ALL_RELEASES, event.releaseId].filter(
    (releaseId, index, all) => all.indexOf(releaseId) === index,
  )

  const statements = rows.map((releaseId) =>
    db
      .insert(productDailyStats)
      .values({ id: crypto.randomUUID(), productId: event.productId, releaseId, day, views, downloads })
      .onConflictDoUpdate({
        target: [productDailyStats.productId, productDailyStats.releaseId, productDailyStats.day],
        set: {
          views: sql`${productDailyStats.views} + ${views}`,
          downloads: sql`${productDailyStats.downloads} + ${downloads}`,
          updatedAt: sql`(unixepoch())`,
        },
      }),
  )

  // `sql` increments rather than read-then-write: two people at once would otherwise both write the
  // same number, which is the whole failure mode a counter has.
  statements.push(
    db
      .update(products)
      .set({
        viewCount: sql`${products.viewCount} + ${views}`,
        downloadCount: sql`${products.downloadCount} + ${downloads}`,
      })
      .where(eq(products.id, event.productId)) as never,
  )
  if (event.releaseId !== ALL_RELEASES) {
    statements.push(
      db
        .update(productReleases)
        .set({
          viewCount: sql`${productReleases.viewCount} + ${views}`,
          downloadCount: sql`${productReleases.downloadCount} + ${downloads}`,
        })
        .where(eq(productReleases.id, event.releaseId)) as never,
    )
  }

  await db.batch(statements as never)
}

/** Counts a served download. Never deduplicated: a second download is a second download. */
const recordDownloadStats = async (db: Database, event: Omit<StatEvent, 'views' | 'downloads'>) => {
  try {
    await bump(db, { ...event, downloads: 1 })
  } catch (error) {
    console.error('failed to record download stats', error)
  }
}

/**
 * Counts a page view, unless this viewer already counted inside the window.
 *
 * Deduplicated in the **Cache API**, not in D1. A dedup table means a write on every view — deduped
 * or not — plus a purge job this Worker has no cron to run; `caches.default` expires by itself. The
 * cost is that it is per-colo, so one person reaching two colos inside the window counts twice.
 * That is accepted and documented: this number is an estimate of attention, not a record of people.
 *
 * The address goes into the token and never into a row.
 */
const recordView = async (
  db: Database,
  event: Omit<StatEvent, 'views' | 'downloads'> & { ip: string | null; userAgent: string | null },
): Promise<{ counted: boolean }> => {
  const token = await viewToken({
    productId: event.productId,
    releaseId: event.releaseId,
    ip: event.ip,
    userAgent: event.userAgent,
  })
  const key = new Request(`https://marketplace.internal/views/${token}`)

  try {
    if (await caches.default.match(key)) {
      return { counted: false }
    }
    await caches.default.put(
      key,
      new Response(null, { headers: { 'Cache-Control': `max-age=${VIEW_DEDUP_WINDOW_SECONDS}` } }),
    )
  } catch (error) {
    // A cache that refuses to answer must not cost the count. Over-counting is the failure this
    // whole mechanism already tolerates.
    console.error('view dedup unavailable', error)
  }

  try {
    await bump(db, { ...event, views: 1 })
  } catch (error) {
    console.error('failed to record view', error)
    return { counted: false }
  }
  return { counted: true }
}

type SeriesPoint = { day: string; views: number; downloads: number }

/**
 * The daily series between two days, inclusive, with the empty days filled in.
 *
 * Zero-filled here rather than left to the front-end, which is the rule `summarizeSales` already
 * states: every bucket of a closed set is present at zero, so a chart has a stable set of points
 * and a quiet week reads as a quiet week rather than as a gap.
 */
const seriesForProduct = async (
  db: Database,
  productId: string,
  range: { from: string; to: string; releaseId?: string },
): Promise<SeriesPoint[]> => {
  const releaseId = range.releaseId ?? ALL_RELEASES
  const rows = await db
    .select({ day: productDailyStats.day, views: productDailyStats.views, downloads: productDailyStats.downloads })
    .from(productDailyStats)
    .where(
      and(
        eq(productDailyStats.productId, productId),
        eq(productDailyStats.releaseId, releaseId),
        gte(productDailyStats.day, range.from),
        lte(productDailyStats.day, range.to),
      ),
    )

  const byDay = new Map(rows.map((row) => [row.day, row]))
  return dayRange(range.from, range.to).map(
    (day) => byDay.get(day) ?? { day, views: 0, downloads: 0 },
  )
}

export { ALL_RELEASES, bump, recordDownloadStats, recordView, seriesForProduct }
export type { SeriesPoint, StatEvent }
