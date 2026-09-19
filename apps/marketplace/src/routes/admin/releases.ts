import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { productReleases } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { channelInput, STABLE_CHANNEL } from '@/lib/channels'
import { linkListSchema, serializeLinks } from '@/lib/links'
import { serializeTranslations } from '@/lib/locales'
import { optionalBody, optionalDate, requiredText, releaseTranslations } from '@/lib/validation'
import type { Product } from '@/services/products'
import { findProductById } from '@/services/products'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findReleaseById, listReleases, toAdminRelease } from '@/services/releases'

/**
 * Editorial API for the Releases tab, nested under the product it belongs to.
 *
 * Every route is scoped by `:productId` rather than reaching a release note by its id alone.
 * That is not decoration: it is what stops an id from one product being edited or deleted
 * through another's URL, and it makes a 404 mean the same thing whichever half of the pair is wrong.
 */
const app = new Hono<AppEnv>()

/** Reads the `:productId` path param, 404-ing when there is no such product. */
const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

/** Reads the `:id` path param as a release note of `product`, 404-ing on a mismatch. */
const requireRelease = async (db: Database, product: Product, id: string) => {
  const release = await findReleaseById(db, id)
  if (!release || release.productId !== product.id) {
    throw new HTTPException(404, { message: 'Release not found' })
  }
  return release
}

/**
 * A version label. Free text rather than semver: this Worker fronts a Minecraft plugin and a mobile
 * app equally well, and `2.6.4`, `v3`, `2026.1` and `1.0-beta` are all somebody's real version.
 * What it may not contain is a slash or whitespace — it is a path segment on the public route.
 */
const versionInput = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40), v.regex(/^[^\s/]+$/))

const releaseSchema = v.looseObject({ id: v.string(), version: v.string(), title: v.string(), status: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(releaseSchema) })
const itemResponseSchema = v.object({ code: v.literal(200), data: releaseSchema })

app.get(
  '/products/:productId/releases',
  describeRoute({
    description: 'Release notes of a product in every state, drafts included, newest release first.',
    tags: ['Admin · Releases'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Release notes', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator(
    'query',
    v.object({
      status: v.optional(v.picklist(CONTENT_STATUS)),
      limit: v.optional(
        v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
      ),
      offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
    }),
  ),
  async (c) => {
    const { status, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const rows = await listReleases(db, { productId: product.id, status, limit, offset })
    return c.json({ code: 200, data: rows.map(toAdminRelease) })
  },
)

const createSchema = v.object({
  version: versionInput,
  /** Which line this build is on. Defaults to `release`; see `src/lib/channels.ts`. */
  channel: v.optional(channelInput),
  /**
   * Whether publishing this release restarts the product's star rating.
   *
   * It deletes nothing — earlier reviews stay stored and stay readable, they just stop counting
   * toward the current average. See `src/services/ratings.ts`.
   */
  resets_rating: v.optional(v.boolean()),
  title: requiredText(200),
  body: optionalBody(BODY_LIMITS.release),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  /** The day the version shipped. Defaults to now on a release published straight away. */
  released_at: optionalDate,
  links: linkListSchema,
  translations: releaseTranslations,
})

app.post(
  '/products/:productId/releases',
  describeRoute({
    description:
      'Adds a release note. The version must be unique within the product, because that is how the public route addresses it. A release published without a `released_at` is dated now — a changelog entry with no date sorts below every dated one, which is never what was meant.',
    tags: ['Admin · Releases'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created release note', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
      409: { description: 'That version already exists in the product' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))

    const status = body.status ?? 'draft'
    const row = {
      id: crypto.randomUUID(),
      productId: product.id,
      version: body.version,
      channel: body.channel ?? STABLE_CHANNEL,
      resetsRating: body.resets_rating ?? false,
      viewCount: 0,
      downloadCount: 0,
      title: body.title,
      body: body.body ?? null,
      status,
      releasedAt: body.released_at ?? (status === 'published' ? now : null),
      links: serializeLinks(body.links),
      translations: serializeTranslations(body.translations),
      publishedAt: status === 'published' ? now : null,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(productReleases).values(row)
    } catch (error) {
      throw asConflict(error, `Version "${body.version}" already exists on the ${row.channel} channel`)
    }

    await recordAudit(db, {
      event: 'release.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_releases',
      resourceId: row.id,
      metadata: { product: product.slug, version: row.version, status },
    })

    return c.json({ code: 201, data: toAdminRelease(row) }, 201)
  },
)

app.get(
  '/products/:productId/releases/:id',
  describeRoute({
    description: 'A single release note by id, in whatever state it is in.',
    tags: ['Admin · Releases'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The release note', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('id'))
    return c.json({ code: 200, data: toAdminRelease(release) })
  },
)

const patchSchema = v.object({
  version: v.optional(versionInput),
  channel: v.optional(channelInput),
  resets_rating: v.optional(v.boolean()),
  title: v.optional(requiredText(200)),
  body: optionalBody(BODY_LIMITS.release),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  released_at: optionalDate,
  /** Replaces the whole list; it is not merged. */
  links: linkListSchema,
  /** Replaces the whole translation map — send every locale you want to keep. */
  translations: releaseTranslations,
})

app.patch(
  '/products/:productId/releases/:id',
  describeRoute({
    description:
      'Updates a release note. Omitted fields are left alone, an explicit `null` clears one. `links` and `translations` are replaced wholesale rather than merged.',
    tags: ['Admin · Releases'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated release note', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
      409: { description: 'Another release in the product already uses that version' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const product = await requireProduct(db, c.req.param('productId'))
    const current = await requireRelease(db, product, c.req.param('id'))

    const status = body.status ?? current.status
    const updated = {
      ...current,
      version: body.version ?? current.version,
      channel: body.channel ?? current.channel,
      resetsRating: body.resets_rating ?? current.resetsRating,
      title: body.title ?? current.title,
      body: body.body === undefined ? current.body : body.body,
      status,
      releasedAt:
        body.released_at === undefined
          ? // Going live for the first time with no date on the row dates it now, for the same
            // reason `POST` does: an undated release sorts below every dated one.
            (current.releasedAt ?? (status === 'published' ? now : null))
          : body.released_at,
      links: body.links === undefined ? current.links : serializeLinks(body.links),
      translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
      publishedAt: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(productReleases)
        .set({
          version: updated.version,
          channel: updated.channel,
          resetsRating: updated.resetsRating,
          title: updated.title,
          body: updated.body,
          status: updated.status,
          releasedAt: updated.releasedAt,
          links: updated.links,
          translations: updated.translations,
          publishedAt: updated.publishedAt,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(productReleases.id, current.id))
    } catch (error) {
      throw asConflict(error, `Version "${updated.version}" already exists on the ${updated.channel} channel`)
    }

    await recordAudit(db, {
      event: 'release.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_releases',
      resourceId: current.id,
      metadata: { product: product.slug, version: updated.version, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminRelease(updated) })
  },
)

app.delete(
  '/products/:productId/releases/:id',
  describeRoute({
    description: 'Deletes a release note for good. Setting `status` to `archived` hides it from the tab without losing the text.',
    tags: ['Admin · Releases'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The release note was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('id'))

    await db.delete(productReleases).where(eq(productReleases.id, release.id))
    await recordAudit(db, {
      event: 'release.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_releases',
      resourceId: release.id,
      metadata: { product: product.slug, version: release.version },
    })

    return c.body(null, 204)
  },
)

export default app
