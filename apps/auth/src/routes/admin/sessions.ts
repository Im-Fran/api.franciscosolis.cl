import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { applications, sessions, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { requirePermission } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import { revokeSession, toPublicSession } from '@/services/tokens'

const app = new Hono<AppEnv>()

const listQuerySchema = v.object({
  /** Whether to include sessions that are already revoked. Defaults to live ones only. */
  include_revoked: v.optional(v.picklist(['true', 'false'])),
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(200))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), application_id: v.string(), provider: v.string() })),
})

const allQuerySchema = v.object({
  user_id: v.optional(v.string()),
  application_id: v.optional(v.string()),
  include_revoked: v.optional(v.picklist(['true', 'false'])),
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(200))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

app.get(
  '/sessions',
  describeRoute({
    description:
      'Every session on this service, most recently seen first, each carrying the account it belongs to and the application it was opened in. This is the view that answers "who is signed in right now"; `GET /admin/users/{id}/sessions` is the same list narrowed to one account.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Sessions', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the sessions:read permission' },
    },
  }),
  requirePermission('sessions:read'),
  validator('query', allQuerySchema),
  async (c) => {
    const { user_id, application_id, include_revoked, limit = 50, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)

    const filters = [
      user_id ? eq(sessions.userId, user_id) : undefined,
      application_id ? eq(sessions.applicationId, application_id) : undefined,
      include_revoked === 'true' ? undefined : isNull(sessions.revokedAt),
    ].filter((filter) => filter !== undefined)

    const rows = await db
      .select({
        session: sessions,
        applicationName: applications.name,
        userEmail: users.email,
        userName: users.name,
        userPicture: users.picture,
      })
      .from(sessions)
      .leftJoin(applications, eq(applications.id, sessions.applicationId))
      .leftJoin(users, eq(users.id, sessions.userId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(sessions.lastSeenAt))
      .limit(limit)
      .offset(offset)

    return c.json({
      code: 200,
      data: rows.map(({ session, applicationName, userEmail, userName, userPicture }) => ({
        ...toPublicSession(session),
        user_id: session.userId,
        user_email: userEmail,
        user_name: userName,
        user_picture: userPicture,
        application_name: applicationName,
        revoked_reason: session.revokedReason,
      })),
    })
  },
)

app.get(
  '/users/:id/sessions',
  describeRoute({
    description:
      'The sessions of one user, most recently seen first, each named with the application it belongs to. A session is one sign-in on one device in one application, so the same person signed in to the site and to the CMS has two.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Sessions', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the sessions:read permission' },
    },
  }),
  requirePermission('sessions:read'),
  validator('query', listQuerySchema),
  async (c) => {
    const { include_revoked, limit = 50, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)

    const rows = await db
      .select({ session: sessions, applicationName: applications.name })
      .from(sessions)
      // Left join: the session's application is a foreign key with no cascade to null, but a row
      // written before a client was renamed still has to render.
      .leftJoin(applications, eq(applications.id, sessions.applicationId))
      .where(
        and(
          eq(sessions.userId, c.req.param('id')),
          include_revoked === 'true' ? undefined : isNull(sessions.revokedAt),
        ),
      )
      .orderBy(desc(sessions.lastSeenAt))
      .limit(limit)
      .offset(offset)

    return c.json({
      code: 200,
      data: rows.map(({ session, applicationName }) => ({
        ...toPublicSession(session),
        application_name: applicationName,
        revoked_reason: session.revokedReason,
      })),
    })
  },
)

app.delete(
  '/sessions/:id',
  describeRoute({
    description:
      'Revokes a single session, signing that one device out of that one application and killing its refresh-token chain. Everything else the account has open stays open — `DELETE /admin/users/{id}/sessions` is the blunt version.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The session was revoked' },
      403: { description: 'Missing the sessions:revoke permission' },
      404: { description: 'No such live session' },
    },
  }),
  requirePermission('sessions:revoke'),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    const [session] = await db.select().from(sessions).where(eq(sessions.id, c.req.param('id'))).limit(1)
    // An already-revoked session is reported as missing rather than as a no-op success: the caller
    // asked to end something that is not running, and saying so is more useful than pretending.
    if (!session || session.revokedAt) {
      throw new HTTPException(404, { message: 'No live session with that id' })
    }

    await revokeSession(db, session.id, 'admin_revocation')

    await recordAudit(db, {
      event: 'session.revoked',
      userId: session.userId,
      applicationId: session.applicationId,
      ...getRequestContext(c),
      metadata: { session_id: session.id, by: actor.user.id },
    })

    return c.body(null, 204)
  },
)

export default app
