import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import { ALL_RELEASES } from '@/lib/analytics'
import { channelInput } from '@/lib/channels'
import { getRequestContext } from '@/services/audit'
import { recordView } from '@/services/analytics'
import { findProductBySlug } from '@/services/products'
import { findReleaseByVersion } from '@/services/releases'

/**
 * Counting a page view.
 *
 * **A POST on its own path, not a side effect of the GET that renders the page**, and the reason is
 * already in the code: the public reads carry `public, max-age=60`, so a cache hit never reaches
 * this Worker at all. A counter incremented in the read path would undercount by whatever the hit
 * ratio happened to be, and turning the caching off to fix that would cost far more than the number
 * is worth.
 *
 * Unauthenticated, because a view is a view. Deduplicated per viewer over a short window — see
 * `src/services/analytics.ts` for why that lives in the Cache API rather than in a table, and for
 * why the number is an approximation on purpose.
 */
const app = new Hono<AppEnv>()

const bodySchema = v.optional(
  v.strictObject({
    /** The release whose detail page was looked at. Absent means the product page itself. */
    version: v.optional(v.string()),
    channel: v.optional(channelInput),
  }),
)

app.post(
  '/products/:slug/views',
  describeRoute({
    description:
      'Counts one view of a product page, or of one release\'s detail page when `version` and `channel` are sent. Deduplicated per viewer for half an hour, and never cached. Answers 204 whether or not the view was counted: a client has nothing to do with the difference.',
    tags: ['Products'],
    responses: {
      204: { description: 'The view was recorded, or deduplicated' },
      404: { description: 'No published product with that slug, or no such published release' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', bodySchema),
  async (c) => {
    const body = c.req.valid('json') ?? {}
    const db = getDb(c.env)

    const product = await findProductBySlug(db, c.req.param('slug'))
    if (!product || product.status !== 'published') {
      throw new HTTPException(404, { message: 'Product not found' })
    }

    let releaseId = ALL_RELEASES
    if (body.version) {
      const release = await findReleaseByVersion(db, product.id, body.channel ?? 'release', body.version)
      if (!release || release.status !== 'published') {
        throw new HTTPException(404, { message: 'Release not found' })
      }
      releaseId = release.id
    }

    const { ip, userAgent } = getRequestContext(c)
    // Awaited rather than deferred: the answer is a 204 either way, and a view that lost its race
    // with the isolate shutting down is a view that silently did not count.
    await recordView(db, { productId: product.id, releaseId, ip, userAgent })

    return c.body(null, 204)
  },
)

export default app
