import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { applications } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { linkListSchema, serializeLinks } from '@/lib/links'
import { serializeTranslations } from '@/lib/locales'
import { SLUG_PATTERN, slugify } from '@/lib/slug'
import { serializeTabs, TAB_KEYS } from '@/lib/tabs'
import {
  applicationTranslations,
  optionalBody,
  optionalHexColor,
  optionalText,
  optionalUrl,
  requiredText,
} from '@/lib/validation'
import { findApplicationById, listApplications, toAdminApplication } from '@/services/applications'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'

/**
 * Editorial API for the applications themselves. Every route here is behind `requireEditor`
 * (applied once in `routes/admin/index.ts`), and unlike the public routes it sees every state.
 */
const app = new Hono<AppEnv>()

const applicationSchema = v.looseObject({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  status: v.string(),
})

const listResponseSchema = v.object({ code: v.literal(200), data: v.array(applicationSchema) })
const applicationResponseSchema = v.object({ code: v.literal(200), data: applicationSchema })

const listQuerySchema = v.object({
  status: v.optional(v.picklist(CONTENT_STATUS)),
  search: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  limit: v.optional(
    v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(PAGINATION.maxLimit)),
  ),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/applications',
  describeRoute({
    description: 'Every application in every state, drafts included. `status` narrows the listing.',
    tags: ['Admin · Applications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Applications', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed to edit application pages' },
    },
  }),
  validator('query', listQuerySchema),
  async (c) => {
    const { status, search, limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')
    const rows = await listApplications(getDb(c.env), { status, search, limit, offset })
    return c.json({ code: 200, data: rows.map(toAdminApplication) })
  },
)

const reorderSchema = v.object({
  items: v.pipe(
    v.array(v.object({ id: v.string(), position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999)) })),
    v.minLength(1),
    v.maxLength(PAGINATION.maxLimit),
  ),
})

// Registered before `/applications/:id` so the literal segment is never swallowed by the parameter,
// whichever router Hono picks at runtime.
app.post(
  '/applications/reorder',
  describeRoute({
    description: 'Sets the manual `position` of several applications at once — what a drag-and-drop list sends after a reorder.',
    tags: ['Admin · Applications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The reordered applications' },
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
        .update(applications)
        .set({ position: item.position, updatedBy: editor.email, updatedAt: now })
        .where(eq(applications.id, item.id))
    }

    await recordAudit(db, {
      event: 'application.reordered',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'applications',
      metadata: { count: items.length },
    })

    const rows = await listApplications(db, { limit: PAGINATION.maxLimit, offset: 0 })
    return c.json({ code: 200, data: rows.map(toAdminApplication) })
  },
)

/** The tabs an editor may turn on. `overview` is added back by `serializeTabs` whatever is sent. */
const tabList = v.optional(v.array(v.picklist(TAB_KEYS)))

const createSchema = v.object({
  /** Derived from the name when omitted. This is what `/application/<slug>` resolves. */
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
  translations: applicationTranslations,
})

app.post(
  '/applications',
  describeRoute({
    description:
      'Creates an application page. The slug defaults to a slugified name and must be unique across the service, because it is a path segment on the website. `tabs` always comes back with `overview` first — a page with no overview is a banner and a row of links.',
    tags: ['Admin · Applications'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created application', content: { 'application/json': { schema: resolver(applicationResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      409: { description: 'An application with that slug already exists' },
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
      translations: serializeTranslations(body.translations),
      publishedAt: status === 'published' ? now : null,
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await db.insert(applications).values(row)
    } catch (error) {
      throw asConflict(error, `An application with slug "${slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'application.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'applications',
      resourceId: row.id,
      metadata: { slug, status },
    })

    return c.json({ code: 201, data: toAdminApplication(row) }, 201)
  },
)

app.get(
  '/applications/:id',
  describeRoute({
    description: 'A single application by id, in whatever state it is in, with its raw translation map.',
    tags: ['Admin · Applications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The application', content: { 'application/json': { schema: resolver(applicationResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application' },
    },
  }),
  async (c) => {
    const application = await findApplicationById(getDb(c.env), c.req.param('id'))
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }
    return c.json({ code: 200, data: toAdminApplication(application) })
  },
)

const updateSchema = v.object({
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
  /** Replaces the whole translation map — send every locale you want to keep. */
  translations: applicationTranslations,
})

app.patch(
  '/applications/:id',
  describeRoute({
    description:
      'Updates an application. Omitted fields are left alone, an explicit `null` clears one. `tabs`, `links` and `translations` are replaced wholesale rather than merged, so send the complete value.',
    tags: ['Admin · Applications'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated application', content: { 'application/json': { schema: resolver(applicationResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application' },
      409: { description: 'Another application already uses that slug' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', updateSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const current = await findApplicationById(db, c.req.param('id'))
    if (!current) {
      throw new HTTPException(404, { message: 'Application not found' })
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
      translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
      // Stamped the first time a page goes live and kept from then on, so unpublishing and
      // republishing does not rewrite the date the application was originally announced.
      publishedAt: status === 'published' ? (current.publishedAt ?? now) : current.publishedAt,
      updatedBy: editor.email,
      updatedAt: now,
    }

    try {
      await db
        .update(applications)
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
          translations: updated.translations,
          publishedAt: updated.publishedAt,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(applications.id, current.id))
    } catch (error) {
      throw asConflict(error, `An application with slug "${updated.slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'application.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'applications',
      resourceId: current.id,
      metadata: { slug: updated.slug, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminApplication(updated) })
  },
)

app.delete(
  '/applications/:id',
  describeRoute({
    description:
      'Deletes an application and, with it, every release note and wiki page it holds — that is what the foreign keys cascade. Prefer setting `status` to `archived` when the page might come back: it disappears from the website without losing the text.',
    tags: ['Admin · Applications'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The application was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const application = await findApplicationById(db, c.req.param('id'))
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    await db.delete(applications).where(eq(applications.id, application.id))
    await recordAudit(db, {
      event: 'application.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'applications',
      resourceId: application.id,
      metadata: { slug: application.slug },
    })

    return c.body(null, 204)
  },
)

export default app
