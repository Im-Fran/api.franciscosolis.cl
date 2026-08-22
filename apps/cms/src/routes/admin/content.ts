import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { contentEntries } from '@/db/schema'
import type { AppEnv } from '@/env'
import type { CollectionName } from '@/lib/collections'
import { isCollection, parseCollectionData } from '@/lib/collections'
import { CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { serializeTranslations } from '@/lib/locales'
import { SLUG_PATTERN, slugify } from '@/lib/slug'
import { contentTranslations, optionalDate, optionalText, optionalUrl, requiredText, tagList } from '@/lib/validation'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findEntryById, listEntries, toAdminEntry } from '@/services/content'

/**
 * Editorial API for landing-page content. Every route here is behind `requireEditor` (applied once
 * in `routes/admin/index.ts`), and unlike the public routes it sees entries in every state.
 */
const app = new Hono<AppEnv>()

/** Reads the `:collection` path param, 404-ing on anything not in the registry. */
const requireCollection = (value: string): CollectionName => {
  if (!isCollection(value)) {
    throw new HTTPException(404, { message: `Unknown collection: ${value}` })
  }
  return value
}

/** Runs the collection's own schema over `data`, turning a valibot failure into a 422. */
const parseCollectionDataOrThrow = (collection: CollectionName, data: unknown) => {
  try {
    return parseCollectionData(collection, data)
  } catch (error) {
    const issues = error instanceof v.ValiError ? v.flatten(error.issues) : null
    throw new HTTPException(422, {
      message: `Invalid data for collection ${collection}: ${JSON.stringify(issues?.nested ?? issues?.root ?? 'unknown issue')}`,
    })
  }
}

const listQuerySchema = v.object({
  status: v.optional(v.picklist(CONTENT_STATUS)),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  tag: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60))),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const entrySchema = v.looseObject({
  id: v.string(),
  collection: v.string(),
  slug: v.string(),
  title: v.string(),
  status: v.string(),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(entrySchema) })
const entryResponseSchema = v.object({ code: v.literal(200), data: entrySchema })

app.get(
  '/content/:collection',
  describeRoute({
    description:
      'Entries of a collection in every state, drafts included. `status` narrows the listing; leave it out to see everything.',
    tags: ['Admin · Content'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Entries', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the CMS' },
      404: { description: 'No such collection' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const collection = requireCollection(c.req.param('collection'))
    const { status, search, tag, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')

    const entries = await listEntries(getDb(c.env), { collection, status, search, tag, limit, offset })
    return c.json({ code: 200, data: entries.map(toAdminEntry) })
  },
)

const reorderSchema = v.object({
  items: v.pipe(
    v.array(v.object({ id: v.string(), position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999)) })),
    v.minLength(1),
    v.maxLength(PAGINATION.maxLimit),
  ),
})

// Registered before `/content/:collection/:id` so the literal segment is never swallowed by the
// parameter, whichever router Hono picks at runtime.
app.post(
  '/content/:collection/reorder',
  describeRoute({
    description:
      'Sets the manual `position` of several entries at once — what a drag-and-drop list in a CMS front-end sends after a reorder. Ids that do not belong to the collection are ignored.',
    tags: ['Admin · Content'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reordered entries' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such collection' },
    },
  }),
  validator('json', reorderSchema),
  async (c) => {
    const collection = requireCollection(c.req.param('collection'))
    const { items } = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    // Scoped by collection as well as id: a reorder must not be able to reach into another
    // collection just by sending a foreign id.
    for (const item of items) {
      await db
        .update(contentEntries)
        .set({ position: item.position, updatedBy: editor.email, updatedAt: now })
        .where(and(eq(contentEntries.id, item.id), eq(contentEntries.collection, collection)))
    }

    await recordAudit(db, {
      event: 'content.reordered',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'content_entries',
      metadata: { collection, count: items.length },
    })

    const entries = await listEntries(db, { collection, limit: PAGINATION.maxLimit, offset: 0 })
    return c.json({ code: 200, data: entries.map(toAdminEntry) })
  },
)

const createSchema = v.object({
  /** Derived from the title when omitted. */
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  title: requiredText(200),
  subtitle: optionalText(200),
  summary: optionalText(600),
  body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(100_000)))),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  featured: v.optional(v.boolean()),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  started_at: optionalDate,
  ended_at: optionalDate,
  url: optionalUrl,
  image_url: optionalUrl,
  tags: tagList,
  /** Collection-specific fields, validated against the collection's own schema. */
  data: v.optional(v.record(v.string(), v.unknown())),
  /** Per-locale overrides of the prose fields; the columns above hold the default locale. */
  translations: contentTranslations,
})

