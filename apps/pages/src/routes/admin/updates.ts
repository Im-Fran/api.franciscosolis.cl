import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { Database } from '@/db/client'
import { applicationUpdates } from '@/db/schema'
import type { AppEnv } from '@/env'
import { BODY_LIMITS, CONTENT_STATUS, PAGINATION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { linkListSchema, serializeLinks } from '@/lib/links'
import { serializeTranslations } from '@/lib/locales'
import { optionalBody, optionalDate, requiredText, updateTranslations } from '@/lib/validation'
import type { Application } from '@/services/applications'
import { findApplicationById } from '@/services/applications'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'
import { findUpdateById, listUpdates, toAdminUpdate } from '@/services/updates'

/**
 * Editorial API for the Updates tab, nested under the application it belongs to.
 *
 * Every route is scoped by `:applicationId` rather than reaching a release note by its id alone.
 * That is not decoration: it is what stops an id from one application being edited or deleted
 * through another's URL, and it makes a 404 mean the same thing whichever half of the pair is wrong.
 */
const app = new Hono<AppEnv>()

/** Reads the `:applicationId` path param, 404-ing when there is no such application. */
const requireApplication = async (db: Database, id: string): Promise<Application> => {
  const application = await findApplicationById(db, id)
  if (!application) {
    throw new HTTPException(404, { message: 'Application not found' })
  }
  return application
}

/** Reads the `:id` path param as a release note of `application`, 404-ing on a mismatch. */
const requireUpdate = async (db: Database, application: Application, id: string) => {
  const update = await findUpdateById(db, id)
  if (!update || update.applicationId !== application.id) {
    throw new HTTPException(404, { message: 'Release not found' })
  }
  return update
}

/**
 * A version label. Free text rather than semver: this Worker fronts a Minecraft plugin and a mobile
 * app equally well, and `2.6.4`, `v3`, `2026.1` and `1.0-beta` are all somebody's real version.
 * What it may not contain is a slash or whitespace — it is a path segment on the public route.
 */
const versionInput = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40), v.regex(/^[^\s/]+$/))

const updateSchema = v.looseObject({ id: v.string(), version: v.string(), title: v.string(), status: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(updateSchema) })
const itemResponseSchema = v.object({ code: v.literal(200), data: updateSchema })

app.get(
  '/applications/:applicationId/updates',
  describeRoute({
    description: 'Release notes of an application in every state, drafts included, newest release first.',
    tags: ['Admin · Updates'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Release notes', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application' },
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
    const application = await requireApplication(db, c.req.param('applicationId'))

    const rows = await listUpdates(db, { applicationId: application.id, status, limit, offset })
    return c.json({ code: 200, data: rows.map(toAdminUpdate) })
  },
)

const createSchema = v.object({
  version: versionInput,
  title: requiredText(200),
  body: optionalBody(BODY_LIMITS.update),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  /** The day the version shipped. Defaults to now on a release published straight away. */
  released_at: optionalDate,
  links: linkListSchema,
  translations: updateTranslations,
})

app.post(
  '/applications/:applicationId/updates',
  describeRoute({
    description:
      'Adds a release note. The version must be unique within the application, because that is how the public route addresses it. A release published without a `released_at` is dated now — a changelog entry with no date sorts below every dated one, which is never what was meant.',
    tags: ['Admin · Updates'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created release note', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application' },
      409: { description: 'That version already exists in the application' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()
    const application = await requireApplication(db, c.req.param('applicationId'))

    const status = body.status ?? 'draft'
    const row = {
      id: crypto.randomUUID(),
      applicationId: application.id,
      version: body.version,
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
      await db.insert(applicationUpdates).values(row)
    } catch (error) {
      throw asConflict(error, `Version "${body.version}" already exists in this application`)
    }

    await recordAudit(db, {
      event: 'update.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'application_updates',
      resourceId: row.id,
      metadata: { application: application.slug, version: row.version, status },
    })

    return c.json({ code: 201, data: toAdminUpdate(row) }, 201)
  },
)

app.get(
  '/applications/:applicationId/updates/:id',
  describeRoute({
    description: 'A single release note by id, in whatever state it is in.',
    tags: ['Admin · Updates'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The release note', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application or release' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const application = await requireApplication(db, c.req.param('applicationId'))
    const update = await requireUpdate(db, application, c.req.param('id'))
    return c.json({ code: 200, data: toAdminUpdate(update) })
  },
)

const patchSchema = v.object({
  version: v.optional(versionInput),
  title: v.optional(requiredText(200)),
  body: optionalBody(BODY_LIMITS.update),
  status: v.optional(v.picklist(CONTENT_STATUS)),
  released_at: optionalDate,
  /** Replaces the whole list; it is not merged. */
  links: linkListSchema,
  /** Replaces the whole translation map — send every locale you want to keep. */
  translations: updateTranslations,
})

app.patch(
  '/applications/:applicationId/updates/:id',
  describeRoute({
    description:
      'Updates a release note. Omitted fields are left alone, an explicit `null` clears one. `links` and `translations` are replaced wholesale rather than merged.',
    tags: ['Admin · Updates'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated release note', content: { 'application/json': { schema: resolver(itemResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application or release' },
      409: { description: 'Another release in the application already uses that version' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', patchSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const application = await requireApplication(db, c.req.param('applicationId'))
    const current = await requireUpdate(db, application, c.req.param('id'))

    const status = body.status ?? current.status
    const updated = {
      ...current,
      version: body.version ?? current.version,
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
        .update(applicationUpdates)
        .set({
          version: updated.version,
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
        .where(eq(applicationUpdates.id, current.id))
    } catch (error) {
      throw asConflict(error, `Version "${updated.version}" already exists in this application`)
    }

    await recordAudit(db, {
      event: 'update.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'application_updates',
      resourceId: current.id,
      metadata: { application: application.slug, version: updated.version, fields: Object.keys(body), status },
    })

    return c.json({ code: 200, data: toAdminUpdate(updated) })
  },
)

app.delete(
  '/applications/:applicationId/updates/:id',
  describeRoute({
    description: 'Deletes a release note for good. Setting `status` to `archived` hides it from the tab without losing the text.',
    tags: ['Admin · Updates'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The release note was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such application or release' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const application = await requireApplication(db, c.req.param('applicationId'))
    const update = await requireUpdate(db, application, c.req.param('id'))

    await db.delete(applicationUpdates).where(eq(applicationUpdates.id, update.id))
    await recordAudit(db, {
      event: 'update.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'application_updates',
      resourceId: update.id,
      metadata: { application: application.slug, version: update.version },
    })

    return c.body(null, 204)
  },
)

export default app
