import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { channelFilterInput, channelInput, resolveChannelFilter } from '@/lib/channels'
import { listCompatibility, toPublicCompatibility } from '@/services/compatibility'
import { isChannelGated } from '@/services/access'
import { listReleaseFiles, toPublicReleaseFile } from '@/services/release-files'
import { describePricing } from '@/lib/pricing'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import type { AppEnv } from '@/env'
import { PAGINATION, PUBLIC_CACHE_SECONDS } from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'
import type { Product } from '@/services/products'
import { findProductBySlug, listProducts, toPublicProduct, toPublicProductSummary } from '@/services/products'
import { findReleaseByVersion, listReleases, toPublicRelease } from '@/services/releases'
import { buildWikiTree, findWikiPageBySlug, listWikiPages, toPublicWikiPage } from '@/services/wiki'

/**
 * Public read API for the standalone product pages. No authentication: this is what
 * franciscosolis.cl calls to render `/product/<slug>`, so it only ever exposes `published`
 * rows — a draft is invisible here regardless of what is asked for, and a draft product hides
 * its releases and its wiki along with it.
 *
 * Every read takes an optional `?locale`. It is a query parameter rather than `Accept-Language` on
 * purpose: these responses are cached publicly, and a language chosen by a header is a language a
 * shared cache has to be told to vary on — one missing `Vary` and the wrong country gets the wrong
 * cached copy. In the URL it is part of the cache key by construction.
 */
const app = new Hono<AppEnv>()

/** Shared by every public read: which language the prose fields should come back in. */
const localeQuery = v.optional(v.picklist(LOCALES))

/**
 * Resolves the `:slug` path segment to a published product, 404-ing on anything else.
 *
 * A draft answers 404 rather than 403 for the same reason a draft entry does in the CMS: the
 * existence of an unannounced product is not public information, and a 403 confirms the slug.
 */
