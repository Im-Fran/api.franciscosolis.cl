import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { applications, auditLogs, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { requirePermission } from '@/middleware/auth'
import { AUDIT_EVENTS } from '@/services/audit'

const app = new Hono<AppEnv>()

const querySchema = v.object({
  event: v.optional(v.picklist(AUDIT_EVENTS)),
  user_id: v.optional(v.string()),
  application_id: v.optional(v.string()),
  /** Inclusive lower bound, as an ISO 8601 instant. */
  from: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  /** Inclusive upper bound, as an ISO 8601 instant. */
  to: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(200))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), event: v.string(), created_at: v.string() })),
})

/**
 * Metadata is written as JSON by `recordAudit`, but the column is free-form text and the trail is
 * append-only — nothing repairs a row written by an older shape of the Worker. A row whose payload
 * no longer parses degrades to `null` rather than failing the whole page.
 */
const parseMetadata = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

app.get(
  '/audit',
  describeRoute({
    description:
      'Reads the authentication audit trail, newest first. Every filter is optional and they combine with AND. The rows carry the email of the account each one is about and the name of the application it happened in, resolved here so a reader does not have to fetch either. Like every other list on this API it pages with `limit`/`offset` and returns no total.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Audit entries', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the audit:read permission' },
    },
  }),
  requirePermission('audit:read'),
  validator('query', querySchema),
  async (c) => {
    const { event, user_id, application_id, from, to, limit = 50, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)

    const filters = [
      event ? eq(auditLogs.event, event) : undefined,
      user_id ? eq(auditLogs.userId, user_id) : undefined,
      application_id ? eq(auditLogs.applicationId, application_id) : undefined,
      from ? gte(auditLogs.createdAt, new Date(from)) : undefined,
      to ? lte(auditLogs.createdAt, new Date(to)) : undefined,
    ].filter((filter) => filter !== undefined)

    const rows = await db
      .select({
        entry: auditLogs,
        userEmail: users.email,
        userName: users.name,
        applicationName: applications.name,
      })
      .from(auditLogs)
      // Both joins are left joins on purpose: `user_id` and `application_id` are set to null when
      // the row they pointed at is deleted, and an entry about something that no longer exists is
      // exactly the kind the trail is kept for.
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .leftJoin(applications, eq(applications.id, auditLogs.applicationId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit)
      .offset(offset)

    return c.json({
      code: 200,
      data: rows.map(({ entry, userEmail, userName, applicationName }) => ({
        id: entry.id,
        event: entry.event,
        user_id: entry.userId,
        user_email: userEmail,
        user_name: userName,
        application_id: entry.applicationId,
        application_name: applicationName,
        ip: entry.ip,
        user_agent: entry.userAgent,
        metadata: parseMetadata(entry.metadata),
        created_at: entry.createdAt.toISOString(),
      })),
    })
  },
)

const eventsResponseSchema = v.object({ code: v.literal(200), data: v.array(v.string()) })

app.get(
  '/audit/events',
  describeRoute({
    description:
      'Every event name the trail can contain, whether or not one has been recorded yet. It is the Worker\'s own closed set, so a filter built from it can never offer a value the trail will not answer to, and an event added here appears in an interface without a release.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Event names', content: { 'application/json': { schema: resolver(eventsResponseSchema) } } },
      403: { description: 'Missing the audit:read permission' },
    },
  }),
  requirePermission('audit:read'),
  (c) => c.json({ code: 200, data: [...AUDIT_EVENTS] }),
)

export default app
