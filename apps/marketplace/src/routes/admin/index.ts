import { desc } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { auditLogs } from '@/db/schema'
import type { AppEnv } from '@/env'
import { PAGINATION } from '@/lib/config'
import { paginationSchema } from '@/lib/validation'
import { requireEditor } from '@/middleware/auth'
import products from '@/routes/admin/products'
import files from '@/routes/admin/files'
import purchases from '@/routes/admin/purchases'
import sales from '@/routes/admin/sales'
import translate from '@/routes/admin/translate'
import compatibility from '@/routes/admin/compatibility'
import releases from '@/routes/admin/releases'
import reviews from '@/routes/admin/reviews'
import wiki from '@/routes/admin/wiki'

/**
 * Editorial API, mounted under `/admin`.
 *
 * Authentication is applied once here, so no individual route can be added without it. The gate is
 * `requireEditor`: a valid access token minted for an accepted client application, carrying a
 * verified email address on an allowed domain.
 */
const app = new Hono<AppEnv>()

app.use('*', requireEditor)

const meResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    id: v.string(),
    email: v.string(),
    name: v.nullable(v.string()),
    picture: v.nullable(v.string()),
    roles: v.array(v.string()),
    permissions: v.array(v.string()),
    client_id: v.string(),
    session_id: v.string(),
  }),
})

app.get(
  '/me',
  describeRoute({
    description:
      'The editor behind the current access token. The front-end\'s "am I still signed in, and am I allowed in here" probe. Roles and permissions are the ones minted into the token by the auth service, so they can lag a change by up to the token lifetime.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The authenticated editor', content: { 'application/json': { schema: resolver(meResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the marketplace console' },
    },
  }),
  (c) => {
    const editor = c.get('editor')
    return c.json({
      code: 200,
      data: {
        id: editor.id,
        email: editor.email,
        name: editor.name,
        picture: editor.picture,
        roles: editor.roles,
        permissions: editor.permissions,
        client_id: editor.clientId,
        session_id: editor.sessionId,
      },
    })
  },
)

const auditResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), event: v.string(), created_at: v.string() })),
})

app.get(
  '/audit',
  describeRoute({
    description: 'Trail of every write made through this service, newest first.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Audit entries', content: { 'application/json': { schema: resolver(auditResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
    },
  }),
  validator('query', paginationSchema),
  async (c) => {
    const { limit = PAGINATION.defaultLimit, offset = 0 } = c.req.valid('query')

    const rows = await getDb(c.env)
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset)

    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id,
        event: row.event,
        actor_email: row.actorEmail,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        ip: row.ip,
        metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
        created_at: row.createdAt.toISOString(),
      })),
    })
  },
)

app.route('/', products)
app.route('/', releases)
app.route('/', compatibility)
app.route('/', reviews)
app.route('/', wiki)
app.route('/', files)
app.route('/', purchases)
app.route('/', sales)
app.route('/', translate)

export default app
