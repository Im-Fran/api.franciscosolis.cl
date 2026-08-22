import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { legalPages } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CONTENT_STATUS } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { serializeTranslations } from '@/lib/locales'
import { SLUG_PATTERN, slugify } from '@/lib/slug'
import { legalTranslations, optionalDate, optionalText, requiredText } from '@/lib/validation'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findPageById, toAdminPage } from '@/services/legal'

/** Editorial API for the landing site's legal pages. Behind `requireEditor`, like every admin route. */
const app = new Hono<AppEnv>()

const pageSchema = v.looseObject({
  id: v.string(),
  slug: v.string(),
  title: v.string(),
  status: v.string(),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(pageSchema) })
const pageResponseSchema = v.object({ code: v.literal(200), data: pageSchema })

app.get(
  '/legal',
  describeRoute({
    description: 'Every legal page, drafts included, with their bodies.',
    tags: ['Admin · Legal'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Legal pages', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the CMS' },
    },
  }),
  async (c) => {
    const pages = await getDb(c.env).select().from(legalPages).orderBy(asc(legalPages.title))
    return c.json({ code: 200, data: pages.map(toAdminPage) })
  },
)

const createSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  title: requiredText(200),
  summary: optionalText(600),
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(200_000)),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  version: optionalText(40),
  effective_at: optionalDate,
  /** Per-locale overrides of `title`, `summary` and `body`; the columns above are the default one. */
  translations: legalTranslations,
})

app.post(
  '/legal',
  describeRoute({
    description:
      'Creates a legal page. The slug defaults to a slugified title and is what the website addresses the page by, so it is worth choosing explicitly (`privacy`, `terms`, `cookies`).',
    tags: ['Admin · Legal'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created page', content: { 'application/json': { schema: resolver(pageResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      409: { description: 'A page with that slug already exists' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const slug = body.slug ?? slugify(body.title)
    if (!slug) {
      throw new HTTPException(422, { message: 'Could not derive a slug from the title; send one explicitly' })
    }

    const status = body.status ?? 'draft'
    const page = {
      id: crypto.randomUUID(),
      slug,
      title: body.title,
      summary: body.summary ?? null,
      body: body.body,
      status,
      version: body.version ?? null,
      effectiveAt: body.effective_at ?? null,
      translations: serializeTranslations(body.translations),
      publishedAt: status === 'published' ? now : null,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(legalPages).values(page)
    } catch (error) {
      throw asConflict(error, `A legal page with slug "${slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'legal.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'legal_pages',
      resourceId: page.id,
      metadata: { slug, status },
    })

    return c.json({ code: 201, data: toAdminPage(page) }, 201)
  },
)

app.get(
  '/legal/:id',
  describeRoute({
    description: 'A single legal page by id, in whatever state it is in.',
    tags: ['Admin · Legal'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The page', content: { 'application/json': { schema: resolver(pageResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such page' },
    },
  }),
  async (c) => {
    const page = await findPageById(getDb(c.env), c.req.param('id'))
    if (!page) {
      throw new HTTPException(404, { message: 'Legal page not found' })
    }
    return c.json({ code: 200, data: toAdminPage(page) })
  },
)

const updateSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  title: v.optional(requiredText(200)),
  summary: optionalText(600),
  body: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200_000))),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  version: optionalText(40),
  effective_at: optionalDate,
  /** Replaces the whole translation map — send every locale you want to keep. */
  translations: legalTranslations,
})

app.patch(
  '/legal/:id',
  describeRoute({
    description:
      'Updates a legal page. Omitted fields are left alone, an explicit `null` clears one, and `translations` is replaced wholesale. Bumping `version` and `effective_at` alongside the body is what keeps a published policy honest about when it changed.',
    tags: ['Admin · Legal'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated page', content: { 'application/json': { schema: resolver(pageResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such page' },
      409: { description: 'Another page already uses that slug' },
    },
  }),
  validator('json', updateSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const current = await findPageById(db, c.req.param('id'))
    if (!current) {
      throw new HTTPException(404, { message: 'Legal page not found' })
    }

    const status = body.status ?? current.status
    const updated = {
      ...current,
      slug: body.slug ?? current.slug,
      title: body.title ?? current.title,
      summary: body.summary === undefined ? current.summary : body.summary,
      body: body.body ?? current.body,
      status,
      version: body.version === undefined ? current.version : body.version,
      effectiveAt: body.effective_at === undefined ? current.effectiveAt : body.effective_at,
      translations:
        body.translations === undefined ? current.translations : serializeTranslations(body.translations),
      // First publication is what `published_at` records; later edits move `updated_at` instead.
      publishedAt: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(legalPages)
        .set({
          slug: updated.slug,
          title: updated.title,
          summary: updated.summary,
          body: updated.body,
          status: updated.status,
          version: updated.version,
          effectiveAt: updated.effectiveAt,
          translations: updated.translations,
          publishedAt: updated.publishedAt,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(legalPages.id, current.id))
    } catch (error) {
      throw asConflict(error, `A legal page with slug "${updated.slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'legal.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'legal_pages',
      resourceId: current.id,
      metadata: { slug: updated.slug, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminPage(updated) })
  },
)

app.delete(
  '/legal/:id',
  describeRoute({
    description:
      'Deletes a legal page. A policy that was ever published is usually worth keeping as `archived` instead — someone may need to know what the terms said last year.',
    tags: ['Admin · Legal'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The page was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such page' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const page = await findPageById(db, c.req.param('id'))
    if (!page) {
      throw new HTTPException(404, { message: 'Legal page not found' })
    }

    await db.delete(legalPages).where(eq(legalPages.id, page.id))
    await recordAudit(db, {
      event: 'legal.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'legal_pages',
      resourceId: page.id,
      metadata: { slug: page.slug },
    })

    return c.body(null, 204)
  },
)

export default app
