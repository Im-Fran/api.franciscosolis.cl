import { SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs } from '@/db/schema'
import { getSettings, updateSettings } from '@/services/settings'
import { createRole, db, signIn } from '../helpers/db'

const call = (token: string | undefined, init: RequestInit = {}) =>
  SELF.fetch('https://auth.internal/admin/settings', {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

/** A signed-in caller holding exactly the named permissions. */
const callerWith = async (permissions: string[]) => {
  const role = await createRole({ slug: `settings-caller-${crypto.randomUUID().slice(0, 8)}`, permissions })
  return signIn({ roleIds: [role.id] })
}

const patch = (token: string, body: Record<string, unknown>) =>
  call(token, { method: 'PATCH', body: JSON.stringify(body) })

describe('GET /admin/settings', () => {
  it('answers the seeded settings', async () => {
    const { token } = await callerWith(['settings:read'])

    const response = await call(token)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 200, data: { registration_open: false } })
  })

  it('needs a token', async () => {
    expect((await call(undefined)).status).toBe(401)
  })

  it('needs settings:read', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call(token)).status).toBe(403)
  })
})

describe('PATCH /admin/settings', () => {
  it('opens registration, answers the whole set and records who did it', async () => {
    const { token, user } = await callerWith(['settings:read', 'settings:write'])

    const response = await patch(token, { registration_open: true })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ code: 200, data: { registration_open: true } })
    await expect(getSettings(db())).resolves.toEqual({ registration_open: true })

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.event, 'settings.updated'), eq(auditLogs.userId, user.id)))
    expect(JSON.parse(entry?.metadata ?? '{}')).toEqual({ setting: 'registration_open', from: false, to: true })

    await updateSettings(db(), { registration_open: false }, null)
  })

  it('records nothing when the value is the one already stored', async () => {
    const { token, user } = await callerWith(['settings:write'])

    expect((await patch(token, { registration_open: false })).status).toBe(200)

    const entries = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.event, 'settings.updated'), eq(auditLogs.userId, user.id)))
    expect(entries).toHaveLength(0)
  })

  it('refuses a value that is not a boolean', async () => {
    const { token } = await callerWith(['settings:write'])

    expect((await patch(token, { registration_open: 'yes' })).status).toBe(400)
  })

  it('needs settings:write, not merely settings:read', async () => {
    const { token } = await callerWith(['settings:read'])

    expect((await patch(token, { registration_open: true })).status).toBe(403)
    await expect(getSettings(db())).resolves.toEqual({ registration_open: false })
  })
})
