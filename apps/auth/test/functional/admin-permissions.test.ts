import { SELF } from 'cloudflare:test'
import { eq, ne } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { permissions, rolePermissions, roles, userRoles } from '@/db/schema'
import { GUARDED_PERMISSIONS } from '@/lib/config'
import { generateId } from '@/lib/crypto'
import { createRole, createUser, db, grant, SEED, signIn } from '../helpers/db'

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

const uniqueSlug = (prefix: string) => `${prefix}:${crypto.randomUUID().slice(0, 8)}`

describe('PATCH /admin/roles/:id', () => {
  it('updates the fields it was given and leaves the rest alone', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ name: 'Before', permissions: ['users:read'] })

    const response = await call(`/roles/${role.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'After', description: 'Now described', is_default: true }),
    })
    const body = await response.json<{ data: { name: string; description: string; is_default: boolean; permissions: string[] } }>()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      name: 'After',
      description: 'Now described',
      is_default: true,
      // Untouched, because `permissions` was not part of the request.
      permissions: ['users:read'],
    })
  })

  it('replaces the whole permission set rather than merging into it', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ permissions: ['users:read', 'users:write'] })

    const body = await (
      await call(`/roles/${role.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ permissions: ['audit:read'] }),
      })
    ).json<{ data: { permissions: string[] } }>()

    expect(body.data.permissions).toEqual(['audit:read'])

    const attached = await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id))
    expect(attached).toHaveLength(1)
  })

  it('leaves the slug and the scope out of reach', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ slug: 'immutable-slug' })

    await call(`/roles/${role.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ slug: 'something-else', application_id: SEED.cmsAppId, name: 'Renamed' }),
    })

    const [stored] = await db().select().from(roles).where(eq(roles.id, role.id))
    expect(stored).toMatchObject({ slug: 'immutable-slug', applicationId: null, name: 'Renamed' })
  })

  it('refuses an unknown permission slug, without touching the ones already attached', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ permissions: ['users:read'] })

    const response = await call(`/roles/${role.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ permissions: ['users:read', 'nope:nope'] }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: 'Unknown permissions: nope:nope' })

    const attached = await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id))
    expect(attached).toHaveLength(1)
  })

  it('404s on a role that does not exist, and refuses a caller without roles:write', async () => {
    const writer = await callerWith(['roles:write'])
    const reader = await callerWith(['roles:read'])
    const role = await createRole()

    expect((await call(`/roles/${generateId()}`, writer.token, { method: 'PATCH', body: '{}' })).status).toBe(404)
    expect((await call(`/roles/${role.id}`, reader.token, { method: 'PATCH', body: '{}' })).status).toBe(403)
  })
})

describe('DELETE /admin/roles/:id', () => {
  it('deletes a role and every grant of it', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ permissions: ['users:read'] })
    const user = await createUser()
    await grant(user.id, role.id)

    const response = await call(`/roles/${role.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await db().select().from(roles).where(eq(roles.id, role.id))).toHaveLength(0)
    expect(await db().select().from(userRoles).where(eq(userRoles.roleId, role.id))).toHaveLength(0)
    expect(await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id))).toHaveLength(0)
  })

  it('takes the deleted role\'s access away on the next request', async () => {
    const admin = await callerWith(['roles:write'])
    const victimRole = await createRole({ permissions: ['users:read'] })
    const victim = await signIn({ roleIds: [victimRole.id] })

    expect((await call('/users', victim.token)).status).toBe(200)

    await call(`/roles/${victimRole.id}`, admin.token, { method: 'DELETE' })

    // Same token, same unexpired session: the permission is re-read from the database every time.
    expect((await call('/users', victim.token)).status).toBe(403)
  })

  it('allows deleting a role that grants roles:write while another account still holds one', async () => {
    const { token } = await callerWith(['roles:write'])
    const spare = await createRole({ permissions: ['roles:write'] })
    await grant((await createUser()).id, spare.id)

    expect((await call(`/roles/${spare.id}`, token, { method: 'DELETE' })).status).toBe(204)
  })

  it('refuses to delete the last role that grants roles:write', async () => {
    const role = await createRole({ permissions: ['roles:write'] })
    const caller = await signIn({ roleIds: [role.id] })

    // The guard counts holders, not roles, so the fixtures the rest of this file left behind have
    // to go for the caller's own role to really be the last one anybody can administer roles with.
    await db().delete(userRoles).where(ne(userRoles.roleId, role.id))

    const response = await call(`/roles/${role.id}`, caller.token, { method: 'DELETE' })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'This is the last role that grants roles:write; grant it elsewhere before deleting this one',
    })
  })

  it('404s on a role that does not exist, and refuses a caller without roles:write', async () => {
    const writer = await callerWith(['roles:write'])
    const reader = await callerWith(['roles:read'])
    const role = await createRole()

    expect((await call(`/roles/${generateId()}`, writer.token, { method: 'PATCH', body: '{}' })).status).toBe(404)
    expect((await call(`/roles/${role.id}`, reader.token, { method: 'PATCH', body: '{}' })).status).toBe(403)
  })
})

describe('DELETE /admin/roles/:id', () => {
  it('deletes a role and every grant of it', async () => {
    const { token } = await callerWith(['roles:write'])
    const role = await createRole({ permissions: ['users:read'] })
    const user = await createUser()
    await grant(user.id, role.id)

    const response = await call(`/roles/${role.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await db().select().from(roles).where(eq(roles.id, role.id))).toHaveLength(0)
    expect(await db().select().from(userRoles).where(eq(userRoles.roleId, role.id))).toHaveLength(0)
    expect(await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id))).toHaveLength(0)
  })

  it('takes the deleted role\'s access away on the next request', async () => {
    const admin = await callerWith(['roles:write'])
    const victimRole = await createRole({ permissions: ['users:read'] })
    const victim = await signIn({ roleIds: [victimRole.id] })

    expect((await call('/users', victim.token)).status).toBe(200)

    await call(`/roles/${victimRole.id}`, admin.token, { method: 'DELETE' })

    // Same token, same unexpired session: the permission is re-read from the database every time.
    expect((await call('/users', victim.token)).status).toBe(403)
  })

  it('404s on a role that does not exist, and refuses a caller without roles:write', async () => {
    const writer = await callerWith(['roles:write'])
    const reader = await callerWith(['roles:read'])
    const role = await createRole()

    expect((await call(`/roles/${generateId()}`, writer.token, { method: 'DELETE' })).status).toBe(404)
    expect((await call(`/roles/${role.id}`, reader.token, { method: 'DELETE' })).status).toBe(403)
  })
})

