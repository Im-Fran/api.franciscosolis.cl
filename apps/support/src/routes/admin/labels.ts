import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { labels } from '@/db/schema'
import type { AppEnv } from '@/env'
import { ADMIN_PERMISSION } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { parseTranslations, serializeTranslations } from '@/lib/locales'
import { slugify } from '@/lib/slug'
import { labelTranslations, optionalHexColor, optionalText, requiredText } from '@/lib/validation'
import { requirePermission } from '@/middleware/auth'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'

const app = new Hono<AppEnv>()

const labelSchema = v.looseObject({ id: v.string(), slug: v.string(), name: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(labelSchema) })
const oneResponseSchema = v.object({ code: v.literal(200), data: labelSchema })

const toLabelRow = (row: typeof labels.$inferSelect) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  color: row.color,
  position: row.position,
  translations: parseTranslations(row.translations),
  created_at: row.createdAt?.toISOString() ?? null,
  updated_at: row.updatedAt?.toISOString() ?? null,
})

app.get(
  '/labels',
  describeRoute({
    description: 'The label catalogue, in display order.',
    tags: ['Admin · Labels'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Labels', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the support console' },
    },
  }),
  async (c) => {
    const rows = await getDb(c.env).select().from(labels).orderBy(asc(labels.position), asc(labels.name))
    return c.json({ code: 200, data: rows.map(toLabelRow) })
  },
)

const createSchema = v.object({
  name: requiredText(60),
  slug: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60))),
  description: optionalText(300),
  color: optionalHexColor,
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  translations: labelTranslations,
})

app.post(
  '/labels',
  describeRoute({
    description: 'Creates a label. The slug is derived from the name when not given, and is what a ticket filter is written against.',
    tags: ['Admin · Labels'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Label created', content: { 'application/json': { schema: resolver(oneResponseSchema) } } },
      403: { description: 'Missing the support:admin permission' },
      409: { description: 'A label with that slug already exists' },
      400: { description: 'The body failed validation' },
    },
  }),
  requirePermission(ADMIN_PERMISSION),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const agent = c.get('agent')
    const slug = slugify(body.slug || body.name)

    const row = {
      id: crypto.randomUUID(),
      slug,
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? null,
      position: body.position ?? 0,
      translations: serializeTranslations(body.translations),
      createdBy: agent.email,
      updatedBy: agent.email,
    }

    try {
      await db.insert(labels).values(row)
    } catch (error) {
      throw asConflict(error, `A label with slug "${slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'label.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'labels',
      resourceId: row.id,
      metadata: { slug },
    })

    const [created] = await db.select().from(labels).where(eq(labels.id, row.id)).limit(1)
    return c.json({ code: 201, data: toLabelRow(created!) }, 201)
  },
)

const updateSchema = v.object({
  name: v.optional(requiredText(60)),
  description: optionalText(300),
  color: optionalHexColor,
  position: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(9999))),
  translations: labelTranslations,
})

app.patch(
  '/labels/:id',
  describeRoute({
    description:
      'Updates a label. The slug is deliberately immutable: it is what saved filters and the website\'s links are written against, and renaming it silently breaks both.',
    tags: ['Admin · Labels'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Label updated', content: { 'application/json': { schema: resolver(oneResponseSchema) } } },
      403: { description: 'Missing the support:admin permission' },
      404: { description: 'No such label' },
      400: { description: 'The body failed validation' },
    },
  }),
  requirePermission(ADMIN_PERMISSION),
  validator('json', updateSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const [current] = await db.select().from(labels).where(eq(labels.id, c.req.param('id'))).limit(1)
    if (!current) {
      throw new HTTPException(404, { message: 'Label not found' })
    }

    await db
      .update(labels)
      .set({
        name: body.name ?? current.name,
        description: body.description === undefined ? current.description : body.description,
        color: body.color === undefined ? current.color : body.color,
        position: body.position ?? current.position,
        translations: body.translations === undefined ? current.translations : serializeTranslations(body.translations),
        updatedBy: c.get('agent').email,
        updatedAt: new Date(),
      })
      .where(eq(labels.id, current.id))

    await recordAudit(db, {
      event: 'label.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'labels',
      resourceId: current.id,
      metadata: { slug: current.slug },
    })

    const [updated] = await db.select().from(labels).where(eq(labels.id, current.id)).limit(1)
    return c.json({ code: 200, data: toLabelRow(updated!) })
  },
)

app.delete(
  '/labels/:id',
  describeRoute({
    description: 'Deletes a label and removes it from every ticket carrying it.',
    tags: ['Admin · Labels'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Label deleted' },
      403: { description: 'Missing the support:admin permission' },
      404: { description: 'No such label' },
    },
  }),
  requirePermission(ADMIN_PERMISSION),
  async (c) => {
    const db = getDb(c.env)
    const [current] = await db.select().from(labels).where(eq(labels.id, c.req.param('id'))).limit(1)
    if (!current) {
      throw new HTTPException(404, { message: 'Label not found' })
    }

    // `ticket_labels` cascades, so the links go with it.
    await db.delete(labels).where(eq(labels.id, current.id))
    await recordAudit(db, {
      event: 'label.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'labels',
      resourceId: current.id,
      metadata: { slug: current.slug },
    })

    return c.body(null, 204)
  },
)

export default app