app.post(
  '/content/:collection',
  describeRoute({
    description:
      'Creates an entry. The slug defaults to a slugified title and must be unique within the collection. `data` is validated against the collection schema, so an unknown field is rejected rather than silently stored. `translations` carries the other locales; the entry\'s own columns are the default one.',
    tags: ['Admin · Content'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created entry', content: { 'application/json': { schema: resolver(entryResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such collection' },
      409: { description: 'An entry with that slug already exists in the collection' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const collection = requireCollection(c.req.param('collection'))
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const slug = body.slug ?? slugify(body.title)
    if (!slug) {
      throw new HTTPException(422, { message: 'Could not derive a slug from the title; send one explicitly' })
    }

    const data = parseCollectionDataOrThrow(collection, body.data)
    const status = body.status ?? 'draft'

    const entry = {
      id: crypto.randomUUID(),
      collection,
      slug,
      title: body.title,
      subtitle: body.subtitle ?? null,
      summary: body.summary ?? null,
      body: body.body ?? null,
      status,
      featured: body.featured ?? false,
      position: body.position ?? 0,
      startedAt: body.started_at ?? null,
      endedAt: body.ended_at ?? null,
      url: body.url ?? null,
      imageUrl: body.image_url ?? null,
      tags: JSON.stringify(body.tags ?? []),
      data: JSON.stringify(data),
      translations: serializeTranslations(body.translations),
      publishedAt: status === 'published' ? now : null,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(contentEntries).values(entry)
    } catch (error) {
      throw asConflict(error, `An entry with slug "${slug}" already exists in ${collection}`)
    }

    await recordAudit(db, {
      event: 'content.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'content_entries',
      resourceId: entry.id,
      metadata: { collection, slug, status },
    })

    return c.json({ code: 201, data: toAdminEntry(entry) }, 201)
  },
)

app.get(
  '/content/:collection/:id',
  describeRoute({
    description: 'A single entry by id, in whatever state it is in.',
    tags: ['Admin · Content'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The entry', content: { 'application/json': { schema: resolver(entryResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such collection or entry' },
    },
  }),
  async (c) => {
    const collection = requireCollection(c.req.param('collection'))
    const entry = await findEntryById(getDb(c.env), c.req.param('id'))
    if (!entry || entry.collection !== collection) {
      throw new HTTPException(404, { message: 'Entry not found' })
    }

    return c.json({ code: 200, data: toAdminEntry(entry) })
  },
)

const updateSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  title: v.optional(requiredText(200)),
  subtitle: optionalText(200),
  summary: optionalText(600),
  body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(100_000)))),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  featured: v.optional(v.boolean()),
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  started_at: optionalDate,
  ended_at: optionalDate,
  url: optionalUrl,
  image_url: optionalUrl,
  tags: tagList,
  /** Replaces the whole blob; it is not merged field by field. */
  data: v.optional(v.record(v.string(), v.unknown())),
  /** Replaces the whole translation map, `data`-style — send every locale you want to keep. */
  translations: contentTranslations,
})

app.patch(
  '/content/:collection/:id',
  describeRoute({
    description:
      'Updates an entry. Omitted fields are left alone, an explicit `null` clears one. `data` and `translations` are replaced wholesale rather than merged, so send the complete object.',
    tags: ['Admin · Content'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated entry', content: { 'application/json': { schema: resolver(entryResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such collection or entry' },
      409: { description: 'Another entry in the collection already uses that slug' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', updateSchema),
  async (c) => {
    const collection = requireCollection(c.req.param('collection'))
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const current = await findEntryById(db, c.req.param('id'))
    if (!current || current.collection !== collection) {
      throw new HTTPException(404, { message: 'Entry not found' })
    }

    const status = body.status ?? current.status
    const updated = {
      ...current,
      slug: body.slug ?? current.slug,
      title: body.title ?? current.title,
      subtitle: body.subtitle === undefined ? current.subtitle : body.subtitle,
      summary: body.summary === undefined ? current.summary : body.summary,
      body: body.body === undefined ? current.body : body.body,
      status,
      featured: body.featured ?? current.featured,
      position: body.position ?? current.position,
      startedAt: body.started_at === undefined ? current.startedAt : body.started_at,
      endedAt: body.ended_at === undefined ? current.endedAt : body.ended_at,
      url: body.url === undefined ? current.url : body.url,
      imageUrl: body.image_url === undefined ? current.imageUrl : body.image_url,
      tags: body.tags === undefined ? current.tags : JSON.stringify(body.tags),
      data: body.data === undefined ? current.data : JSON.stringify(parseCollectionDataOrThrow(collection, body.data)),
      translations:
        body.translations === undefined ? current.translations : serializeTranslations(body.translations),
      // Stamped the first time an entry goes live and kept from then on, so unpublishing and
      // republishing does not rewrite the date the thing was originally announced.
      publishedAt: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(contentEntries)
        .set({
          slug: updated.slug,
          title: updated.title,
          subtitle: updated.subtitle,
          summary: updated.summary,
          body: updated.body,
          status: updated.status,
          featured: updated.featured,
          position: updated.position,
          startedAt: updated.startedAt,
          endedAt: updated.endedAt,
          url: updated.url,
          imageUrl: updated.imageUrl,
          tags: updated.tags,
          data: updated.data,
          translations: updated.translations,
          publishedAt: updated.publishedAt,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(contentEntries.id, current.id))
    } catch (error) {
      throw asConflict(error, `An entry with slug "${updated.slug}" already exists in ${collection}`)
    }

    await recordAudit(db, {
      event: 'content.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'content_entries',
      resourceId: current.id,
      metadata: { collection, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminEntry(updated) })
  },
)

app.delete(
  '/content/:collection/:id',
  describeRoute({
    description:
      'Deletes an entry for good. Prefer setting `status` to `archived` when the entry might come back — that hides it from the website without losing the text.',
    tags: ['Admin · Content'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The entry was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such collection or entry' },
    },
  }),
  async (c) => {
    const collection = requireCollection(c.req.param('collection'))
    const db = getDb(c.env)

    const entry = await findEntryById(db, c.req.param('id'))
    if (!entry || entry.collection !== collection) {
      throw new HTTPException(404, { message: 'Entry not found' })
    }

    await db.delete(contentEntries).where(eq(contentEntries.id, entry.id))
    await recordAudit(db, {
      event: 'content.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'content_entries',
      resourceId: entry.id,
      metadata: { collection, slug: entry.slug },
    })

    return c.body(null, 204)
  },
)

export default app
