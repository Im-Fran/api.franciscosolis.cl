import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { applications } from '@/db/schema'
import type { AppEnv } from '@/env'
import { randomToken, sha256 } from '@/lib/crypto'
import { requirePermission } from '@/middleware/auth'
import { getRedirectUris } from '@/services/applications'
import type { Application } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'

const app = new Hono<AppEnv>()

/** Never exposes `client_secret_hash`; `confidential` is all a caller needs to know about it. */
const toPublicApplication = (application: Application) => ({
  client_id: application.id,
  name: application.name,
  description: application.description,
  confidential: application.clientSecretHash !== null,
  redirect_uris: getRedirectUris(application),
  is_active: application.isActive,
  created_at: application.createdAt.toISOString(),
  updated_at: application.updatedAt.toISOString(),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ client_id: v.string(), name: v.string() })),
})

app.get(
  '/applications',
  describeRoute({
    description: 'Lists registered client applications.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Applications', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the applications:read permission' },
    },
  }),
  requirePermission('applications:read'),
  async (c) => {
    const rows = await getDb(c.env).select().from(applications).orderBy(desc(applications.createdAt))
    return c.json({ code: 200, data: rows.map(toPublicApplication) })
  },
)

/** Redirect URIs are matched exactly, so they must be absolute and free of fragments. */
const redirectUriSchema = v.pipe(
  v.string(),
  v.url('Each redirect URI must be an absolute URL'),
  v.check((uri) => !uri.includes('#'), 'A redirect URI must not contain a fragment'),
)

const createApplicationSchema = v.object({
  client_id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'client_id must be lowercase, alphanumeric or -')),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  description: v.optional(v.nullable(v.string())),
  redirect_uris: v.pipe(v.array(redirectUriSchema), v.minLength(1)),
  /** A confidential client gets a generated secret, returned once and only once. */
  confidential: v.optional(v.boolean()),
})

app.post(
  '/applications',
  describeRoute({
    description:
      'Registers a client application. A confidential client receives a generated `client_secret` in this response and nowhere else — only its hash is stored, so it cannot be read back later.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The application was created' },
      403: { description: 'Missing the applications:write permission' },
      409: { description: 'That client_id is already taken' },
    },
  }),
  requirePermission('applications:write'),
  validator('json', createApplicationSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [existing] = await db.select({ id: applications.id }).from(applications).where(eq(applications.id, body.client_id)).limit(1)
    if (existing) {
      throw new HTTPException(409, { message: 'That client_id is already registered' })
    }

    const clientSecret = body.confidential ? randomToken(32) : null
    const now = new Date()
    const application: Application = {
      id: body.client_id,
      name: body.name,
      description: body.description ?? null,
      clientSecretHash: clientSecret ? await sha256(clientSecret) : null,
      redirectUris: JSON.stringify(body.redirect_uris),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }
    await db.insert(applications).values(application)

    await recordAudit(db, {
      event: 'application.created',
      userId: actor.user.id,
      applicationId: application.id,
      ...getRequestContext(c),
      metadata: { confidential: clientSecret !== null },
    })

    return c.json({ code: 201, data: { ...toPublicApplication(application), client_secret: clientSecret } }, 201)
  },
)

const updateApplicationSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  description: v.optional(v.nullable(v.string())),
  redirect_uris: v.optional(v.pipe(v.array(redirectUriSchema), v.minLength(1))),
  is_active: v.optional(v.boolean()),
})

app.patch(
  '/applications/:id',
  describeRoute({
    description:
      'Updates a client application. Deactivating one stops new sign-ins immediately; tokens already issued keep working until they expire, and their sessions can be revoked separately.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated application' },
      403: { description: 'Missing the applications:write permission' },
      404: { description: 'No such application' },
    },
  }),
  requirePermission('applications:write'),
  validator('json', updateApplicationSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [application] = await db.select().from(applications).where(eq(applications.id, c.req.param('id'))).limit(1)
    if (!application) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    const updated: Application = {
      ...application,
      name: body.name ?? application.name,
      description: body.description === undefined ? application.description : body.description,
      redirectUris: body.redirect_uris ? JSON.stringify(body.redirect_uris) : application.redirectUris,
      isActive: body.is_active ?? application.isActive,
      updatedAt: new Date(),
    }

    await db
      .update(applications)
      .set({
        name: updated.name,
        description: updated.description,
        redirectUris: updated.redirectUris,
        isActive: updated.isActive,
        updatedAt: updated.updatedAt,
      })
      .where(eq(applications.id, application.id))

    await recordAudit(db, {
      event: 'application.updated',
      userId: actor.user.id,
      applicationId: application.id,
      ...getRequestContext(c),
      metadata: { fields: Object.keys(body) },
    })

    return c.json({ code: 200, data: toPublicApplication(updated) })
  },
)

export default app
export { toPublicApplication }
