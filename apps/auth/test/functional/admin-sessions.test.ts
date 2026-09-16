import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, refreshTokens, sessions } from '@/db/schema'
import { generateId } from '@/lib/crypto'
import { createApplication, createRole, createSessionRow, createUser, db, SEED, signIn } from '../helpers/db'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

const callerWith = async (granted: string[]) => {
  const role = await createRole({ slug: `caller-${crypto.randomUUID().slice(0, 8)}`, permissions: granted })
  return signIn({ roleIds: [role.id] })
}

type Row = {
  id: string
  application_id: string
  application_name: string | null
  revoked_at: string | null
  revoked_reason: string | null
  last_seen_at: string
}

describe('GET /admin/sessions', () => {
  it('lists every live session, carrying the account and the application of each', async () => {
    const { token } = await callerWith(['sessions:read'])
    const user = await createUser({ name: 'Signed In' })
    const application = await createApplication({ name: 'Somewhere else' })
    const session = await createSessionRow({ userId: user.id, applicationId: application.id })

    const body = await (await call('/sessions?limit=200', token)).json<{
      data: (Row & { user_id: string; user_email: string | null; user_name: string | null })[]
    }>()
    const row = body.data.find((entry) => entry.id === session.id)

    expect(row).toMatchObject({
      user_id: user.id,
      user_email: user.email,
      user_name: 'Signed In',
      application_id: application.id,
      application_name: 'Somewhere else',
    })
  })

  it('narrows by account and by application, and hides revoked sessions by default', async () => {
    const { token } = await callerWith(['sessions:read'])
    const user = await createUser()
    const application = await createApplication()
    const here = await createSessionRow({ userId: user.id, applicationId: application.id })
    const elsewhere = await createSessionRow({ userId: user.id })
    const dead = await createSessionRow({ userId: user.id, revokedAt: new Date() })

    const ids = async (query: string) =>
      (await (await call(`/sessions?${query}&limit=200`, token)).json<{ data: Row[] }>()).data.map((row) => row.id)

    expect(await ids(`user_id=${user.id}`)).toEqual(expect.arrayContaining([here.id, elsewhere.id]))
    expect(await ids(`user_id=${user.id}`)).not.toContain(dead.id)
    expect(await ids(`user_id=${user.id}&application_id=${application.id}`)).toEqual([here.id])
    expect(await ids(`user_id=${user.id}&include_revoked=true`)).toContain(dead.id)
  })

  it('refuses a caller without sessions:read', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call('/sessions', token)).status).toBe(403)
  })
})

describe('GET /admin/users/:id/sessions', () => {
  it('lists the live sessions of a user, named with their application, most recent first', async () => {
    const { token } = await callerWith(['sessions:read'])
    const user = await createUser()
    const application = await createApplication({ name: 'Another client' })

    const older = await createSessionRow({ userId: user.id, lastSeenAt: new Date('2024-01-01T00:00:00Z') })
    const newer = await createSessionRow({
      userId: user.id,
      applicationId: application.id,
      lastSeenAt: new Date('2025-01-01T00:00:00Z'),
    })

    const body = await (await call(`/users/${user.id}/sessions`, token)).json<{ data: Row[] }>()

    expect(body.data.map((row) => row.id)).toEqual([newer.id, older.id])
    expect(body.data[0]).toMatchObject({ application_id: application.id, application_name: 'Another client' })
    expect(body.data[1]?.application_name).toBe('franciscosolis.cl')
  })

  it('hides revoked sessions unless they are asked for', async () => {
    const { token } = await callerWith(['sessions:read'])
    const user = await createUser()
    const live = await createSessionRow({ userId: user.id })
    const dead = await createSessionRow({ userId: user.id, revokedAt: new Date() })

    const ids = async (query = '') =>
      (await (await call(`/users/${user.id}/sessions${query}`, token)).json<{ data: Row[] }>()).data.map((r) => r.id)

    expect(await ids()).toEqual([live.id])
    expect(await ids('?include_revoked=true')).toEqual(expect.arrayContaining([live.id, dead.id]))
  })

  it('refuses a caller without sessions:read', async () => {
    const { token } = await callerWith(['users:read'])
    const user = await createUser()

    const response = await call(`/users/${user.id}/sessions`, token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: sessions:read' })
  })
})

describe('DELETE /admin/sessions/:id', () => {
  it('revokes one session and its refresh chain, leaving the account\'s others alone', async () => {
    const caller = await callerWith(['sessions:revoke'])
    const user = await createUser()
    const target = await createSessionRow({ userId: user.id })
    const untouched = await createSessionRow({ userId: user.id })

    await db().insert(refreshTokens).values({
      id: generateId(),
      sessionId: target.id,
      userId: user.id,
      applicationId: target.applicationId,
      tokenHash: generateId(),
      parentId: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      usedAt: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: new Date(),
    })

    const response = await call(`/sessions/${target.id}`, caller.token, { method: 'DELETE' })

    expect(response.status).toBe(204)

    const [revoked] = await db().select().from(sessions).where(eq(sessions.id, target.id))
    expect(revoked?.revokedAt).not.toBeNull()
    expect(revoked?.revokedReason).toBe('admin_revocation')

    const [survivor] = await db().select().from(sessions).where(eq(sessions.id, untouched.id))
    expect(survivor?.revokedAt).toBeNull()

    const [chain] = await db().select().from(refreshTokens).where(eq(refreshTokens.sessionId, target.id))
    expect(chain?.revokedAt).not.toBeNull()
  })

  it('records who revoked what', async () => {
    const caller = await callerWith(['sessions:revoke'])
    const user = await createUser()
    const target = await createSessionRow({ userId: user.id })

    await call(`/sessions/${target.id}`, caller.token, { method: 'DELETE' })

    const trail = await db().select().from(auditLogs).where(eq(auditLogs.userId, user.id))
    const entry = trail.find((row) => row.event === 'session.revoked')

    expect(entry).toBeTruthy()
    expect(JSON.parse(entry?.metadata as string)).toMatchObject({ session_id: target.id, by: caller.user.id })
  })

  it('reports a session that is already revoked as missing', async () => {
    const { token } = await callerWith(['sessions:revoke'])
    const user = await createUser()
    const dead = await createSessionRow({ userId: user.id, revokedAt: new Date() })

    expect((await call(`/sessions/${dead.id}`, token, { method: 'DELETE' })).status).toBe(404)
    expect((await call(`/sessions/${generateId()}`, token, { method: 'DELETE' })).status).toBe(404)
  })

  it('refuses a caller that may only read sessions', async () => {
    const { token } = await callerWith(['sessions:read'])
    const user = await createUser()
    const target = await createSessionRow({ userId: user.id })

    const response = await call(`/sessions/${target.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: sessions:revoke' })
  })

  it('ends the revoked session\'s own access immediately', async () => {
    const caller = await callerWith(['sessions:revoke'])
    const victim = await signIn({ roleIds: [SEED.adminRoleId] })

    await call(`/sessions/${victim.session.id}`, caller.token, { method: 'DELETE' })

    // The token is still perfectly valid and still unexpired; the session behind it is not.
    expect((await call('/me', victim.token)).status).toBe(401)
  })
})
