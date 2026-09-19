import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { productWikiPages } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { serializeTranslations } from '@/lib/locales'
import { SLUG_PATTERN, slugify } from '@/lib/slug'
import { optionalBody, optionalText, requiredText, wikiTranslations } from '@/lib/validation'
import type { Product } from '@/services/products'
import { findProductById } from '@/services/products'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import {
  buildWikiTree,
  findWikiPageById,
  listWikiPages,
  resolveParentId,
  toAdminWikiPage,
  WikiHierarchyError,
} from '@/services/wiki'

/**
 * Editorial API for the Wiki tab, nested under the product it belongs to, for the same reason
 * the releases routes are: an id reached through the wrong product's URL must 404 rather than
 * resolve.
 */
const app = new Hono<AppEnv>()

const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

const requirePage = async (db: Database, product: Product, id: string) => {
  const page = await findWikiPageById(db, id)
  if (!page || page.productId !== product.id) {
    throw new HTTPException(404, { message: 'Wiki page not found' })
  }
  return page
}

/** Turns a rejected hierarchy into a 422 rather than letting it reach `onError` as a 500. */
const resolveParentOrThrow = async (
  db: Database,
  productId: string,
  page: Parameters<typeof resolveParentId>[2],
  parentId: string | null,
) => {
  try {
    return await resolveParentId(db, productId, page, parentId)
  } catch (error) {
    if (error instanceof WikiHierarchyError) {
      throw new HTTPException(422, { message: error.message })
    }
    throw error
  }
}

const pageSchema = v.looseObject({ id: v.string(), slug: v.string(), title: v.string(), status: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(pageSchema) })
const itemResponseSchema = v.object({ code: v.literal(200), data: pageSchema })

app.get(
  '/products/:productId/wiki',
  describeRoute({
    description:
      'Wiki pages of a product in every state, drafts included, as a flat list in sidebar order. `tree=true` returns the same pages nested, which is what a sidebar preview wants.',
    tags: ['Admin · Wiki'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Wiki pages', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator(
    'query',
    v.object({
      status: v.optional(v.picklist(CONTENT_STATUS)),
      tree: v.optional(v.picklist(['true', 'false'])),
    }),
  ),
  async (c) => {
    const { status, tree } = c.req.valid('query')
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))

    const pages = await listWikiPages(db, { productId: product.id, status })
    // The tree drops the bodies, which is what makes it a sidebar rather than a second copy of the
    // whole wiki; the flat list keeps them, because that is what an editor's list screen edits.
    return c.json({ code: 200, data: tree === 'true' ? buildWikiTree(pages) : pages.map(toAdminWikiPage) })
  },
)

const reorderSchema = v.object({
  items: v.pipe(
    v.array(v.object({ id: v.string(), position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999)) })),
    v.minLength(1),
    v.maxLength(PAGINATION.maxLimit),
  ),
})

// Registered before `/wiki/:id` so the literal segment is never swallowed by the parameter.
app.post(
  '/products/:productId/wiki/reorder',
  describeRoute({
    description:
      'Sets the manual `position` of several wiki pages at once. Ids that do not belong to the product are ignored, so a reorder cannot reach into another product\'s sidebar.',
    tags: ['Admin · Wiki'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reordered pages' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
    },
  }),
  validator('json', reorderSchema),
  async (c) => {
    const { items } = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))

    for (const item of items) {
      await db
        .update(productWikiPages)
        .set({ position: item.position, updatedBy: editor.email, updatedAt: now })
        .where(
          and(eq(productWikiPages.id, item.id), eq(productWikiPages.productId, product.id)),
        )
    }

    await recordAudit(db, {
      event: 'wiki.reordered',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_wiki_pages',
      metadata: { product: product.slug, count: items.length },
    })

    const pages = await listWikiPages(db, { productId: product.id })
    return c.json({ code: 200, data: pages.map(toAdminWikiPage) })
  },
)

const createSchema = v.object({
  /** Derived from the title when omitted. Unique within the product. */
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  title: requiredText(200),
  body: optionalBody(BODY_LIMITS.page),
  /** Section this page hangs under. `null` — or absent — puts it at the top of the sidebar. */
  parent_id: v.optional(v.nullable(v.string())),
  /** Icon slug the website resolves, not a URL. */
  icon: optionalText(60),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  translations: wikiTranslations,
})

