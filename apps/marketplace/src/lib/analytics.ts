/**
 * The two numbers a product page reports about itself — how often it was looked at, and how often
 * something was taken from it — and the rules for counting them.
 *
 * Three things here are decisions rather than mechanics.
 *
 * **A view is counted by a POST, not by the GET that renders the page.** The public reads carry
 * `public, max-age=60` (`PUBLIC_CACHE_SECONDS`), so a cache hit never reaches this Worker at all: a
 * counter incremented in the read path would undercount by whatever the hit ratio happens to be,
 * and turning the caching off to fix that would cost far more than the number is worth.
 *
 * **A view is deduplicated in the Cache API, not in D1.** A dedup table means a write on every
 * view — deduped or not — plus a purge job this Worker has no cron to run. `caches.default` expires
 * by itself. The cost is that it is per-colo, so one person reaching two colos inside the window is
 * counted twice: **the view counter is an approximation on purpose.** `download_events` is the exact
 * record, and nothing financial is ever derived from a view.
 *
 * **The address is hashed into the token and never stored.** A view counter is not a reason to keep
 * somebody's IP.
 */

/**
 * The product-wide row's `release_id`.
 *
 * The empty string rather than NULL, and that is not stylistic: SQLite treats NULLs as *distinct*
 * inside a unique index, so `INSERT … ON CONFLICT (product_id, release_id, day) DO UPDATE` would
 * never match the product-wide row and every event would insert a new one instead of incrementing.
 * Nothing compares against this constant directly — `isProductWide` is the one place that knows,
 * the same discipline `UNLINKED_USER_ID` gets in `src/lib/sales.ts`.
 */
const ALL_RELEASES = ''

const isProductWide = (releaseId: string): boolean => releaseId === ALL_RELEASES

/** How long the same viewer is not counted again. Long enough for a reload, short enough to be a visit. */
const VIEW_DEDUP_WINDOW_SECONDS = 1_800

/** Longest series `GET /admin/products/:id/analytics` will build, so a bad range cannot be a scan. */
const MAX_SERIES_DAYS = 366

/** Days the admin series covers when the caller names no range. */
const DEFAULT_SERIES_DAYS = 30

/** The bucket a moment falls in: `YYYY-MM-DD`, always UTC, never the viewer's timezone. */
const dayKey = (at: Date): string => at.toISOString().slice(0, 10)

/** The day `days` before `from`, as a bucket label. Used to build the default range. */
const shiftDay = (from: Date, days: number): string => dayKey(new Date(from.getTime() + days * 86_400_000))

/** Every bucket label from `start` to `end` inclusive, so a series can be zero-filled. */
const dayRange = (start: string, end: string): string[] => {
  const days: string[] = []
  const last = Date.parse(`${end}T00:00:00.000Z`)
  for (let at = Date.parse(`${start}T00:00:00.000Z`); at <= last; at += 86_400_000) {
    days.push(dayKey(new Date(at)))
    if (days.length > MAX_SERIES_DAYS) {
      break
    }
  }
  return days
}

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * The opaque key one viewer's view of one thing is deduplicated under.
 *
 * Bucketed on `floor(now / window)` so the token itself rolls over at the window boundary — there
 * is no expiry to track anywhere, and a cached entry that outlives its window simply stops being
 * looked up. The IP goes in and never comes out.
 */
const viewToken = async (input: {
  productId: string
  releaseId: string
  ip: string | null
  userAgent: string | null
  now?: Date
}): Promise<string> => {
  const bucket = Math.floor((input.now ?? new Date()).getTime() / 1000 / VIEW_DEDUP_WINDOW_SECONDS)
  const material = [input.productId, input.releaseId, input.ip ?? '-', input.userAgent ?? '-', bucket].join('\u0000')
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)))
}

export {
  ALL_RELEASES,
  dayKey,
  dayRange,
  DEFAULT_SERIES_DAYS,
  isProductWide,
  MAX_SERIES_DAYS,
  shiftDay,
  VIEW_DEDUP_WINDOW_SECONDS,
  viewToken,
}
