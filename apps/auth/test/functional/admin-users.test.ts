import { SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, sessions, userRoles, users } from '@/db/schema'
import {
  createIdentity,
  createRole,
  createSessionRow,
  createUser,
  db,
  SEED,
  signIn,
  signInAsAdmin,
  uniqueEmail,
} from '../helpers/db'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

/** A signed-in caller holding exactly one permission, for the deny-by-default assertions. */
const callerWith = async (permissions: string[]) => {
  const role = await createRole({ slug: `caller-${crypto.randomUUID().slice(0, 8)}`, permissions })
  return signIn({ roleIds: [role.id] })
}

describe('admin authentication', () => {
  it('refuses every admin route without a token', async () => {
    for (const [path, init] of [
      ['/users', {}],
      ['/users/anything', {}],
      ['/roles', {}],
      ['/permissions', {}],
      ['/applications', {}],
      ['/invitations', {}],
    ] as const) {
      const response = await call(path, undefined, init)
      expect(response.status).toBe(401)
    }
  })

  it('refuses a caller whose account was disabled after the token was issued', async () => {
    const { token, user } = await signInAsAdmin()
    await db().update(users).set({ status: 'disabled' }).where(eq(users.id, user.id))

    expect((await call('/users', token)).status).toBe(403)
  })
})

describe('GET /admin/users', () => {
  it('lists users newest first for a caller with users:read', async () => {
    const { token } = await callerWith(['users:read'])
    const target = await createUser({ email: uniqueEmail('listed') })

    const response = await call('/users', token)
    const body = await response.json<{ data: { id: string; email: string }[] }>()

    expect(response.status).toBe(200)
    expect(body.data.map((row) => row.id)).toContain(target.id)
    expect(body.data[0]).toHaveProperty('email')
  })

  it('never exposes anything beyond the public user shape', async () => {
    const { token } = await callerWith(['users:read'])
    await createUser()

    const body = await (await call('/users', token)).json<{ data: Record<string, unknown>[] }>()

    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
      'created_at',
      'email',
      'email_verified',
      'family_name',
      'given_name',
      'id',
      'last_login_at',
      'locale',
      'name',
      'picture',
      'status',
      'updated_at',
    ])
  })

  it('filters on email and name with a substring match', async () => {
    const { token } = await callerWith(['users:read'])
    const needle = `needle${crypto.randomUUID().slice(0, 8)}`
    const byEmail = await createUser({ email: `${needle}@example.test` })
    const byName = await createUser({ name: `Mr ${needle}` })

    const body = await (await call(`/users?query=${needle}`, token)).json<{ data: { id: string }[] }>()

    expect(body.data.map((row) => row.id).sort()).toEqual([byEmail.id, byName.id].sort())
  })

  it('honours limit and offset', async () => {
    const { token } = await callerWith(['users:read'])
    await Promise.all([createUser(), createUser(), createUser()])

    const first = await (await call('/users?limit=2', token)).json<{ data: unknown[] }>()
    const second = await (await call('/users?limit=2&offset=2', token)).json<{ data: unknown[] }>()

    expect(first.data).toHaveLength(2)
    expect(second.data.length).toBeGreaterThan(0)
  })

  it('rejects a limit above the cap or a non-numeric one', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call('/users?limit=201', token)).status).toBe(400)
    expect((await call('/users?limit=all', token)).status).toBe(400)
    expect((await call('/users?offset=-1', token)).status).toBe(400)
  })

  it('refuses a caller without users:read', async () => {
    const { token } = await callerWith(['roles:read'])

    const response = await call('/users', token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ code: 403, error: 'Missing required permission: users:read' })
  })
})

describe('GET /admin/users/:id', () => {
  it('returns the user with their roles, identities and live sessions', async () => {
    const { token } = await callerWith(['users:read'])
    const target = await createUser({ email: uniqueEmail('detail') })
    const role = await createRole({ slug: 'detail-role', applicationId: SEED.cmsAppId })
    await db().insert(userRoles).values({ userId: target.id, roleId: role.id })
    await createIdentity({ userId: target.id, provider: 'google', providerAccountId: 'sub-detail', email: target.email })
    const live = await createSessionRow({ userId: target.id })
    await createSessionRow({ userId: target.id, revokedAt: new Date() })

    const body = await (await call(`/users/${target.id}`, token)).json<{
      data: {
        user: { id: string }
        roles: { id: string; application_id: string | null }[]
        identities: { provider: string }[]
        sessions: { id: string }[]
      }
    }>()

    expect(body.data.user.id).toBe(target.id)
    expect(body.data.roles).toEqual([
      { id: role.id, slug: 'detail-role', name: 'Test role', application_id: SEED.cmsAppId },
    ])
    expect(body.data.identities).toEqual([
      { id: expect.any(String), provider: 'google', email: target.email, last_used_at: expect.any(String) },
    ])
    expect(body.data.sessions.map((session) => session.id)).toEqual([live.id])
  })

  it('reports a never-used identity with a null timestamp', async () => {
    const { token } = await callerWith(['users:read'])
    const target = await createUser()
    await createIdentity({
      userId: target.id,
      provider: 'magic_link',
      providerAccountId: target.email,
      lastUsedAt: null,
    })

    const body = await (await call(`/users/${target.id}`, token)).json<{
      data: { identities: { last_used_at: string | null }[] }
    }>()

    expect(body.data.identities[0]?.last_used_at).toBeNull()
  })

  it('answers 404 for an unknown id', async () => {
    const { token } = await callerWith(['users:read'])

    const response = await call(`/users/${crypto.randomUUID()}`, token)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ code: 404, error: 'User not found' })
  })

  it('refuses a caller without users:read', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser()

    expect((await call(`/users/${target.id}`, token)).status).toBe(403)
  })
})

