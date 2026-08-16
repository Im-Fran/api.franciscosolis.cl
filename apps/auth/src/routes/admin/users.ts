import { and, desc, eq, like, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { identities, roles, sessions, userRoles, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { USER_STATUS } from '@/lib/config'
import { requirePermission } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import { revokeSession, toPublicSession } from '@/services/tokens'
import { findUserById, toPublicUser } from '@/services/users'

const app = new Hono<AppEnv>()

const paginationSchema = v.object({
  query: v.optional(v.string()),
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(200))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), email: v.string() })),
})

app.get(
  '/users',
  describeRoute({
    description: 'Lists users, newest first. `query` filters on email and name with a substring match.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Users', content: { 'application/json': { schema: resolver(listResponseSchema) } } },
      403: { description: 'Missing the users:read permission' },
    },
  }),
  requirePermission('users:read'),
  validator('query', paginationSchema),
  async (c) => {
    const { query, limit = 50, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)

    const filter = query ? `%${query.toLowerCase()}%` : null
    const rows = await db
      .select()
      .from(users)
      .where(filter ? or(like(users.email, filter), like(users.name, filter)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset)

    return c.json({ code: 200, data: rows.map(toPublicUser) })
  },
)

const detailResponseSchema = v.object({
  code: v.literal(200),
  data: v.looseObject({ user: v.looseObject({ id: v.string() }) }),
})

app.get(
  '/users/:id',
  describeRoute({
    description: 'A single user with their roles, linked identities and active sessions.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'User detail', content: { 'application/json': { schema: resolver(detailResponseSchema) } } },
      403: { description: 'Missing the users:read permission' },
      404: { description: 'No such user' },
    },
  }),
  requirePermission('users:read'),
  async (c) => {
    const db = getDb(c.env)
    const user = await findUserById(db, c.req.param('id'))
    if (!user) {
      throw new HTTPException(404, { message: 'User not found' })
    }

    const grantedRoles = await db
      .select({ id: roles.id, slug: roles.slug, name: roles.name, applicationId: roles.applicationId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, user.id))

    const linkedIdentities = await db.select().from(identities).where(eq(identities.userId, user.id))
    const activeSessions = await db.select().from(sessions).where(eq(sessions.userId, user.id))

    return c.json({
      code: 200,
      data: {
        user: toPublicUser(user),
        roles: grantedRoles.map((role) => ({
          id: role.id,
          slug: role.slug,
          name: role.name,
          application_id: role.applicationId,
        })),
        identities: linkedIdentities.map((identity) => ({
          id: identity.id,
          provider: identity.provider,
          email: identity.email,
          last_used_at: identity.lastUsedAt?.toISOString() ?? null,
        })),
        sessions: activeSessions.filter((session) => !session.revokedAt).map((session) => toPublicSession(session)),
      },
    })
  },
)

const updateUserSchema = v.object({
  status: v.optional(v.picklist(USER_STATUS)),
})

app.patch(
  '/users/:id',
  describeRoute({
    description:
      'Updates a user\'s status. Disabling an account revokes every session it has, so it takes effect immediately rather than at the next token expiry.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated user' },
      403: { description: 'Missing the users:write permission' },
      404: { description: 'No such user' },
    },
  }),
  requirePermission('users:write'),
  validator('json', updateUserSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const user = await findUserById(db, c.req.param('id'))
    if (!user) {
      throw new HTTPException(404, { message: 'User not found' })
    }
    if (body.status === undefined || body.status === user.status) {
      return c.json({ code: 200, data: toPublicUser(user) })
    }

    await db.update(users).set({ status: body.status, updatedAt: new Date() }).where(eq(users.id, user.id))

    if (body.status === 'disabled') {
      const userSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id))
      for (const session of userSessions) {
        await revokeSession(db, session.id, 'user_disabled')
      }
    }

    await recordAudit(db, {
      event: body.status === 'disabled' ? 'user.disabled' : 'user.enabled',
      userId: user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { by: actor.user.id },
    })

    return c.json({ code: 200, data: toPublicUser({ ...user, status: body.status }) })
  },
)

const grantRoleSchema = v.object({
  role_id: v.pipe(v.string(), v.minLength(1)),
})

app.post(
  '/users/:id/roles',
  describeRoute({
    description: 'Grants a role to a user. Granting a role the user already holds is a no-op.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The role was granted' },
      403: { description: 'Missing the users:write permission' },
      404: { description: 'No such user or role' },
    },
  }),
  requirePermission('users:write'),
  validator('json', grantRoleSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const user = await findUserById(db, c.req.param('id'))
    if (!user) {
      throw new HTTPException(404, { message: 'User not found' })
    }
    const [role] = await db.select().from(roles).where(eq(roles.id, body.role_id)).limit(1)
    if (!role) {
      throw new HTTPException(404, { message: 'Role not found' })
    }

    await db
      .insert(userRoles)
      .values({ userId: user.id, roleId: role.id, grantedBy: actor.user.id })
      .onConflictDoNothing()

    await recordAudit(db, {
      event: 'role.granted',
      userId: user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { role: role.slug, by: actor.user.id },
    })

    return c.body(null, 204)
  },
)

app.delete(
  '/users/:id/roles/:roleId',
  describeRoute({
    description: 'Revokes a role from a user. Takes effect on the next request, not at token expiry.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The role was revoked' },
      403: { description: 'Missing the users:write permission' },
    },
  }),
  requirePermission('users:write'),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)
    const userId = c.req.param('id')
    const roleId = c.req.param('roleId')

    await db.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
    await recordAudit(db, {
      event: 'role.revoked',
      userId,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { role_id: roleId, by: actor.user.id },
    })

    return c.body(null, 204)
  },
)

app.delete(
  '/users/:id/sessions',
  describeRoute({
    description: 'Revokes every session of a user, signing them out of all applications and devices.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'All sessions were revoked' },
      403: { description: 'Missing the sessions:revoke permission' },
    },
  }),
  requirePermission('sessions:revoke'),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)
    const userId = c.req.param('id')

    const userSessions = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
    for (const session of userSessions) {
      await revokeSession(db, session.id, 'admin_revocation')
    }

    await recordAudit(db, {
      event: 'session.revoked',
      userId,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { count: userSessions.length, by: actor.user.id },
    })

    return c.body(null, 204)
  },
)

export default app
