import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { permissions, rolePermissions, roles } from '@/db/schema'
import type { AppEnv } from '@/env'
import { generateId } from '@/lib/crypto'
import { requirePermission } from '@/middleware/auth'
import { getApplication } from '@/services/applications'

const app = new Hono<AppEnv>()

const rolesResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.looseObject({
      id: v.string(),
      slug: v.string(),
      name: v.string(),
      application_id: v.nullable(v.string()),
      permissions: v.array(v.string()),
    }),
  ),
})

app.get(
  '/roles',
  describeRoute({
    description:
      'Lists roles with the permissions attached to each. A null `application_id` marks a global role, which applies to every client application.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Roles', content: { 'application/json': { schema: resolver(rolesResponseSchema) } } },
      403: { description: 'Missing the roles:read permission' },
    },
  }),
  requirePermission('roles:read'),
  async (c) => {
    const db = getDb(c.env)
    const rows = await db.select().from(roles)
    const grants = await db
      .select({ roleId: rolePermissions.roleId, slug: permissions.slug })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))

    return c.json({
      code: 200,
      data: rows.map((role) => ({
        id: role.id,
        slug: role.slug,
        name: role.name,
        description: role.description,
        application_id: role.applicationId,
        is_default: role.isDefault,
        permissions: grants.filter((grant) => grant.roleId === role.id).map((grant) => grant.slug).sort(),
      })),
    })
  },
)

const createRoleSchema = v.object({
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9_-]{1,62}$/, 'slug must be lowercase, alphanumeric, _ or -')),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  description: v.optional(v.nullable(v.string())),
  /** Null creates a global role; otherwise the role only applies to that application. */
  application_id: v.optional(v.nullable(v.string())),
  /** Granted automatically to every account on first sign-in within the role's scope. */
  is_default: v.optional(v.boolean()),
  permissions: v.optional(v.array(v.string())),
})

app.post(
  '/roles',
  describeRoute({
    description: 'Creates a role, optionally attaching permissions to it in the same call.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The role was created' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such application, or an unknown permission slug' },
      409: { description: 'That slug already exists in this scope' },
    },
  }),
  requirePermission('roles:write'),
  validator('json', createRoleSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)

    if (body.application_id && !(await getApplication(db, body.application_id))) {
      throw new HTTPException(404, { message: 'Application not found' })
    }

    const [duplicate] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.slug, body.slug),
          body.application_id ? eq(roles.applicationId, body.application_id) : isNull(roles.applicationId),
        ),
      )
      .limit(1)
    if (duplicate) {
      throw new HTTPException(409, { message: 'A role with that slug already exists in this scope' })
    }

    const role = {
      id: generateId(),
      applicationId: body.application_id ?? null,
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      isDefault: body.is_default ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.insert(roles).values(role)

    const requested = body.permissions ?? []
    if (requested.length > 0) {
      const rows = await db.select().from(permissions)
      const unknown = requested.filter((slug) => !rows.some((permission) => permission.slug === slug))
      if (unknown.length > 0) {
        throw new HTTPException(404, { message: `Unknown permissions: ${unknown.join(', ')}` })
      }
      for (const permission of rows.filter((row) => requested.includes(row.slug))) {
        await db.insert(rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing()
      }
    }

    return c.json(
      {
        code: 201,
        data: {
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          application_id: role.applicationId,
          is_default: role.isDefault,
          permissions: [...requested].sort(),
        },
      },
      201,
    )
  },
)

const permissionsResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(v.looseObject({ id: v.string(), slug: v.string(), name: v.string() })),
})

app.get(
  '/permissions',
  describeRoute({
    description: 'Lists every permission a role can be given. Permissions are seeded, not created at runtime.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Permissions',
        content: { 'application/json': { schema: resolver(permissionsResponseSchema) } },
      },
      403: { description: 'Missing the roles:read permission' },
    },
  }),
  requirePermission('roles:read'),
  async (c) => {
    const rows = await getDb(c.env).select().from(permissions)
    return c.json({
      code: 200,
      data: rows.map((permission) => ({
        id: permission.id,
        slug: permission.slug,
        name: permission.name,
        description: permission.description,
      })),
    })
  },
)

const attachPermissionSchema = v.object({
  permission_slug: v.pipe(v.string(), v.minLength(1)),
})

app.post(
  '/roles/:id/permissions',
  describeRoute({
    description: 'Attaches a permission to a role.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The permission was attached' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such role or permission' },
    },
  }),
  requirePermission('roles:write'),
  validator('json', attachPermissionSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [role] = await db.select().from(roles).where(eq(roles.id, c.req.param('id'))).limit(1)
    if (!role) {
      throw new HTTPException(404, { message: 'Role not found' })
    }
    const [permission] = await db.select().from(permissions).where(eq(permissions.slug, body.permission_slug)).limit(1)
    if (!permission) {
      throw new HTTPException(404, { message: 'Permission not found' })
    }

    await db.insert(rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing()
    return c.body(null, 204)
  },
)

app.delete(
  '/roles/:id/permissions/:slug',
  describeRoute({
    description: 'Detaches a permission from a role.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The permission was detached' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such permission' },
    },
  }),
  requirePermission('roles:write'),
  async (c) => {
    const db = getDb(c.env)
    const [permission] = await db.select().from(permissions).where(eq(permissions.slug, c.req.param('slug'))).limit(1)
    if (!permission) {
      throw new HTTPException(404, { message: 'Permission not found' })
    }

    await db
      .delete(rolePermissions)
      .where(and(eq(rolePermissions.roleId, c.req.param('id')), eq(rolePermissions.permissionId, permission.id)))

    return c.body(null, 204)
  },
)

export default app