describe('PATCH /admin/users/:id', () => {
  it('disables an account and revokes every session it had', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser()
    const [first, second] = await Promise.all([
      createSessionRow({ userId: target.id }),
      createSessionRow({ userId: target.id, applicationId: SEED.cmsAppId }),
    ])

    const response = await call(`/users/${target.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { id: target.id, status: 'disabled' } })

    const rows = await db().select().from(sessions).where(eq(sessions.userId, target.id))
    expect(rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort())
    expect(rows.every((row) => row.revokedReason === 'user_disabled')).toBe(true)
  })

  it('takes effect immediately on the disabled user\'s own requests', async () => {
    const admin = await callerWith(['users:write'])
    const victim = await signIn()

    await call(`/users/${victim.user.id}`, admin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })

    expect((await SELF.fetch('https://auth.internal/me', { headers: { Authorization: `Bearer ${victim.token}` } })).status).toBe(403)
  })

  it('re-enables an account without resurrecting its sessions', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser({ status: 'disabled' })
    const session = await createSessionRow({ userId: target.id, revokedAt: new Date() })

    await call(`/users/${target.id}`, token, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) })

    const [row] = await db().select().from(users).where(eq(users.id, target.id))
    expect(row?.status).toBe('active')
    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(sessionRow?.revokedAt).not.toBeNull()
  })

  it('is a no-op when the status is unchanged or omitted', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser()
    const session = await createSessionRow({ userId: target.id })

    expect((await call(`/users/${target.id}`, token, { method: 'PATCH', body: '{}' })).status).toBe(200)
    expect(
      (await call(`/users/${target.id}`, token, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) })).status,
    ).toBe(200)

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row?.revokedAt).toBeNull()
    expect(await db().select().from(auditLogs).where(eq(auditLogs.userId, target.id))).toHaveLength(0)
  })

  it('rejects a status outside the closed set', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser()

    expect(
      (await call(`/users/${target.id}`, token, { method: 'PATCH', body: JSON.stringify({ status: 'banned' }) })).status,
    ).toBe(400)
  })

  it('answers 404 for an unknown user', async () => {
    const { token } = await callerWith(['users:write'])

    expect(
      (await call(`/users/${crypto.randomUUID()}`, token, { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) }))
        .status,
    ).toBe(404)
  })

  it('refuses a caller with only users:read', async () => {
    const { token } = await callerWith(['users:read'])
    const target = await createUser()

    const response = await call(`/users/${target.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: users:write' })
  })
})

describe('POST /admin/users/:id/roles', () => {
  it('grants a role and records who granted it', async () => {
    const caller = await callerWith(['users:write'])
    const target = await createUser()
    const role = await createRole({ slug: 'granted-role' })

    const response = await call(`/users/${target.id}/roles`, caller.token, {
      method: 'POST',
      body: JSON.stringify({ role_id: role.id }),
    })

    expect(response.status).toBe(204)
    const [row] = await db()
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, target.id), eq(userRoles.roleId, role.id)))
    expect(row?.grantedBy).toBe(caller.user.id)
  })

  it('is a no-op when the user already holds the role', async () => {
    const caller = await callerWith(['users:write'])
    const target = await createUser()
    const role = await createRole({ slug: 'double-granted' })

    await call(`/users/${target.id}/roles`, caller.token, { method: 'POST', body: JSON.stringify({ role_id: role.id }) })
    const second = await call(`/users/${target.id}/roles`, caller.token, {
      method: 'POST',
      body: JSON.stringify({ role_id: role.id }),
    })

    expect(second.status).toBe(204)
    expect(await db().select().from(userRoles).where(eq(userRoles.roleId, role.id))).toHaveLength(1)
  })

  it('takes effect on the target\'s very next request', async () => {
    const caller = await callerWith(['users:write'])
    const victim = await signIn()
    const role = await createRole({ slug: 'live-grant', permissions: ['audit:read'] })

    await call(`/users/${victim.user.id}/roles`, caller.token, {
      method: 'POST',
      body: JSON.stringify({ role_id: role.id }),
    })

    const me = await SELF.fetch('https://auth.internal/me', { headers: { Authorization: `Bearer ${victim.token}` } })
    await expect(me.json()).resolves.toMatchObject({ data: { permissions: ['audit:read'] } })
  })

  it('answers 404 for an unknown user or an unknown role', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser()
    const role = await createRole({ slug: 'exists' })

    const unknownUser = await call(`/users/${crypto.randomUUID()}/roles`, token, {
      method: 'POST',
      body: JSON.stringify({ role_id: role.id }),
    })
    expect(unknownUser.status).toBe(404)
    await expect(unknownUser.json()).resolves.toMatchObject({ error: 'User not found' })

    const unknownRole = await call(`/users/${target.id}/roles`, token, {
      method: 'POST',
      body: JSON.stringify({ role_id: crypto.randomUUID() }),
    })
    expect(unknownRole.status).toBe(404)
    await expect(unknownRole.json()).resolves.toMatchObject({ error: 'Role not found' })
  })

  it('refuses a caller without users:write', async () => {
    const { token } = await callerWith(['users:read'])
    const target = await createUser()

    expect(
      (await call(`/users/${target.id}/roles`, token, { method: 'POST', body: JSON.stringify({ role_id: 'x' }) })).status,
    ).toBe(403)
  })
})

