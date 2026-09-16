import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { auditLogs } from '@/db/schema'
import { generateId } from '@/lib/crypto'
import { AUDIT_EVENTS } from '@/services/audit'
import { createApplication, createRole, createUser, db, signIn } from '../helpers/db'

const call = (path: string, token?: string) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

const callerWith = async (granted: string[]) => {
  const role = await createRole({ slug: `caller-${crypto.randomUUID().slice(0, 8)}`, permissions: granted })
  return signIn({ roleIds: [role.id] })
}

type Entry = {
  id: string
  event: string
  user_id: string | null
  user_email: string | null
  application_id: string | null
  application_name: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

/** Writes a row straight into the trail, which is append-only and has no route that creates one. */
const record = async (input: {
  event: string
  userId?: string | null
  applicationId?: string | null
  metadata?: string | null
  createdAt?: Date
}) => {
  const row = {
    id: generateId(),
    event: input.event,
    userId: input.userId ?? null,
    applicationId: input.applicationId ?? null,
    ip: null,
    userAgent: null,
    metadata: input.metadata ?? null,
    createdAt: input.createdAt ?? new Date(Math.floor(Date.now() / 1000) * 1000),
  }
  await db().insert(auditLogs).values(row)
  return row
}

describe('GET /admin/audit', () => {
  it('returns entries newest first, with the account and application resolved', async () => {
    const { token } = await callerWith(['audit:read'])
    const user = await createUser({ email: `audit-${crypto.randomUUID()}@example.test` })
    const application = await createApplication({ name: 'Audited application' })
    const written = await record({
      event: 'user.disabled',
      userId: user.id,
      applicationId: application.id,
      metadata: JSON.stringify({ by: 'somebody' }),
    })

    const body = await (await call('/audit?limit=200', token)).json<{ data: Entry[] }>()
    const entry = body.data.find((row) => row.id === written.id)

    expect(entry).toMatchObject({
      event: 'user.disabled',
      user_id: user.id,
      user_email: user.email,
      application_id: application.id,
      application_name: 'Audited application',
      metadata: { by: 'somebody' },
    })

    const timestamps = body.data.map((row) => Date.parse(row.created_at))
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a))
  })

  it('filters by event, by account and by application, combining them with AND', async () => {
    const { token } = await callerWith(['audit:read'])
    const user = await createUser()
    const other = await createUser()
    const application = await createApplication()

    const wanted = await record({ event: 'token.revoked', userId: user.id, applicationId: application.id })
    const wrongEvent = await record({ event: 'token.issued', userId: user.id, applicationId: application.id })
    const wrongUser = await record({ event: 'token.revoked', userId: other.id, applicationId: application.id })

    const ids = async (query: string) =>
      (await (await call(`/audit?${query}&limit=200`, token)).json<{ data: Entry[] }>()).data.map((row) => row.id)

    expect(await ids(`event=token.revoked&user_id=${user.id}&application_id=${application.id}`)).toEqual([wanted.id])
    expect(await ids(`user_id=${user.id}`)).toEqual(expect.arrayContaining([wanted.id, wrongEvent.id]))
    expect(await ids(`user_id=${user.id}`)).not.toContain(wrongUser.id)
  })

  it('filters by an inclusive time range', async () => {
    const { token } = await callerWith(['audit:read'])
    const user = await createUser()
    const old = await record({ event: 'token.issued', userId: user.id, createdAt: new Date('2020-01-01T00:00:00Z') })
    const recent = await record({ event: 'token.issued', userId: user.id, createdAt: new Date('2030-01-01T00:00:00Z') })

    const ids = async (query: string) =>
      (await (await call(`/audit?user_id=${user.id}&${query}`, token)).json<{ data: Entry[] }>()).data.map((r) => r.id)

    expect(await ids('from=2025-01-01T00:00:00.000Z')).toEqual([recent.id])
    expect(await ids('to=2025-01-01T00:00:00.000Z')).toEqual([old.id])
    expect(await ids('from=2019-01-01T00:00:00.000Z&to=2031-01-01T00:00:00.000Z')).toEqual([recent.id, old.id])
  })

  it('pages with limit and offset', async () => {
    const { token } = await callerWith(['audit:read'])
    const user = await createUser()
    await record({ event: 'token.issued', userId: user.id })
    await record({ event: 'token.refreshed', userId: user.id })

    const page = async (query: string) =>
      (await (await call(`/audit?user_id=${user.id}&${query}`, token)).json<{ data: Entry[] }>()).data

    expect(await page('limit=1')).toHaveLength(1)
    expect(await page('limit=1&offset=1')).toHaveLength(1)
    expect((await page('limit=1'))[0]?.id).not.toBe((await page('limit=1&offset=1'))[0]?.id)
  })

  it('degrades a row whose metadata no longer parses instead of failing the page', async () => {
    const { token } = await callerWith(['audit:read'])
    const user = await createUser()
    const broken = await record({ event: 'token.issued', userId: user.id, metadata: 'not json at all' })

    const body = await (await call(`/audit?user_id=${user.id}`, token)).json<{ data: Entry[] }>()

    expect(body.data.find((row) => row.id === broken.id)?.metadata).toBeNull()
  })

  it('rejects an event name that is not in the catalog', async () => {
    const { token } = await callerWith(['audit:read'])

    expect((await call('/audit?event=not.an.event', token)).status).toBe(400)
  })

  it('refuses a caller without audit:read', async () => {
    const { token } = await callerWith(['users:read'])

    const response = await call('/audit', token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: audit:read' })
  })
})

describe('GET /admin/audit/events', () => {
  it('returns the Worker\'s own closed set, so a filter built from it always matches', async () => {
    const { token } = await callerWith(['audit:read'])

    const body = await (await call('/audit/events', token)).json<{ data: string[] }>()

    expect(body.data).toEqual([...AUDIT_EVENTS])
    expect(body.data).toContain('invitation.resent')
  })

  it('refuses a caller without audit:read', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call('/audit/events', token)).status).toBe(403)
  })
})