const requirePublishedProduct = async (db: Database, slug: string): Promise<Product> => {
  const product = await findProductBySlug(db, slug)
  if (!product || product.status !== 'published') {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

const productSchema = v.looseObject({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  tabs: v.array(v.string()),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(productSchema) })

const listQuerySchema = v.object({
  locale: localeQuery,
  featured: v.optional(v.picklist(['true', 'false'])),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/products',
  describeRoute({
    description:
      'Published products, in the order an editor arranged them. The two tab bodies are left out here — they are full Markdown documents, and the single-product read is where they live.',
    tags: ['Products'],
    responses: {
      200: { description: 'Published products', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const { locale = DEFAULT_LOCALE, featured, search, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')

    const rows = await listProducts(getDb(c.env), {
      status: 'published',
      featured: featured === undefined ? undefined : featured === 'true',
      search,
      limit,
      offset,
    })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: rows.map((row) => toPublicProductSummary(row, locale)) })
  },
)

const productResponseSchema = v.object({ code: v.literal(200), data: productSchema })

app.get(
  '/products/:slug',
  describeRoute({
    description:
      'One published product: the banner, the tab bar, the links, and the Markdown behind the Overview and Contact tabs. The Releases and Wiki tabs are lists, and have routes of their own.',
    tags: ['Products'],
    responses: {
      200: { description: 'The product', content: { 'application/json': { schema: resolver(productResponseSchema) } } },
      404: { description: 'No published product with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const product = await requirePublishedProduct(getDb(c.env), c.req.param('slug'))

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicProduct(product, locale) })
  },
)

const releaseSchema = v.looseObject({ id: v.string(), version: v.string(), title: v.string() })
const releaseListResponseSchema = v.object({ code: v.literal(200), data: v.array(releaseSchema) })

app.get(
  '/products/:slug/releases',
  describeRoute({
    description:
      'The product\'s Releases tab: published release notes, newest release first. Ordered by the date the version shipped rather than by when the entry was written, so back-dating a forgotten release puts it where it belongs instead of at the top. `?channel` picks the line to read — it defaults to `release`, and `all` lifts the filter. Every channel is readable by anybody; what a pre-release may cost is a download, never the page.',
    tags: ['Products'],
    responses: {
      200: { description: 'Published release notes', content: { 'application/json': { schema: resolver(releaseListResponseSchema) } } },
      404: { description: 'No published product with that slug' },
    },
  }),
  validator(
    'query',
    v.object({
      locale: localeQuery,
      /**
       * Which line to read. Absent means the stable one, which is the opt-in the whole channel
       * model turns on: the default view of a product is what it ships, and somebody who wants
       * tonight's build asks for it by name. `all` lifts the filter.
       *
       * Unknown values are refused rather than falling back, unlike a tab key. A tab key is
       * content and degrades to one tab fewer; a channel is a filter, and a typo that silently
       * became `release` would be invisible while a typo that silently became `all` would put
       * nightlies in front of somebody who never asked for one.
       */
      channel: channelFilterInput,
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { locale = DEFAULT_LOCALE, channel, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const rows = await listReleases(db, {
      productId: product.id,
      status: 'published',
      channels: resolveChannelFilter(channel),
      limit,
      offset,
    })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: rows.map((row) => toPublicRelease(row, locale)) })
  },
)

app.get(
  '/products/:slug/releases/:channel/:version',
  describeRoute({
    description:
      'One published release, addressed by its channel and its version label inside the product, with its builds and what they run on inlined — this is the view behind "see detail". The channel is part of the address because it is part of the key: `1.4.0` can exist as an `rc` and, later, as a `release`. It carries no per-caller access block on purpose, so it stays cacheable; ask `GET /products/:slug/access?channel=…` for that half.',
    tags: ['Products'],
    responses: {
      200: { description: 'The release note', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: releaseSchema })) } } },
      404: { description: 'No published product, or no published release on that channel with that version' },
    },
  }),
  validator('param', v.object({ slug: v.string(), channel: channelInput, version: v.string() })),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const { channel, version } = c.req.valid('param')
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const release = await findReleaseByVersion(db, product.id, channel, version)
    if (!release || release.status !== 'published') {
      throw new HTTPException(404, { message: 'Release not found' })
    }

    // The builds and the requirements are inlined rather than left to two more round trips: this is
    // the view that renders the download buttons and the "runs on" panel, and it would fetch both
    // immediately anyway. `object_key` is still absent — `toPublicReleaseFile` cannot carry it.
    const [compatibility, files] = await Promise.all([
      listCompatibility(db, release.id),
      listReleaseFiles(db, { releaseId: release.id, status: 'published' }),
    ])
    const pricing = describePricing(product)

    // Fully public and fully cacheable, and carrying **no** per-caller access block. A shared cache
    // keying only on the URL would otherwise serve one buyer's `can_download: true` to everybody;
    // the per-person half is `GET /products/:slug/access?channel=…`, which is `no-store`.
    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({
      code: 200,
      data: {
        ...toPublicRelease(release, locale),
        compatibility: compatibility.map(toPublicCompatibility),
        files: files.filter((file) => file.uploadedAt !== null).map(toPublicReleaseFile),
        requires_payment: pricing.requires_payment,
        channel_requires_purchase: isChannelGated(pricing, channel),
      },
    })
  },
)

const wikiNodeSchema = v.looseObject({ id: v.string(), slug: v.string(), title: v.string() })
const wikiTreeResponseSchema = v.object({ code: v.literal(200), data: v.array(wikiNodeSchema) })

app.get(
  '/products/:slug/wiki',
  describeRoute({
    description:
      'The wiki sidebar: every published page of the product as a tree, without bodies. A page whose section is still a draft is listed at the top level rather than dropped, so an unpublished heading never hides published documentation.',
    tags: ['Products'],
    responses: {
      200: { description: 'The sidebar', content: { 'application/json': { schema: resolver(wikiTreeResponseSchema) } } },
      404: { description: 'No published product with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const pages = await listWikiPages(db, { productId: product.id, status: 'published' })

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: buildWikiTree(pages, locale) })
  },
)

app.get(
  '/products/:slug/wiki/:page',
  describeRoute({
    description: 'One published wiki page with its Markdown body, addressed by its slug inside the product.',
    tags: ['Products'],
    responses: {
      200: { description: 'The page', content: { 'application/json': { schema: resolver(v.object({ code: v.literal(200), data: wikiNodeSchema })) } } },
      404: { description: 'No published product, or no published page with that slug' },
    },
  }),
  validator('query', v.object({ locale: localeQuery })),
  async (c) => {
    const { locale = DEFAULT_LOCALE } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requirePublishedProduct(db, c.req.param('slug'))

    const page = await findWikiPageBySlug(db, product.id, c.req.param('page'))
    if (!page || page.status !== 'published') {
      throw new HTTPException(404, { message: 'Wiki page not found' })
    }

    c.header('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`)
    return c.json({ code: 200, data: toPublicWikiPage(page, locale) })
  },
)

export default app
