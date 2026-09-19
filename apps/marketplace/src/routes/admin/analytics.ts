import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { ALL_RELEASES, DEFAULT_SERIES_DAYS, dayKey, MAX_SERIES_DAYS, shiftDay } from '@/lib/analytics'
import { seriesForProduct } from '@/services/analytics'
import type { Product } from '@/services/products'
import { findProductById } from '@/services/products'
import { findReleaseById } from '@/services/releases'

/**
 * The traffic behind one product, for the back office.
 *
 * The counters answer "how many in total" and are already on the product and the release; this is
 * the shape of it over time. Zero days are filled in by the service rather than left out, which is
 * the same rule `summarizeSales` states for its buckets.
 */
const app = new Hono<AppEnv>()

const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const responseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    totals: v.object({ views: v.number(), downloads: v.number() }),
    series: v.array(v.object({ day: v.string(), views: v.number(), downloads: v.number() })),
  }),
})

app.get(
  '/products/:productId/analytics',
  describeRoute({
    description:
      'Views and downloads per day, plus the all-time totals. `from` and `to` are `YYYY-MM-DD` in UTC and default to the last thirty days; `release_id` narrows it to one version rather than the product as a whole. Days with nothing on them come back as zeros, so a chart has a stable set of points.',
    tags: ['Admin · Analytics'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The series', content: { 'application/json': { schema: resolver(responseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
      422: { description: 'The range is backwards or longer than a year' },
    },
  }),
  validator(
    'query',
    v.object({
      from: v.optional(v.pipe(v.string(), v.regex(DAY_PATTERN))),
      to: v.optional(v.pipe(v.string(), v.regex(DAY_PATTERN))),
      release_id: v.optional(v.string()),
    }),
  ),
  async (c) => {
    const query = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const now = new Date()
    const to = query.to ?? dayKey(now)
    const from = query.from ?? shiftDay(now, -(DEFAULT_SERIES_DAYS - 1))

    if (from > to) {
      throw new HTTPException(422, { message: '`from` is after `to`' })
    }
    // Bounded so a mistyped year cannot turn a chart into a table scan.
    const days = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
    if (days > MAX_SERIES_DAYS) {
      throw new HTTPException(422, { message: `A series covers at most ${MAX_SERIES_DAYS} days` })
    }

    let releaseId = ALL_RELEASES
    let totals = { views: product.viewCount, downloads: product.downloadCount }
    if (query.release_id) {
      const release = await findReleaseById(db, query.release_id)
      if (!release || release.productId !== product.id) {
        throw new HTTPException(404, { message: 'Release not found' })
      }
      releaseId = release.id
      totals = { views: release.viewCount, downloads: release.downloadCount }
    }

    const series = await seriesForProduct(db, product.id, { from, to, releaseId })
    return c.json({ code: 200, data: { totals, series } })
  },
)

export default app
