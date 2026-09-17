import { and, count, eq, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { permissions, rolePermissions, roles, userRoles } from '@/db/schema'
import type { AppEnv } from '@/env'
import { GUARDED_PERMISSIONS } from '@/lib/config'
import { generateId } from '@/lib/crypto'
import { requirePermission } from '@/middleware/auth'
import { getApplication } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'

const app = new Hono<AppEnv>()

/** The permission slugs currently attached to one role, sorted so every response is stable. */
const attachedSlugs = async (db: ReturnType<typeof getDb>, roleId: string) => {
  const rows = await db
    .select({ slug: permissions.slug })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(rolePermissions.roleId, roleId))
  return rows.map((row) => row.slug).sort()
}

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

    await recordAudit(db, {
      event: 'role.created',
      userId: c.get('actor').user.id,
      applicationId: role.applicationId,
      ...getRequestContext(c),
      metadata: { slug: role.slug, permissions: requested },
    })

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

const updateRoleSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  description: v.optional(v.nullable(v.string())),
  is_default: v.optional(v.boolean()),
  /** Replaces the role's whole permission set rather than merging into it. */
  permissions: v.optional(v.array(v.string())),
})

app.patch(
  '/roles/:id',
  describeRoute({
    description:
      'Updates a role. `permissions` replaces the whole set rather than merging into it, so a caller always sends every slug it means to keep — the same rule the attach and detach endpoints exist to avoid when changing one at a time. The slug and the scope are deliberately immutable: both are what existing grants and tokens name this role by, and changing either would silently re-point them.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated role' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such role, or an unknown permission slug' },
    },
  }),
  requirePermission('roles:write'),
  validator('json', updateRoleSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [role] = await db.select().from(roles).where(eq(roles.id, c.req.param('id'))).limit(1)
    if (!role) {
      throw new HTTPException(404, { message: 'Role not found' })
    }

    const updated = {
      name: body.name ?? role.name,
      description: body.description === undefined ? role.description : body.description,
      isDefault: body.is_default ?? role.isDefault,
      updatedAt: new Date(),
    }
    await db.update(roles).set(updated).where(eq(roles.id, role.id))

    let slugs = await attachedSlugs(db, role.id)
    if (body.permissions) {
      const rows = await db.select().from(permissions)
      const unknown = body.permissions.filter((slug) => !rows.some((permission) => permission.slug === slug))
      if (unknown.length > 0) {
        throw new HTTPException(404, { message: `Unknown permissions: ${unknown.join(', ')}` })
      }

      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id))
      for (const permission of rows.filter((row) => body.permissions?.includes(row.slug))) {
        await db.insert(rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing()
      }
      slugs = [...body.permissions].sort()
    }

    await recordAudit(db, {
      event: 'role.updated',
      userId: c.get('actor').user.id,
      applicationId: role.applicationId,
      ...getRequestContext(c),
      metadata: { slug: role.slug, fields: Object.keys(body) },
    })

    return c.json({
      code: 200,
      data: {
        id: role.id,
        slug: role.slug,
        name: updated.name,
        description: updated.description,
        application_id: role.applicationId,
        is_default: updated.isDefault,
        permissions: slugs,
      },
    })
  },
)