describe('DELETE /admin/users/:id/roles/:roleId', () => {
  it('revokes the grant and takes effect at once', async () => {
    const caller = await callerWith(['users:write'])
    const role = await createRole({ slug: 'revoked-role', permissions: ['audit:read'] })
    const victim = await signIn({ roleIds: [role.id] })

    const response = await call(`/users/${victim.user.id}/roles/${role.id}`, caller.token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await db().select().from(userRoles).where(eq(userRoles.roleId, role.id))).toHaveLength(0)

    const me = await SELF.fetch('https://auth.internal/me', { headers: { Authorization: `Bearer ${victim.token}` } })
    await expect(me.json()).resolves.toMatchObject({ data: { roles: [], permissions: [] } })
  })

  it('answers 204 for a grant that was never there, and touches nothing else', async () => {
    const caller = await callerWith(['users:write'])
    const target = await createUser()
    const kept = await createRole({ slug: 'kept-role' })
    await db().insert(userRoles).values({ userId: target.id, roleId: kept.id })

    const response = await call(`/users/${target.id}/roles/${crypto.randomUUID()}`, caller.token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await db().select().from(userRoles).where(eq(userRoles.userId, target.id))).toHaveLength(1)
  })

  it('refuses a caller without users:write', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call('/users/x/roles/y', token, { method: 'DELETE' })).status).toBe(403)
  })
})

describe('DELETE /admin/users/:id/sessions', () => {
  it('signs the user out of every application and device', async () => {
    const caller = await callerWith(['sessions:revoke'])
    const victim = await signIn()
    const another = await createSessionRow({ userId: victim.user.id, applicationId: SEED.cmsAppId })

    const response = await call(`/users/${victim.user.id}/sessions`, caller.token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    const rows = await db().select().from(sessions).where(eq(sessions.userId, victim.user.id))
    expect(rows.every((row) => row.revokedReason === 'admin_revocation')).toBe(true)
    expect(rows.map((row) => row.id)).toContain(another.id)

    expect((await SELF.fetch('https://auth.internal/me', { headers: { Authorization: `Bearer ${victim.token}` } })).status).toBe(401)
  })

  it('records how many sessions were revoked and by whom', async () => {
    const caller = await callerWith(['sessions:revoke'])
    const target = await createUser()
    await createSessionRow({ userId: target.id })

    await call(`/users/${target.id}/sessions`, caller.token, { method: 'DELETE' })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, target.id))
    expect(JSON.parse(rows[0]?.metadata ?? 'null')).toEqual({ count: 1, by: caller.user.id })
  })

  it('answers 204 for a user with no sessions', async () => {
    const caller = await callerWith(['sessions:revoke'])
    const target = await createUser()

    expect((await call(`/users/${target.id}/sessions`, caller.token, { method: 'DELETE' })).status).toBe(204)
  })

  it('needs sessions:revoke specifically, not users:write', async () => {
    const { token } = await callerWith(['users:write'])
    const target = await createUser()

    const response = await call(`/users/${target.id}/sessions`, token, { method: 'DELETE' })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: sessions:revoke' })
  })
})

describe('the seeded admin role', () => {
  it('opens every admin route it is meant to', async () => {
    const { token } = await signInAsAdmin()
    const target = await createUser()

    for (const path of ['/users', `/users/${target.id}`, '/roles', '/permissions', '/applications', '/invitations']) {
      expect((await call(path, token)).status).toBe(200)
    }
  })
})
