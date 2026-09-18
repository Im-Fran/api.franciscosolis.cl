import { and, desc, eq, gte } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { auditLogs } from '@/db/schema'
import type { AppEnv } from '@/env'
import { ADMIN_PERMISSION, PAGINATION } from '@/lib/config'
import { parseJson } from '@/lib/json'
import { dateInput, paginationSchema } from '@/lib/validation'
import { requireAgent } from '@/middleware/auth'

/* Routes */
import labels from '@/routes/admin/labels'
import tickets from '@/routes/admin/tickets'

const app = new Hono<AppEnv>()

/**
 * The gate, applied once for the whole subtree.
 *
 * Mounting it here rather than per route is what makes it impossible to add an `/admin` route that
 * forgets it — the same reason the cms and pages Workers do it this way. The per-route
 * `requirePermission(ADMIN_PERMISSION)` calls inside the sub-routers sit *on top* of this, never
 * instead of it.
 */
app.use('*', requireAgent)

const meResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    id: v.string(),
    email: v.string(),
    name: v.nullable(v.string()),
    picture: v.nullable(v.string()),
    roles: v.array(v.string()),
    permissions: v.array(v.string()),
    can_administer: v.boolean(),
  }),
})

app.get(
  '/me',
  describeRoute({
    description:
      'Who the access token belongs to, and what it is allowed to do here. The console calls this once and renders a single "no access" screen on a 403, rather than letting a dozen panels fail separately.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The signed-in agent', content: { 'application/json': { schema: resolver(meResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the support console' },
    },
  }),
  (c) => {
    const agent = c.get('agent')
    return c.json({
      code: 200,
      data: {
        id: agent.id,
        email: agent.email,
        name: agent.name,
        picture: agent.picture,
        // A snapshot taken when the token was minted, so it can lag a revocation by up to the
        // access-token lifetime. It drives which menu entries the console draws, not what the API
        // permits — every route checks for itself.
        roles: agent.roles,
        permissions: agent.permissions,
        can_administer: agent.permissions.includes(ADMIN_PERMISSION),
      },
    })
  },
)

const auditQuerySchema = v.object({
  event: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  actor: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(320))),
  since: v.optional(dateInput),
  ...paginationSchema.entries,
})

const auditResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), event: v.string() })),
})

app.get(
  '/audit',
  describeRoute({
    description: 'The audit trail, newest first. Records who changed what; never the text of a message.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Audit entries', content: { 'application/json': { schema: resolver(auditResponseSchema) } } },
      401: { description: 'Missing or invalid access token' },
      403: { description: 'Account not allowed into the support console' },
    },
  }),
  validator('query', auditQuerySchema),
  async (c) => {
    const query = c.req.valid('query')
    const conditions = [
      query.event ? eq(auditLogs.event, query.event) : undefined,
      query.actor ? eq(auditLogs.actorEmail, query.actor.toLowerCase()) : undefined,
      query.since ? gte(auditLogs.createdAt, query.since) : undefined,
    ].filter(Boolean)

    const rows = await getDb(c.env)
      .select()
      .from(auditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.limit ?? PAGINATION.defaultLimit)
      .offset(query.offset ?? 0)

    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id,
        event: row.event,
        actor_email: row.actorEmail,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
        ip: row.ip,
        created_at: row.createdAt?.toISOString() ?? null,
      })),
    })
  },
)

app.route('/', tickets)
app.route('/', labels)

export default app