app.post(
  '/products/:productId/wiki',
  describeRoute({
    description:
      'Adds a wiki page. The slug defaults to a slugified title and must be unique within the product, because it is the path segment the public route resolves. `parent_id` nests the page under a top-level one; the sidebar is only two levels deep, so a nested page cannot itself be a parent.',
    tags: ['Admin · Wiki'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created page', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product' },
      409: { description: 'A page with that slug already exists in the product' },
      422: { description: 'The body failed validation, or the parent cannot hold this page' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))

    const slug = body.slug ?? slugify(body.title)
    if (!slug) {
      throw new HTTPException(422, { message: 'Could not derive a slug from the title; send one explicitly' })
    }

    const parentId = await resolveParentOrThrow(db, product.id, null, body.parent_id ?? null)
    const status = body.status ?? 'draft'

    const row = {
      id: crypto.randomUUID(),
      productId: product.id,
      parentId,
      slug,
      title: body.title,
      icon: body.icon ?? null,
      body: body.body ?? null,
      status,
      position: body.position ?? 0,
      translations: serializeTranslations(body.translations),
      publishedAt: status === 'published' ? now : null,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(productWikiPages).values(row)
    } catch (error) {
      throw asConflict(error, `A wiki page with slug "${slug}" already exists in this product`)
    }

    await recordAudit(db, {
      event: 'wiki.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_wiki_pages',
      resourceId: row.id,
      metadata: { product: product.slug, slug, status },
    })

    return c.json({ code: 201, data: toAdminWikiPage(row) }, 201)
  },
)

app.get(
  '/products/:productId/wiki/:id',
  describeRoute({
    description: 'A single wiki page by id, in whatever state it is in, with its raw translation map.',
    tags: ['Admin · Wiki'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The page', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or page' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const page = await requirePage(db, product, c.req.param('id'))
    return c.json({ code: 200, data: toAdminWikiPage(page) })
  },
)

const patchSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  title: v.optional(requiredText(200)),
  body: optionalBody(BODY_LIMITS.page),
  /** `null` moves the page back to the top level of the sidebar. */
  parent_id: v.optional(v.nullable(v.string())),
  icon: optionalText(60),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  /** Replaces the whole translation map — send every locale you want to keep. */
  translations: wikiTranslations,
})

app.patch(
  '/products/:productId/wiki/:id',
  describeRoute({
    description:
      'Updates a wiki page. Omitted fields are left alone, an explicit `null` clears one — including `parent_id`, which moves the page back to the top level. `translations` is replaced wholesale rather than merged.',
    tags: ['Admin · Wiki'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated page', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or page' },
      409: { description: 'Another page in the product already uses that slug' },
      422: { description: 'The body failed validation, or the parent cannot hold this page' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const product = await requireProduct(db, c.req.param('productId'))
    const current = await requirePage(db, product, c.req.param('id'))

    const parentId =
      body.parent_id === undefined
        ? current.parentId
        : await resolveParentOrThrow(db, product.id, current, body.parent_id)

    const status = body.status ?? current.status
    const updated = {
      ...current,
      parentId,
      slug: body.slug ?? current.slug,
      title: body.title ?? current.title,
      icon: body.icon === undefined ? current.icon : body.icon,
      body: body.body === undefined ? current.body : body.body,
      status,
      position: body.position ?? current.position,
      translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
      publishedAt: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(productWikiPages)
        .set({
          parentId: updated.parentId,
          slug: updated.slug,
          title: updated.title,
          icon: updated.icon,
          body: updated.body,
          status: updated.status,
          position: updated.position,
          translations: updated.translations,
          publishedAt: updated.publishedAt,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(productWikiPages.id, current.id))
    } catch (error) {
      throw asConflict(error, `A wiki page with slug "${updated.slug}" already exists in this product`)
    }

    await recordAudit(db, {
      event: 'wiki.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_wiki_pages',
      resourceId: current.id,
      metadata: { product: product.slug, slug: updated.slug, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminWikiPage(updated) })
  },
)

app.delete(
  '/products/:productId/wiki/:id',
  describeRoute({
    description:
      'Deletes a wiki page. Pages nested under it are moved back to the top level rather than deleted with it — losing a section must never silently lose the documentation inside it.',
    tags: ['Admin · Wiki'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The page was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or page' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const editor = c.get('editor')
    const product = await requireProduct(db, c.req.param('productId'))
    const page = await requirePage(db, product, c.req.param('id'))

    // Promoted before the delete, not after: the column has no foreign key onto itself (a page is
    // reparented far more often than a product is deleted, and a cascade here would delete
    // the children instead), so an orphan would simply keep pointing at an id that is gone.
    await db
      .update(productWikiPages)
      .set({ parentId: null, updatedBy: editor.email, updatedAt: new Date() })
      .where(eq(productWikiPages.parentId, page.id))

    await db.delete(productWikiPages).where(eq(productWikiPages.id, page.id))
    await recordAudit(db, {
      event: 'wiki.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_wiki_pages',
      resourceId: page.id,
      metadata: { product: product.slug, slug: page.slug },
    })

    return c.body(null, 204)
  },
)

export default app
