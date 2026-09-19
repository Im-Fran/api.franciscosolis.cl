import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { productReleaseCompatibility } from '@/db/schema'
import type { AppEnv } from '@/env'
import {
  compatibilityPatchSchema,
  compatibilitySchema,
  MAX_COMPATIBILITY_ENTRIES,
  toPublicCompatibility,
} from '@/lib/compatibility'
import { PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { countCompatibility, findCompatibilityEntry, listCompatibility } from '@/services/compatibility'
import type { Product } from '@/services/products'
import { findProductById } from '@/services/products'
import { findReleaseById } from '@/services/releases'

/**
 * Editorial API for what a release runs on.
 *
 * Nested under the product *and* the release, like every other editorial route here: an entry from
 * one release must not be reachable through another's URL, and a 404 has to mean the same thing
 * whichever part of the triple is wrong.
 *
 * Why this is a table with routes of its own rather than a JSON field on the release, the way
 * `links` is: the requirements are the thing a visitor filters on. "Which releases still support
 * Java 17" is the question the typing exists to answer, and it is not a question a blob can be
 * asked. See `src/lib/compatibility.ts`.
 */
const app = new Hono<AppEnv>()

const requireProduct = async (db: Database, id: string): Promise<Product> => {
  const product = await findProductById(db, id)
  if (!product) {
    throw new HTTPException(404, { message: 'Product not found' })
  }
  return product
}

const requireRelease = async (db: Database, product: Product, id: string) => {
  const release = await findReleaseById(db, id)
  if (!release || release.productId !== product.id) {
    throw new HTTPException(404, { message: 'Release not found' })
  }
  return release
}

const entrySchema = v.looseObject({ id: v.string(), kind: v.string(), name: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(entrySchema) })
const itemResponseSchema = v.object({ code: v.literal(200), data: entrySchema })

const BASE = '/products/:productId/releases/:releaseId/compatibility'

app.get(
  BASE,
  describeRoute({
    description: 'What this release runs on, in the order an editor put them in.',
    tags: ['Admin · Compatibility'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The requirements', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    const rows = await listCompatibility(db, release.id)
    return c.json({ code: 200, data: rows.map(toPublicCompatibility) })
  },
)

const reorderSchema = v.object({
  items: v.pipe(
    v.array(v.object({ id: v.string(), position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999)) })),
    v.minLength(1),
    v.maxLength(PAGINATION.maxLimit),
  ),
})

// Registered before `${BASE}/:id` so the literal segment is never swallowed by the parameter.
app.post(
  `${BASE}/reorder`,
  describeRoute({
    description:
      'Sets the manual `position` of several requirements at once. Ids that do not belong to the release are ignored, so a reorder cannot reach into another release\'s list.',
    tags: ['Admin · Compatibility'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reordered requirements' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
    },
  }),
  validator('json', reorderSchema),
  async (c) => {
    const { items } = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    for (const item of items) {
      await db
        .update(productReleaseCompatibility)
        .set({ position: item.position, updatedBy: editor.email, updatedAt: now })
        .where(
          and(
            eq(productReleaseCompatibility.id, item.id),
            eq(productReleaseCompatibility.releaseId, release.id),
          ),
        )
    }

    await recordAudit(db, {
      event: 'compatibility.reordered',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_compatibility',
      resourceId: release.id,
      metadata: { product: product.slug, version: release.version, count: items.length },
    })

    const rows = await listCompatibility(db, release.id)
    return c.json({ code: 200, data: rows.map(toPublicCompatibility) })
  },
)

app.post(
  BASE,
  describeRoute({
    description:
      'Adds one requirement to a release. `constraint` is free text on purpose — `>= 14.0`, `17+` and `1.20–1.21` are all somebody\'s real requirement, and nothing here parses it. The pair `(kind, name)` is unique within the release: two answers to "which Java" is not a requirement, it is a question.',
    tags: ['Admin · Compatibility'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The requirement', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product or release' },
      409: { description: 'That kind and name are already on this release' },
      422: { description: 'The body failed validation, or the release is already full' },
    },
  }),
  validator('json', compatibilitySchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    if ((await countCompatibility(db, release.id)) >= MAX_COMPATIBILITY_ENTRIES) {
      throw new HTTPException(422, {
        message: `A release carries at most ${MAX_COMPATIBILITY_ENTRIES} requirements`,
      })
    }

    const row = {
      id: crypto.randomUUID(),
      productId: product.id,
      releaseId: release.id,
      kind: body.kind,
      name: body.name,
      // The API field is `constraint`; the column is `constraint_text`, because `CONSTRAINT` is a
      // SQLite reserved word. This mapping and `toPublicCompatibility` are the only two places that
      // know that, and they are next to each other on purpose.
      constraintText: body.constraint ?? null,
      optional: body.optional ?? false,
      position: body.position ?? 0,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(productReleaseCompatibility).values(row)
    } catch (error) {
      throw asConflict(error, `"${body.name}" is already listed on this release`)
    }

    await recordAudit(db, {
      event: 'compatibility.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_compatibility',
      resourceId: row.id,
      metadata: { product: product.slug, version: release.version, kind: row.kind, name: row.name },
    })

    return c.json({ code: 201, data: toPublicCompatibility(row) }, 201)
  },
)

app.patch(
  `${BASE}/:id`,
  describeRoute({
    description: 'Updates one requirement. Omitted fields are left alone, an explicit `null` clears the constraint.',
    tags: ['Admin · Compatibility'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The requirement', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, release or requirement' },
      409: { description: 'Another requirement on this release already uses that kind and name' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', compatibilityPatchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    const current = await findCompatibilityEntry(db, release.id, c.req.param('id'))
    if (!current) {
      throw new HTTPException(404, { message: 'Requirement not found' })
    }

    const updated = {
      ...current,
      kind: body.kind ?? current.kind,
      name: body.name ?? current.name,
      constraintText: body.constraint === undefined ? current.constraintText : body.constraint,
      optional: body.optional ?? current.optional,
      position: body.position ?? current.position,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(productReleaseCompatibility)
        .set({
          kind: updated.kind,
          name: updated.name,
          constraintText: updated.constraintText,
          optional: updated.optional,
          position: updated.position,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(productReleaseCompatibility.id, current.id))
    } catch (error) {
      throw asConflict(error, `"${updated.name}" is already listed on this release`)
    }

    await recordAudit(db, {
      event: 'compatibility.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_compatibility',
      resourceId: current.id,
      metadata: { product: product.slug, version: release.version, fields: Object.keys(body) },
    })

    return c.json({ code: 200, data: toPublicCompatibility(updated) })
  },
)

app.delete(
  `${BASE}/:id`,
  describeRoute({
    description: 'Removes one requirement from a release.',
    tags: ['Admin · Compatibility'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The requirement was removed' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such product, release or requirement' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const product = await requireProduct(db, c.req.param('productId'))
    const release = await requireRelease(db, product, c.req.param('releaseId'))

    const current = await findCompatibilityEntry(db, release.id, c.req.param('id'))
    if (!current) {
      throw new HTTPException(404, { message: 'Requirement not found' })
    }

    await db.delete(productReleaseCompatibility).where(eq(productReleaseCompatibility.id, current.id))

    await recordAudit(db, {
      event: 'compatibility.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'product_release_compatibility',
      resourceId: current.id,
      metadata: { product: product.slug, version: release.version, kind: current.kind, name: current.name },
    })

    return c.body(null, 204)
  },
)

export default app