describe('POST /admin/permissions', () => {
  it('defines a permission a role can then be given', async () => {
    const { token } = await callerWith(['roles:write'])
    const slug = uniqueSlug('reports')

    const response = await call('/permissions', token, {
      method: 'POST',
      body: JSON.stringify({ slug, name: 'Read reports', description: 'For another service' }),
    })
    const body = await response.json<{ data: { id: string; slug: string } }>()

    expect(response.status).toBe(201)
    expect(body.data).toMatchObject({ slug, name: 'Read reports', description: 'For another service' })

    const role = await createRole()
    const attach = await call(`/roles/${role.id}/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: slug }),
    })
    expect(attach.status).toBe(204)
  })

  it('reaches the account holding it through the access token', async () => {
    const admin = await callerWith(['roles:write'])
    const slug = uniqueSlug('cms')
    await call('/permissions', admin.token, { method: 'POST', body: JSON.stringify({ slug, name: 'CMS thing' }) })

    const role = await createRole()
    await call(`/roles/${role.id}/permissions`, admin.token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: slug }),
    })
    const holder = await signIn({ roleIds: [role.id] })

    const body = await (await call('/me', holder.token)).json<{ data: { permissions: string[] } }>()
    expect(body.data.permissions).toContain(slug)
  })

  it('rejects a duplicate slug and a malformed one', async () => {
    const { token } = await callerWith(['roles:write'])

    const duplicate = await call('/permissions', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'users:read', name: 'Clash' }),
    })
    expect(duplicate.status).toBe(409)

    const malformed = await call('/permissions', token, {
      method: 'POST',
      body: JSON.stringify({ slug: 'Not A Slug', name: 'Bad' }),
    })
    expect(malformed.status).toBe(400)
  })

  it('refuses a caller without roles:write', async () => {
    const { token } = await callerWith(['roles:read'])

    const response = await call('/permissions', token, {
      method: 'POST',
      body: JSON.stringify({ slug: uniqueSlug('nope'), name: 'Nope' }),
    })

    expect(response.status).toBe(403)
  })
})

describe('PATCH /admin/permissions/:id', () => {
  it('renames a permission but never its slug', async () => {
    const { token } = await callerWith(['roles:write'])
    const slug = uniqueSlug('renameable')
    const created = await (
      await call('/permissions', token, { method: 'POST', body: JSON.stringify({ slug, name: 'Before' }) })
    ).json<{ data: { id: string } }>()

    const body = await (
      await call(`/permissions/${created.data.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'After', slug: 'hijacked:slug' }),
      })
    ).json<{ data: { slug: string; name: string } }>()

    expect(body.data).toMatchObject({ slug, name: 'After' })
  })

  it('404s on a permission that does not exist', async () => {
    const { token } = await callerWith(['roles:write'])

    expect((await call(`/permissions/${generateId()}`, token, { method: 'PATCH', body: '{}' })).status).toBe(404)
  })
})

describe('DELETE /admin/permissions/:id', () => {
  it('deletes a permission and detaches it from the roles holding it', async () => {
    const { token } = await callerWith(['roles:write'])
    const slug = uniqueSlug('disposable')
    const created = await (
      await call('/permissions', token, { method: 'POST', body: JSON.stringify({ slug, name: 'Disposable' }) })
    ).json<{ data: { id: string } }>()
    const role = await createRole()
    await call(`/roles/${role.id}/permissions`, token, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: slug }),
    })

    const response = await call(`/permissions/${created.data.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await db().select().from(permissions).where(eq(permissions.slug, slug))).toHaveLength(0)
    expect(await db().select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id))).toHaveLength(0)
  })

  it('refuses to delete a slug this Worker guards a route with', async () => {
    const { token } = await callerWith(['roles:write'])
    const rows = await db().select().from(permissions)

    for (const slug of GUARDED_PERMISSIONS) {
      const permission = rows.find((row) => row.slug === slug)
      const response = await call(`/permissions/${permission?.id}`, token, { method: 'DELETE' })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({
        error: `${slug} guards a route of this Worker and cannot be deleted`,
      })
    }
  })

  it('404s on a permission that does not exist, and refuses a caller without roles:write', async () => {
    const writer = await callerWith(['roles:write'])
    const reader = await callerWith(['roles:read'])

    expect((await call(`/permissions/${generateId()}`, writer.token, { method: 'DELETE' })).status).toBe(404)
    expect((await call(`/permissions/${generateId()}`, reader.token, { method: 'DELETE' })).status).toBe(403)
  })
})
