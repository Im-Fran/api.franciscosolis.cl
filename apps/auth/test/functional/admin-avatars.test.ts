import { SELF, env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, avatarUploads, users } from '@/db/schema'
import { approveAvatar, avatarUrl, createAvatarUpload } from '@/services/avatars'
import { createRole, createUser, db, signIn } from '../helpers/db'
import { JPEG_BYTES, PNG_BYTES } from '../helpers/images'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

/** A signed-in caller holding exactly the named permissions. */
const callerWith = async (permissions: string[]) => {
  const role = await createRole({ slug: `avatar-caller-${crypto.randomUUID().slice(0, 8)}`, permissions })
  return signIn({ roleIds: [role.id] })
}

/** An account with one upload waiting for a decision. */
const pendingUpload = async (bytes = PNG_BYTES, contentType = 'image/png') => {
  const user = await createUser({ name: 'Ada Lovelace' })
  const upload = await createAvatarUpload(db(), env, { userId: user.id, bytes, contentType })
  return { user, upload }
}

describe('GET /admin/avatars', () => {
  it('lists what is waiting, with the account and a preview of the bytes', async () => {
    const { token } = await callerWith(['avatars:read'])
    const { user, upload } = await pendingUpload()

    const response = await call('/avatars', token)

    expect(response.status).toBe(200)
    const body = await response.json<{
      data: { id: string; user_id: string; user_email: string; preview: string | null; url: string | null }[]
    }>()
    const row = body.data.find((entry) => entry.id === upload.id)
    expect(row).toMatchObject({ user_id: user.id, user_email: user.email, url: null })
    // A pending upload has no public address, so the reviewer is handed the bytes inline instead.
    expect(row?.preview?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('filters by status and by account', async () => {
    const { token } = await callerWith(['avatars:read'])
    const reviewer = await createUser()
    const { user, upload } = await pendingUpload()
    await approveAvatar(db(), env, upload, reviewer.id)
    const other = await pendingUpload(JPEG_BYTES, 'image/jpeg')

    const approved = await (await call('/avatars?status=approved', token)).json<{ data: { id: string }[] }>()
    expect(approved.data.map((row) => row.id)).toContain(upload.id)
    expect(approved.data.map((row) => row.id)).not.toContain(other.upload.id)

    const mine = await (await call(`/avatars?status=approved&user_id=${user.id}`, token)).json<{
      data: { user_id: string }[]
    }>()
    expect(mine.data.every((row) => row.user_id === user.id)).toBe(true)
  })

  it('refuses a caller without avatars:read', async () => {
    const { token } = await callerWith(['users:read'])

    expect((await call('/avatars', token)).status).toBe(403)
  })

  it('needs a token', async () => {
    expect((await call('/avatars')).status).toBe(401)
  })
})

describe('POST /admin/avatars/:id/approve', () => {
  it('publishes the upload onto the account and makes it readable', async () => {
    const { token, user: reviewer } = await callerWith(['avatars:read', 'avatars:review'])
    const { user, upload } = await pendingUpload()

    const response = await call(`/avatars/${upload.id}/approve`, token, { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'approved', url: avatarUrl(env, upload.id), reviewed_by: reviewer.id },
    })

    const [account] = await db().select().from(users).where(eq(users.id, user.id))
    expect(account?.picture).toBe(avatarUrl(env, upload.id))

    const served = await SELF.fetch(`https://auth.internal/avatars/${upload.id}`)
    expect(served.status).toBe(200)

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, reviewer.id), eq(auditLogs.event, 'avatar.approved')))
    expect(entry).toBeTruthy()
  })

  it('refuses a caller who may only read the queue', async () => {
    const { token } = await callerWith(['avatars:read'])
    const { upload } = await pendingUpload()

    expect((await call(`/avatars/${upload.id}/approve`, token, { method: 'POST' })).status).toBe(403)
  })

  it('404s on an id nobody uploaded', async () => {
    const { token } = await callerWith(['avatars:review'])

    expect(
      (await call('/avatars/00000000-0000-4000-8000-000000000000/approve', token, { method: 'POST' })).status,
    ).toBe(404)
  })

  it('409s on an upload whose image is gone', async () => {
    const { token } = await callerWith(['avatars:review'])
    const { upload } = await pendingUpload()
    const { supersedeAvatar } = await import('@/services/avatars')
    await supersedeAvatar(db(), env, upload)

    expect((await call(`/avatars/${upload.id}/approve`, token, { method: 'POST' })).status).toBe(409)
  })
})

describe('POST /admin/avatars/:id/reject', () => {
  it('refuses the upload, keeps the reason and deletes the image', async () => {
    const { token } = await callerWith(['avatars:review'])
    const { upload } = await pendingUpload()

    const response = await call(`/avatars/${upload.id}/reject`, token, {
      method: 'POST',
      body: JSON.stringify({ reason: '  Not a portrait  ' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { status: 'rejected', review_note: 'Not a portrait' } })

    const [row] = await db().select().from(avatarUploads).where(eq(avatarUploads.id, upload.id))
    expect(row?.objectKey).toBeNull()
  })

  it('takes a published avatar down', async () => {
    const { token, user: reviewer } = await callerWith(['avatars:review'])
    const { user, upload } = await pendingUpload()
    await approveAvatar(db(), env, upload, reviewer.id)

    const response = await call(`/avatars/${upload.id}/reject`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    })

    expect(response.status).toBe(200)
    const [account] = await db().select().from(users).where(eq(users.id, user.id))
    expect(account?.picture).toBeNull()
    expect((await SELF.fetch(`https://auth.internal/avatars/${upload.id}`)).status).toBe(404)
  })

  it('refuses a caller without avatars:review', async () => {
    const { token } = await callerWith(['avatars:read'])
    const { upload } = await pendingUpload()

    expect(
      (await call(`/avatars/${upload.id}/reject`, token, { method: 'POST', body: JSON.stringify({}) })).status,
    ).toBe(403)
  })
})
