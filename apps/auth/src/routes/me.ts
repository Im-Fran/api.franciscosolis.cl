import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { identities, sessions, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { requireAuth } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import { revokeSession, toPublicSession } from '@/services/tokens'
import { toPublicUser } from '@/services/users'

const app = new Hono<AppEnv>()

app.use('/me', requireAuth)
app.use('/me/*', requireAuth)
app.use('/logout', requireAuth)

const userSchema = v.object({
  id: v.string(),
  email: v.string(),
  email_verified: v.boolean(),
  name: v.nullable(v.string()),
  given_name: v.nullable(v.string()),
  family_name: v.nullable(v.string()),
  picture: v.nullable(v.string()),
  locale: v.nullable(v.string()),
  status: v.string(),
  last_login_at: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
})

const meResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    user: userSchema,
    application_id: v.string(),
    session_id: v.string(),
    roles: v.array(v.string()),
    permissions: v.array(v.string()),
  }),
})

app.get(
  '/me',
  describeRoute({
    description:
      'Profile of the authenticated user, together with the roles and permissions they hold for the application the access token was issued to. Roles and permissions are read live from the database, so they reflect changes made after the token was issued.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The authenticated user',
        content: { 'application/json': { schema: resolver(meResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  (c) => {
    const actor = c.get('actor')
    return c.json({
      code: 200,
      data: {
        user: toPublicUser(actor.user),
        application_id: actor.applicationId,
        session_id: actor.sessionId,
        roles: actor.roles,
        permissions: actor.permissions,
      },
    })
  },
)

const updateMeSchema = v.object({
  name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  given_name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  family_name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  picture: v.optional(v.nullable(v.pipe(v.string(), v.url()))),
  locale: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(20)))),
})

app.patch(
  '/me',
  describeRoute({
    description:
      'Updates the profile fields the user owns. The email address is deliberately not editable here: it is the identity key providers are matched on, so changing it would re-point the account.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The updated user',
        content: { 'application/json': { schema: resolver(meResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  validator('json', updateMeSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const updated = {
      ...actor.user,
      // `undefined` means "not sent, leave alone"; an explicit null clears the field.
      name: body.name === undefined ? actor.user.name : body.name,
      givenName: body.given_name === undefined ? actor.user.givenName : body.given_name,
      familyName: body.family_name === undefined ? actor.user.familyName : body.family_name,
      picture: body.picture === undefined ? actor.user.picture : body.picture,
      locale: body.locale === undefined ? actor.user.locale : body.locale,
      updatedAt: new Date(),
    }

    await db
      .update(users)
      .set({
        name: updated.name,
        givenName: updated.givenName,
        familyName: updated.familyName,
        picture: updated.picture,
        locale: updated.locale,
        updatedAt: updated.updatedAt,
      })
      .where(eq(users.id, actor.user.id))

    await recordAudit(db, {
      event: 'user.updated',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { fields: Object.keys(body) },
    })

    return c.json({
      code: 200,
      data: {
        user: toPublicUser(updated),
        application_id: actor.applicationId,
        session_id: actor.sessionId,
        roles: actor.roles,
        permissions: actor.permissions,
      },
    })
  },
)

const identitiesResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.object({
      id: v.string(),
      provider: v.string(),
      email: v.nullable(v.string()),
      last_used_at: v.nullable(v.string()),
      created_at: v.string(),
    }),
  ),
})

app.get(
  '/me/identities',
  describeRoute({
    description: 'Providers linked to the authenticated account.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Linked identities',
        content: { 'application/json': { schema: resolver(identitiesResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const rows = await getDb(c.env).select().from(identities).where(eq(identities.userId, actor.user.id))

    return c.json({
      code: 200,
      data: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        email: row.email,
        last_used_at: row.lastUsedAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
      })),
    })
  },
)

const sessionsResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.object({
      id: v.string(),
      application_id: v.string(),
      provider: v.string(),
      ip: v.nullable(v.string()),
      user_agent: v.nullable(v.string()),
      current: v.boolean(),
      revoked_at: v.nullable(v.string()),
      last_seen_at: v.string(),
      created_at: v.string(),
    }),
  ),
})

app.get(
  '/me/sessions',
  describeRoute({
    description:
      'Active sessions of the authenticated user across every application. The session the current access token belongs to is flagged with `current`.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Active sessions',
        content: { 'application/json': { schema: resolver(sessionsResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const rows = await getDb(c.env)
      .select()
      .from(sessions)
      .where(eq(sessions.userId, actor.user.id))
      .orderBy(desc(sessions.lastSeenAt))

    return c.json({
      code: 200,
      data: rows.filter((row) => !row.revokedAt).map((row) => toPublicSession(row, actor.sessionId)),
    })
  },
)

app.delete(
  '/me/sessions/:id',
  describeRoute({
    description:
      'Revokes one of the authenticated user\'s own sessions, invalidating its whole refresh token chain. Revoking the current session is the same as signing out.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The session was revoked' },
      401: { description: 'Missing, invalid or revoked access token' },
      404: { description: 'No such session belongs to this user' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const sessionId = c.req.param('id')
    const db = getDb(c.env)

    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, actor.user.id)))
      .limit(1)

    if (!session) {
      throw new HTTPException(404, { message: 'Session not found' })
    }

    await revokeSession(db, session.id, 'user_revocation')
    await recordAudit(db, {
      event: 'session.revoked',
      userId: actor.user.id,
      applicationId: session.applicationId,
      ...getRequestContext(c),
      metadata: { session_id: session.id, self: true },
    })

    return c.body(null, 204)
  },
)

app.post(
  '/logout',
  describeRoute({
    description:
      'Signs out of the current session. The access token itself cannot be un-issued, but it stops being accepted immediately because every authenticated request re-checks that its session is still alive.',
    tags: ['Me'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The session was revoked' },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    await revokeSession(db, actor.sessionId, 'logout')
    await recordAudit(db, {
      event: 'session.revoked',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { session_id: actor.sessionId, reason: 'logout' },
    })

    return c.body(null, 204)
  },
)

export default app
