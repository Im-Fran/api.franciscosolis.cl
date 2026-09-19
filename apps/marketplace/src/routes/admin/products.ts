import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { products } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { categoryInput } from '@/lib/categories'
import { asConflict } from '@/lib/errors'
import { linkListSchema, serializeLinks } from '@/lib/links'
import { serializeTranslations } from '@/lib/locales'
import { optionalAmount, PRICING_MODES } from '@/lib/pricing'
import { SLUG_PATTERN, slugify } from '@/lib/slug'
import { serializeTabs, TAB_KEYS } from '@/lib/tabs'
import {
  productTranslations,
  optionalBody,
  optionalHexColor,
  optionalText,
  optionalUrl,
  requiredText,
} from '@/lib/validation'
import { findProductById, listProducts, toAdminProduct } from '@/services/products'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'

/**
 * Editorial API for the products themselves. Every route here is behind `requireEditor`
 * (applied once in `routes/admin/index.ts`), and unlike the public routes it sees every state.
 */
const app = new Hono<AppEnv>()

const productSchema = v.looseObject({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  status: v.string(),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(productSchema) })
const productResponseSchema = v.object({ code: v.literal(200), data: productSchema })

const listQuerySchema = v.object({
  status: v.optional(v.picklist(CONTENT_STATUS)),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/products',
  describeRoute({
    description: 'Every product in every state, drafts included. `status` narrows the listing.',
    tags: ['Admin · Products'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Products', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed to edit product pages' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const { status, search, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const rows = await listProducts(getDb(c.env), { status, search, limit, offset })
    return c.json({ code: 200, data: rows.map(toAdminProduct) })
  },
)

const reorderSchema = v.object({
  items: v.pipe(
    v.array(v.object({ id: v.string(), position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999)) })),
    v.minLength(1),
    v.maxLength(PAGINATION.maxLimit),
  ),
})

// Registered before `/products/:id` so the literal segment is never swallowed by the parameter,
// whichever router Hono picks at runtime.
app.post(
  '/products/reorder',
  describeRoute({
    description: 'Sets the manual `position` of several products at once — what a drag-and-drop list sends after a reorder.',
    tags: ['Admin · Products'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reordered products' },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('json', reorderSchema),
  async (c) => {
    const { items } = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    for (const item of items) {
      await db
        .update(products)
        .set({ position: item.position, updatedBy: editor.email, updatedAt: now })
        .where(eq(products.id, item.id))
    }

    await recordAudit(db, {
      event: 'product.reordered',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'products',
      metadata: { count: items.length },
    })

    const rows = await listProducts(db, { limit: PAGINATION.maxLimit, offset: 0 })
    return c.json({ code: 200, data: rows.map(toAdminProduct) })
  },
)

/** The tabs an editor may turn on. `overview` is added back by `serializeTabs` whatever is sent. */
const tabList = v.optional(v.array(v.picklist(TAB_KEYS)))

const createSchema = v.object({
  /** Derived from the name when omitted. This is what `/product/<slug>` resolves. */
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  name: requiredText(120),
  tagline: optionalText(200),
  summary: optionalText(600),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  featured: v.optional(v.boolean()),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  banner_image_url: optionalUrl,
  icon_image_url: optionalUrl,
  accent_color: optionalHexColor,
  tabs: tabList,
  links: linkListSchema,
  overview_body: optionalBody(BODY_LIMITS.page),
  contact_body: optionalBody(BODY_LIMITS.page),
  /**
   * How the page takes money: `free`, `donation` (optional payment, skipping allowed) or `paid` (a
   * download needs an approved purchase). See `src/lib/pricing.ts`.
   */
  pricing_mode: v.optional(v.picklist(PRICING_MODES)),
  /** Price of a `paid` product, in whole CLP. */
  price_amount: optionalAmount,
  /**
   * Whether a pre-release build needs an approved purchase. Settable in any mode and inert outside
   * `paid` — `describePricing` reports it as `false` there, so a mode change never has to retype it.
   */
  pre_release_requires_purchase: v.optional(v.boolean()),
  /** What kind of thing this is, from the closed vocabulary in `src/lib/categories.ts`. */
  category: categoryInput,
  /** Amount a `donation` product suggests in its modal, in whole CLP. */
  suggested_amount: optionalAmount,
  translations: productTranslations,
})

app.post(
  '/products',
  describeRoute({
    description:
      'Creates a product page. The slug defaults to a slugified name and must be unique across the service, because it is a path segment on the website. `tabs` always comes back with `overview` first — a page with no overview is a banner and a row of links.',
    tags: ['Admin · Products'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created product', content: { 'application/json': { schema: resolver(productResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      409: { description: 'A product with that slug already exists' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const slug = body.slug ?? slugify(body.name)
    if (!slug) {
      throw new HTTPException(422, { message: 'Could not derive a slug from the name; send one explicitly' })
    }

    const status = body.status ?? 'draft'
    const row = {
      id: crypto.randomUUID(),
      slug,
      name: body.name,
      tagline: body.tagline ?? null,
      summary: body.summary ?? null,
      status,
      featured: body.featured ?? false,
      position: body.position ?? 0,
      bannerImageUrl: body.banner_image_url ?? null,
      iconImageUrl: body.icon_image_url ?? null,
      accentColor: body.accent_color ?? null,
      tabs: serializeTabs(body.tabs),
      links: serializeLinks(body.links),
      overviewBody: body.overview_body ?? null,
      contactBody: body.contact_body ?? null,
      pricingMode: body.pricing_mode ?? 'free',
      preReleaseRequiresPurchase: body.pre_release_requires_purchase ?? false,
      category: body.category ?? null,
      viewCount: 0,
      downloadCount: 0,
      priceAmount: body.price_amount ?? null,
      suggestedAmount: body.suggested_amount ?? null,
      translations: serializeTranslations(body.translations),
      publishedAt: status === 'published' ? now : null,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(products).values(row)
    } catch (error) {
      throw asConflict(error, `A product with slug "${slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'product.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'products',
      resourceId: row.id,
      metadata: { slug, status },
    })

    return c.json({ code: 201, data: toAdminProduct(row) }, 201)
  },
)

app.get(
  '/products/:id',
  describeRoute({
    description: 'A single product by id, in whatever state it is in, with its raw translation map.',
    tags: ['Admin · Products'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The product', content: { 'application/json': { schema: resolver(productResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  async (c) => {
    const product = await findProductById(getDb(c.env), c.req.param('id'))
    if (!product) {
      throw new HTTPException(404, { message: 'Product not found' })
    }
    return c.json({ code: 200, data: toAdminProduct(product) })
  },
)

const patchSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  name: v.optional(requiredText(120)),
  tagline: optionalText(200),
  summary: optionalText(600),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  featured: v.optional(v.boolean()),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  banner_image_url: optionalUrl,
  icon_image_url: optionalUrl,
  accent_color: optionalHexColor,
  /** Replaces the whole list; it is not merged. */
  tabs: tabList,
  /** Replaces the whole list, same as `tabs`. */
  links: linkListSchema,
  overview_body: optionalBody(BODY_LIMITS.page),
  contact_body: optionalBody(BODY_LIMITS.page),
  /**
   * How the page takes money: `free`, `donation` (optional payment, skipping allowed) or `paid` (a
   * download needs an approved purchase). See `src/lib/pricing.ts`.
   */
  pricing_mode: v.optional(v.picklist(PRICING_MODES)),
  /** Price of a `paid` product, in whole CLP. */
  price_amount: optionalAmount,
  /**
   * Whether a pre-release build needs an approved purchase. Settable in any mode and inert outside
   * `paid` — `describePricing` reports it as `false` there, so a mode change never has to retype it.
   */
  pre_release_requires_purchase: v.optional(v.boolean()),
  /** What kind of thing this is, from the closed vocabulary in `src/lib/categories.ts`. */
  category: categoryInput,
  /** Amount a `donation` product suggests in its modal, in whole CLP. */
  suggested_amount: optionalAmount,
  /** Replaces the whole translation map — send every locale you want to keep. */
  translations: productTranslations,
})

app.patch(
  '/products/:id',
  describeRoute({
    description:
      'Updates a product. Omitted fields are left alone, an explicit `null` clears one. `tabs`, `links` and `translations` are replaced wholesale rather than merged, so send the complete value.',
    tags: ['Admin · Products'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated product', content: { 'application/json': { schema: resolver(productResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
      409: { description: 'Another product already uses that slug' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const current = await findProductById(db, c.req.param('id'))
    if (!current) {
      throw new HTTPException(404, { message: 'Product not found' })
    }

    const status = body.status ?? current.status
    const updated = {
      ...current,
      slug: body.slug ?? current.slug,
      name: body.name ?? current.name,
      tagline: body.tagline === undefined ? current.tagline : body.tagline,
      summary: body.summary === undefined ? current.summary : body.summary,
      status,
      featured: body.featured ?? current.featured,
      position: body.position ?? current.position,
      bannerImageUrl: body.banner_image_url === undefined ? current.bannerImageUrl : body.banner_image_url,
      iconImageUrl: body.icon_image_url === undefined ? current.iconImageUrl : body.icon_image_url,
      accentColor: body.accent_color === undefined ? current.accentColor : body.accent_color,
      tabs: body.tabs === undefined ? current.tabs : serializeTabs(body.tabs),
      links: body.links === undefined ? current.links : serializeLinks(body.links),
      overviewBody: body.overview_body === undefined ? current.overviewBody : body.overview_body,
      contactBody: body.contact_body === undefined ? current.contactBody : body.contact_body,
      pricingMode: body.pricing_mode ?? current.pricingMode,
      preReleaseRequiresPurchase:
        body.pre_release_requires_purchase === undefined
          ? current.preReleaseRequiresPurchase
          : body.pre_release_requires_purchase,
      category: body.category === undefined ? current.category : body.category,
      // Kept when the mode changes rather than cleared: an editor switching a paid product to
      // `donation` for a launch week should not have to retype its price to switch back, and
      // `describePricing` is what stops the stale figure from ever being quoted publicly.
      priceAmount: body.price_amount === undefined ? current.priceAmount : body.price_amount,
      suggestedAmount: body.suggested_amount === undefined ? current.suggestedAmount : body.suggested_amount,
      translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
      // Stamped the first time a page goes live and kept from then on, so unpublishing and
      // republishing does not rewrite the date the product was originally announced.
      publishedAt: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(products)
        .set({
          slug: updated.slug,
          name: updated.name,
          tagline: updated.tagline,
          summary: updated.summary,
          status: updated.status,
          featured: updated.featured,
          position: updated.position,
          bannerImageUrl: updated.bannerImageUrl,
          iconImageUrl: updated.iconImageUrl,
          accentColor: updated.accentColor,
          tabs: updated.tabs,
          links: updated.links,
          overviewBody: updated.overviewBody,
          contactBody: updated.contactBody,
          pricingMode: updated.pricingMode,
          preReleaseRequiresPurchase: updated.preReleaseRequiresPurchase,
          category: updated.category,
          priceAmount: updated.priceAmount,
          suggestedAmount: updated.suggestedAmount,
          translations: updated.translations,
          publishedAt: updated.publishedAt,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(products.id, current.id))
    } catch (error) {
      throw asConflict(error, `A product with slug "${updated.slug}" already exists`)
    }

    // A pricing change is filed under its own event, not folded into `product.updated`: it is the
    // one edit here that changes what somebody is charged, and a trail it can be read out of has to be
    // queryable by event rather than by reading every field list ever written.
    // `pre_release_requires_purchase` counts as a pricing change even though it names no amount: it
    // decides who can obtain a build, which is the same question the mode and the price answer.
    const touchedPricing = [
      'pricing_mode',
      'price_amount',
      'suggested_amount',
      'pre_release_requires_purchase',
    ].some((field) => field in body)

    await recordAudit(db, {
      event: touchedPricing ? 'pricing.updated' : 'product.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'products',
      resourceId: current.id,
      metadata: touchedPricing
        ? {
            slug: updated.slug,
            fields: Object.keys(body),
            status,
            pricing_mode: updated.pricingMode,
            price_amount: updated.priceAmount,
            suggested_amount: updated.suggestedAmount,
            pre_release_requires_purchase: updated.preReleaseRequiresPurchase,
          }
        : { slug: updated.slug, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminProduct(updated) })
  },
)

app.delete(
  '/products/:id',
  describeRoute({
    description:
      'Deletes a product and, with it, every release note and wiki page it holds — that is what the foreign keys cascade. Prefer setting `status` to `archived` when the page might come back: it disappears from the website without losing the text.',
    tags: ['Admin · Products'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The product was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await findProductById(db, c.req.param('id'))
    if (!product) {
      throw new HTTPException(404, { message: 'Product not found' })
    }

    await db.delete(products).where(eq(products.id, product.id))
    await recordAudit(db, {
      event: 'product.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'products',
      resourceId: product.id,
      metadata: { slug: product.slug },
    })

    return c.body(null, 204)
  },
)

export default app
