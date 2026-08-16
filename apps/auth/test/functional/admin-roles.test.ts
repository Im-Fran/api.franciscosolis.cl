import { SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { permissions, rolePermissions, roles } from '@/db/schema'
import { createRole, db, SEED, signIn } from '../helpers/db'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

const callerWith = async (granted: string[]) => {
  const role = await createRole({ slug: `caller-${crypto.randomUUID().slice(0, 8)}`, permissions: granted })
  return signIn({ roleIds: [role.id] })
}

describe('GET /admin/roles', () => {
  it('lists roles with the permissions attached to each', async () => {
    const { token } = await callerWith(['roles:read'])

    const body = await (await call('/roles', token)).json<{
      data: { id: string; slug: string; application_id: string | null; is_default: boolean; permissions: string[] }[]
    }>()

    const admin = body.data.find((role) => role.id === SEED.adminRoleId)
    const user = body.data.find((role) => role.id === SEED.userRoleId)

    expect(admin?.application_id).toBeNull()
    expect(admin?.permissions).toContain('users:write')
    expect(user).toMatchObject({ slug: 'user', is_default: true, permissions: [] })
  })

  it('sorts each role\'s permissions, so the output is stable', async () => {
    const { token } = await callerWith(['roles:read'])
    const role = await createRole({ slug: 'sorted', permissions: ['users:write', 'audit:read', 'roles:read'] })

    const body = await (await call('/roles', token)).json<{ data: { id: string; permissions: string[] }[] }>()

    expect(body.data.find((entry) => entry.id === role.id)?.permissions).toEqual([
      'audit:read',
      'roles:read',
      'users:write',
    ])
  })

  it('refuses a caller without roles:read', async () => {
    const { token } = await callerWith(['users:read'])

    const response = await call('/roles', token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: roles:read' })
  })
})

describe('POST /admin/roles', () => {
  it('creates a global role with the requested permissions', async () => {
    const { token } = await callerWith(['roles:write'])

    const response = await call('/roles', token, {
      method: 'POST',
      body: JSON.stringify({
        slug: 'editor',
        name: 'Editor',
        description: 'Edits things',
        permissions: ['users:read', 'audit:read'],
      }),
    })
    const body = await response.json<{ data: { id: string; permissions: string[] } }>()

    expect(response.status).toBe(201)
    expect(body.data).toMatchObject({
      slug: 'editor',
      name: 'Editor',
      description: 'Edits things',
      application_id: null,
      is_default: false,
      permissions: ['audit:read', 'users:read'],
    })

    const grants = await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, body.data.id))
    expect(grants).toHaveLength(2)
  })

  it('creates a role scoped to one application', async () => {
    const { token } = await callerWith(['roles:write'])

    const response = await call('/roles', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'cms-editor', name: 'CMS Editor', application_id: SEED.cmsAppId, is_default: true }),
    })
    const body = await response.json<{ data: { id: string } }>()

    expect(response.status).toBe(201)
    const [row] = await db().select().from(roles).where(eq(roles.id, body.data.id))
    expect(row).toMatchObject({ applicationId: SEED.cmsAppId, isDefault: true })
  })

  it('lets the same slug exist once globally and once per application', async () => {
    const { token } = await callerWith(['roles:write'])
    const create = (body: Record<string, unknown>) => call('/roles', token, { method: 'POST', body: JSON.stringify(body) })

    expect((await create({ slug: 'shared', name: 'Global' })).status).toBe(201)
    expect((await create({ slug: 'shared', name: 'Web', application_id: SEED.webAppId })).status).toBe(201)
    expect((await create({ slug: 'shared', name: 'CMS', application_id: SEED.cmsAppId })).status).toBe(201)
  })

  it('refuses a duplicate slug inside the same scope', async () => {
    const { token } = await callerWith(['roles:write'])
    await call('/roles', token, { method: 'POST', body: JSON.stringify({ slug: 'dupe', name: 'First' }) })

    const response = await call('/roles', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'dupe', name: 'Second' }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      code: 409,
      error: 'A role with that slug already exists in this scope',
    })
  })

  it('refuses to reuse a seeded global slug', async () => {
    const { token } = await callerWith(['roles:write'])

    expect((await call('/roles', token, { method: 'POST', body: JSON.stringify({ slug: 'admin', name: 'x' }) })).status).toBe(409)
  })

  it('refuses an unknown application', async () => {
    const { token } = await callerWith(['roles:write'])

    const response = await call('/roles', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'orphan', name: 'Orphan', application_id: 'no-such-app' }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Application not found' })
  })

  it('refuses an unknown permission slug and names it', async () => {
    const { token } = await callerWith(['roles:write'])

    const response = await call('/roles', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'bad-perms', name: 'Bad', permissions: ['users:read', 'invented:permission'] }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Unknown permissions: invented:permission' })
  })

  it('validates the slug shape and the name length', async () => {
    const { token } = await callerWith(['roles:write'])
    const create = (body: Record<string, unknown>) => call('/roles', token, { method: 'POST', body: JSON.stringify(body) })

    for (const slug of ['Upper', 'a', '-leading', 'has space', 'a'.repeat(64), '']) {
      expect((await create({ slug, name: 'Name' })).status).toBe(400)
    }
    expect((await create({ slug: 'ok-slug', name: '' })).status).toBe(400)
    expect((await create({ slug: 'ok-slug', name: 'a'.repeat(121) })).status).toBe(400)
  })

  it('refuses a caller with only roles:read', async () => {
    const { token } = await callerWith(['roles:read'])

    const response = await call('/roles', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'nope', name: 'Nope' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: roles:write' })
  })
})