app.delete(
  '/roles/:id',
  describeRoute({
    description:
      'Deletes a role. Every grant of it is dropped with it, so the accounts that held it lose whatever it gave them — on their next request, not at token expiry. Refused when it is the last role anywhere that carries `roles:write`, because deleting that one leaves nobody able to create its replacement.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The role was deleted' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such role' },
      409: { description: 'Deleting it would leave nobody able to administer roles' },
    },
  }),
  requirePermission('roles:write'),
  async (c) => {
    const db = getDb(c.env)

    const [role] = await db.select().from(roles).where(eq(roles.id, c.req.param('id'))).limit(1)
    if (!role) {
      throw new HTTPException(404, { message: 'Role not found' })
    }

    // The one guard worth having here. Anything else a role carries can be granted again by
    // somebody who still holds `roles:write`; that permission is the one that cannot be recovered
    // from inside the API once the last account holding it loses it.
    if ((await attachedSlugs(db, role.id)).includes('roles:write')) {
      const [remaining] = await db
        .select({ holders: count() })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(and(eq(permissions.slug, 'roles:write'), ne(roles.id, role.id)))

      if ((remaining?.holders ?? 0) === 0) {
        throw new HTTPException(409, {
          message: 'This is the last role that grants roles:write; grant it elsewhere before deleting this one',
        })
      }
    }

    // `role_permissions` and `user_roles` both cascade from `roles`, so this is the whole delete.
    await db.delete(roles).where(eq(roles.id, role.id))

    await recordAudit(db, {
      event: 'role.deleted',
      userId: c.get('actor').user.id,
      applicationId: role.applicationId,
      ...getRequestContext(c),
      metadata: { slug: role.slug },
    })

    return c.body(null, 204)
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

const createPermissionSchema = v.object({
  slug: v.pipe(
    v.string(),
    v.regex(/^[a-z0-9][a-z0-9_-]*(:[a-z0-9][a-z0-9_-]*)?$/, 'slug must look like `resource:action`'),
    v.maxLength(64),
  ),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  description: v.optional(v.nullable(v.string())),
})

app.post(
  '/permissions',
  describeRoute({
    description:
      'Defines a permission. The eleven this Worker guards its own routes with are seeded by a migration; one created here is for somebody else to check — permissions travel in the access token, so another service can be given a capability of its own without a migration in this repo. Creating one grants nothing on its own: it has to be attached to a role.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'The permission was created' },
      403: { description: 'Missing the roles:write permission' },
      409: { description: 'That slug already exists' },
    },
  }),
  requirePermission('roles:write'),
  validator('json', createPermissionSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [duplicate] = await db.select({ id: permissions.id }).from(permissions).where(eq(permissions.slug, body.slug)).limit(1)
    if (duplicate) {
      throw new HTTPException(409, { message: 'A permission with that slug already exists' })
    }

    const permission = {
      id: generateId(),
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.insert(permissions).values(permission)

    await recordAudit(db, {
      event: 'permission.created',
      userId: c.get('actor').user.id,
      ...getRequestContext(c),
      metadata: { slug: permission.slug },
    })

    return c.json(
      {
        code: 201,
        data: {
          id: permission.id,
          slug: permission.slug,
          name: permission.name,
          description: permission.description,
        },
      },
      201,
    )
  },
)

const updatePermissionSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  description: v.optional(v.nullable(v.string())),
})

app.patch(
  '/permissions/:id',
  describeRoute({
    description:
      'Renames a permission or rewrites its description. The slug is immutable: it is the string every route guard, every role attachment and every issued token names this permission by, so changing it would revoke the permission everywhere and grant a new one nowhere.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The updated permission' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such permission' },
    },
  }),
  requirePermission('roles:write'),
  validator('json', updatePermissionSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = getDb(c.env)

    const [permission] = await db.select().from(permissions).where(eq(permissions.id, c.req.param('id'))).limit(1)
    if (!permission) {
      throw new HTTPException(404, { message: 'Permission not found' })
    }

    const updated = {
      name: body.name ?? permission.name,
      description: body.description === undefined ? permission.description : body.description,
      updatedAt: new Date(),
    }
    await db.update(permissions).set(updated).where(eq(permissions.id, permission.id))

    await recordAudit(db, {
      event: 'permission.updated',
      userId: c.get('actor').user.id,
      ...getRequestContext(c),
      metadata: { slug: permission.slug, fields: Object.keys(body) },
    })

    return c.json({
      code: 200,
      data: {
        id: permission.id,
        slug: permission.slug,
        name: updated.name,
        description: updated.description,
      },
    })
  },
)

app.delete(
  '/permissions/:id',
  describeRoute({
    description:
      'Deletes a permission and detaches it from every role holding it. The slugs this Worker guards its own routes with are refused: deleting one takes no capability away from anybody, it only leaves the administration API with a guard nothing can satisfy.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'The permission was deleted' },
      403: { description: 'Missing the roles:write permission' },
      404: { description: 'No such permission' },
      409: { description: 'That permission guards a route of this Worker' },
    },
  }),
  requirePermission('roles:write'),
  async (c) => {
    const db = getDb(c.env)

    const [permission] = await db.select().from(permissions).where(eq(permissions.id, c.req.param('id'))).limit(1)
    if (!permission) {
      throw new HTTPException(404, { message: 'Permission not found' })
    }
    if ((GUARDED_PERMISSIONS as readonly string[]).includes(permission.slug)) {
      throw new HTTPException(409, {
        message: `${permission.slug} guards a route of this Worker and cannot be deleted`,
      })
    }

    // `role_permissions` cascades from `permissions`, so the attachments go with it.
    await db.delete(permissions).where(eq(permissions.id, permission.id))

    await recordAudit(db, {
      event: 'permission.deleted',
      userId: c.get('actor').user.id,
      ...getRequestContext(c),
      metadata: { slug: permission.slug },
    })

    return c.body(null, 204)
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
