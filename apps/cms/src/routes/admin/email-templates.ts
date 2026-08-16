import { asc, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { emailTemplates } from '@/db/schema'
import type { AppEnv } from '@/env'
import { EMAIL_LIMITS } from '@/lib/config'
import { asConflict } from '@/lib/errors'
import { SLUG_PATTERN, slugify } from '@/lib/slug'
import { extractVariables } from '@/lib/template'
import { optionalText, requiredText } from '@/lib/validation'
import { getActorContext, getRequestContext, recordAudit } from '@/services/audit'

/**
 * Reusable email bodies. A template is just text with `{{ placeholders }}`; the list of variables
 * it needs is derived from that text on every write rather than declared by hand, so the two can
 * never disagree.
 */
const app = new Hono<AppEnv>()

type TemplateRow = typeof emailTemplates.$inferSelect

const toPublicTemplate = (template: TemplateRow) => ({
  id: template.id,
  slug: template.slug,
  name: template.name,
  description: template.description,
  subject: template.subject,
  html: template.html,
  text: template.text,
  variables: JSON.parse(template.variables) as string[],
  created_by: template.createdBy,
  updated_by: template.updatedBy,
  created_at: template.createdAt.toISOString(),
  updated_at: template.updatedAt.toISOString(),
})

/** Every placeholder used anywhere in the template, which is what a send has to provide values for. */
const collectVariables = (template: { subject: string; html: string | null; text: string | null }) => [
  ...new Set([
    ...extractVariables(template.subject),
    ...extractVariables(template.html ?? ''),
    ...extractVariables(template.text ?? ''),
  ]),
]

const templateSchema = v.looseObject({ id: v.string(), slug: v.string(), subject: v.string() })
const listResponseSchema = v.object({ code: v.literal(200), data: v.array(templateSchema) })
const templateResponseSchema = v.object({ code: v.literal(200), data: templateSchema })

app.get(
  '/email-templates',
  describeRoute({
    description: 'Every email template, with the variables each one expects.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Templates', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the CMS' },
    },
  }),
  async (c) => {
    const rows = await getDb(c.env).select().from(emailTemplates).orderBy(asc(emailTemplates.name))
    return c.json({ code: 200, data: rows.map(toPublicTemplate) })
  },
)

const bodySchema = v.pipe(v.string(), v.maxLength(EMAIL_LIMITS.maxBodyLength))

const createSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  name: requiredText(120),
  description: optionalText(400),
  subject: requiredText(EMAIL_LIMITS.maxSubjectLength),
  html: v.optional(v.nullable(bodySchema)),
  text: v.optional(v.nullable(bodySchema)),
})

app.post(
  '/email-templates',
  describeRoute({
    description:
      'Creates a template. At least one of `html` or `text` must be present — a template with neither could only ever send an empty message.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The created template', content: { 'application/json': { schema: resolver(templateResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      409: { description: 'A template with that slug already exists' },
      422: { description: 'The body failed validation' },
    },
  }),
  validator('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    if (!body.html && !body.text) {
      throw new HTTPException(422, { message: 'A template needs at least one of `html` or `text`' })
    }

    const db = getDb(c.env)
    const editor = c.get('editor')
    const now = new Date()

    const slug = body.slug ?? slugify(body.name)
    if (!slug) {
      throw new HTTPException(422, { message: 'Could not derive a slug from the name; send one explicitly' })
    }

    const template = {
      id: crypto.randomUUID(),
      slug,
      name: body.name,
      description: body.description ?? null,
      subject: body.subject,
      html: body.html ?? null,
      text: body.text ?? null,
      variables: '[]',
      createdBy: editor.email,
      updatedBy: editor.email,
      createdAt: now,
      updatedAt: now,
    }
    template.variables = JSON.stringify(collectVariables(template))

    try {
      await db.insert(emailTemplates).values(template)
    } catch (error) {
      throw asConflict(error, `A template with slug "${slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'email_template.created',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'email_templates',
      resourceId: template.id,
      metadata: { slug },
    })

    return c.json({ code: 201, data: toPublicTemplate(template) }, 201)
  },
)

const findTemplate = async (c: Context<AppEnv>, id: string) => {
  const [template] = await getDb(c.env).select().from(emailTemplates).where(eq(emailTemplates.id, id)).limit(1)
  if (!template) {
    throw new HTTPException(404, { message: 'Template not found' })
  }
  return template
}

app.get(
  '/email-templates/:id',
  describeRoute({
    description: 'A single email template by id.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The template', content: { 'application/json': { schema: resolver(templateResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such template' },
    },
  }),
  async (c) => c.json({ code: 200, data: toPublicTemplate(await findTemplate(c, c.req.param('id'))) }),
)

const updateSchema = v.object({
  slug: v.optional(v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_PATTERN))),
  name: v.optional(requiredText(120)),
  description: optionalText(400),
  subject: v.optional(requiredText(EMAIL_LIMITS.maxSubjectLength)),
  html: v.optional(v.nullable(bodySchema)),
  text: v.optional(v.nullable(bodySchema)),
})

app.patch(
  '/email-templates/:id',
  describeRoute({
    description: 'Updates a template. The variable list is recomputed from the new text.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated template', content: { 'application/json': { schema: resolver(templateResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such template' },
      409: { description: 'Another template already uses that slug' },
      422: { description: 'The update would leave the template with no body' },
    },
  }),
  validator('json', updateSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const editor = c.get('editor')
    const current = await findTemplate(c, c.req.param('id'))

    const updated = {
      ...current,
      slug: body.slug ?? current.slug,
      name: body.name ?? current.name,
      description: body.description === undefined ? current.description : body.description,
      subject: body.subject ?? current.subject,
      html: body.html === undefined ? current.html : body.html,
      text: body.text === undefined ? current.text : body.text,
      updatedBy: editor.email,
      updatedAt: new Date(),
    }
    if (!updated.html && !updated.text) {
      throw new HTTPException(422, { message: 'A template needs at least one of `html` or `text`' })
    }
    updated.variables = JSON.stringify(collectVariables(updated))

    try {
      await db
        .update(emailTemplates)
        .set({
          slug: updated.slug,
          name: updated.name,
          description: updated.description,
          subject: updated.subject,
          html: updated.html,
          text: updated.text,
          variables: updated.variables,
          updatedBy: updated.updatedBy,
          updatedAt: updated.updatedAt,
        })
        .where(eq(emailTemplates.id, current.id))
    } catch (error) {
      throw asConflict(error, `A template with slug "${updated.slug}" already exists`)
    }

    await recordAudit(db, {
      event: 'email_template.updated',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'email_templates',
      resourceId: current.id,
      metadata: { slug: updated.slug, fields: Object.keys(body) },
    })

    return c.json({ code: 200, data: toPublicTemplate(updated) })
  },
)

app.delete(
  '/email-templates/:id',
  describeRoute({
    description:
      'Deletes a template. Messages already sent from it keep their rendered copy in the log, so deleting one loses nothing but the ability to send it again.',
    tags: ['Admin · Email'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The template was deleted' },
      401: { description: 'Missing or invalid access token' },
      404: { description: 'No such template' },
    },
  }),
  async (c) => {
    const db = getDb(c.env)
    const template = await findTemplate(c, c.req.param('id'))

    await db.delete(emailTemplates).where(eq(emailTemplates.id, template.id))
    await recordAudit(db, {
      event: 'email_template.deleted',
      ...getActorContext(c),
      ...getRequestContext(c),
      resourceType: 'email_templates',
      resourceId: template.id,
      metadata: { slug: template.slug },
    })

    return c.body(null, 204)
  },
)

export default app