describe('GET /admin/permissions', () => {
  it('lists the seeded permissions', async () => {
    const { token } = await callerWith(['roles:read'])

    const body = await (await call('/permissions', token)).json<{ data: { slug: string }[] }>()

    expect(body.data).toHaveLength(11)
    expect(body.data.map((permission) => permission.slug)).toEqual(
      expect.arrayContaining(['users:read', 'users:write', 'roles:read', 'sessions:revoke', 'audit:read']),
    )
  })

  it('refuses a caller without roles:read', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call('/permissions', token)).status).toBe(403)
  })
})

describe('POST /admin/roles/:id/permissions', () => {
  it('attaches a permission, and does so idempotently', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ slug: 'attach-target' })

    const first = await call(`/roles/${role.id}/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'audit:read' }),
    })
    const second = await call(`/roles/${role.id}/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'audit:read' }),
    })

    expect(first.status).toBe(204)
    expect(second.status).toBe(204)
    expect(await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id))).toHaveLength(1)
  })

  it('answers 404 for an unknown role or an unknown permission', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ slug: 'attach-404' })

    const unknownRole = await call(`/roles/${crypto.randomUUID()}/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'audit:read' }),
    })
    expect(unknownRole.status).toBe(404)
    await expect(unknownRole.json()).resolves.toMatchObject({ error: 'Role not found' })

    const unknownPermission = await call(`/roles/${role.id}/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'invented' }),
    })
    expect(unknownPermission.status).toBe(404)
    await expect(unknownPermission.json()).resolves.toMatchObject({ error: 'Permission not found' })
  })

  it('reaches the holders of the role on their next request', async () => {
    const caller = await callerWith(['roles:write'])
    const role = await createRole({ slug: 'promoted' })
    const holder = await signIn({ roleIds: [role.id] })

    await call(`/roles/${role.id}/permissions`, caller.token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'audit:read' }),
    })

    const me = await SELF.fetch('https://auth.internal/me', { headers: { Authorization: `Bearer ${holder.token}` } })
    await expect(me.json()).resolves.toMatchObject({ data: { permissions: ['audit:read'] } })
  })

  it('refuses a caller with only roles:read', async () => {
    const { token } = await callerWith(['roles:read'])
    const role = await createRole({ slug: 'attach-denied' })

    expect(
      (await call(`/roles/${role.id}/permissions`, token, {
        method: 'POST',
        body: JSON.stringify({ permission_slug: 'audit:read' }),
      })).status,
    ).toBe(403)
  })
})

describe('DELETE /admin/roles/:id/permissions/:slug', () => {
  it('detaches the permission from that role only', async () => {
    const { token } = await callerWith(['roles:write'])
    const [target, other] = await Promise.all([
      createRole({ slug: 'detach-a', permissions: ['audit:read', 'users:read'] }),
      createRole({ slug: 'detach-b', permissions: ['audit:read'] }),
    ])

    const response = await call(`/roles/${target.id}/permissions/audit:read`, token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, target.id))).toHaveLength(1)
    expect(await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, other.id))).toHaveLength(1)
  })

  it('answers 404 for a permission slug that does not exist', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ slug: 'detach-404' })

    const response = await call(`/roles/${role.id}/permissions/invented`, token, { method: 'DELETE' })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Permission not found' })
  })

  it('answers 204 when the role never had the permission', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ slug: 'detach-noop' })

    expect((await call(`/roles/${role.id}/permissions/audit:read`, token, { method: 'DELETE' })).status).toBe(204)
  })

  it('can strip a permission off the seeded admin role, which is the point of redefinable roles', async () => {
    const { token } = await callerWith(['roles:write'])
    const [permission] = await db().select().from(permissions).where(eq(permissions.slug, 'audit:read'))

    await call(`/roles/${SEED.adminRoleId}/permissions/audit:read`, token, { method: 'DELETE' })

    const rows = await db()
      .select()
      .from(rolePermissions)
      .where(and(eq(rolePermissions.roleId, SEED.adminRoleId), eq(rolePermissions.permissionId, permission?.id ?? '')))
    expect(rows).toHaveLength(0)

    // Put it back so the rest of the file still sees a complete admin role.
    await db().insert(rolePermissions).values({ roleId: SEED.adminRoleId, permissionId: permission?.id ?? '' })
  })

  it('refuses a caller with only roles:read', async () => {
    const { token } = await callerWith(['roles:read'])
    const role = await createRole({ slug: 'detach-denied' })

    expect((await call(`/roles/${role.id}/permissions/audit:read`, token, { method: 'DELETE' })).status).toBe(403)
  })
})
