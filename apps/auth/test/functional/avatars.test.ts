import { SELF, env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, avatarUploads, users } from '@/db/schema'
import { approveAvatar, avatarUrl, createAvatarUpload } from '@/services/avatars'
import { createUser, db, signIn } from '../helpers/db'
import { avatarForm, GIF_BYTES, JPEG_BYTES, PNG_BYTES } from '../helpers/images'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })

/** Uploads a file the way the account screen does, as multipart with a `file` part. */
const upload = (token: string, body: FormData) => call('/me/avatar', token, { method: 'POST', body })

describe('POST /me/avatar', () => {
  it('accepts an image and answers 202 with it waiting for review', async () => {
    const { token, user } = await signIn()

    const response = await upload(token, avatarForm(PNG_BYTES))

    expect(response.status).toBe(202)
    const body = await response.json<{ data: { id: string; status: string; url: string | null; size: number } }>()
    expect(body.data).toMatchObject({ status: 'pending', url: null, size: PNG_BYTES.byteLength })

    const [row] = await db().select().from(avatarUploads).where(eq(avatarUploads.id, body.data.id))
    expect(row).toMatchObject({ userId: user.id, status: 'pending', contentType: 'image/png' })

    // The account's picture only changes when a reviewer says so.
    const [account] = await db().select().from(users).where(eq(users.id, user.id))
    expect(account?.picture).toBeNull()

    const [entry] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, user.id), eq(auditLogs.event, 'avatar.uploaded')))
    expect(entry).toBeTruthy()
  })

  it('reads the format from the bytes, not from the part\'s Content-Type', async () => {
    const { token } = await signIn()

    const response = await upload(token, avatarForm(JPEG_BYTES, 'portrait.png', 'image/png'))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ data: { content_type: 'image/jpeg' } })
  })

  it('refuses a format that is not one of the three', async () => {
    const { token } = await signIn()

    const response = await upload(token, avatarForm(GIF_BYTES, 'party.gif', 'image/gif'))

    expect(response.status).toBe(400)
  })

  it('refuses a document dressed as an image', async () => {
    const { token } = await signIn()
    const html = new TextEncoder().encode('<!doctype html><script>alert(document.domain)</script>')

    const response = await upload(token, avatarForm(html, 'avatar.png', 'image/png'))

    expect(response.status).toBe(400)
  })

  it('refuses a file over the limit', async () => {
    const { token } = await signIn()
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1)
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const response = await upload(token, avatarForm(oversized))

    expect(response.status).toBe(413)
  })

  it('refuses an empty file and a body that is not multipart', async () => {
    const { token } = await signIn()

    expect((await upload(token, avatarForm(new Uint8Array()))).status).toBe(400)
    expect(
      (
        await call('/me/avatar', token, {
          method: 'POST',
          body: JSON.stringify({ file: 'https://evil.test/a.png' }),
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(415)
  })

  it('needs a token', async () => {
    expect((await call('/me/avatar', undefined, { method: 'POST', body: avatarForm(PNG_BYTES) })).status).toBe(401)
  })
})

describe('GET /me/avatar', () => {
  it('reports what is published, what is waiting and the limits', async () => {
    const { token, user } = await signIn()
    await upload(token, avatarForm(PNG_BYTES))

    const response = await call('/me/avatar', token)

    expect(response.status).toBe(200)
    const body = await response.json<{
      data: { current: unknown; pending: { status: string }; limits: { max_bytes: number; content_types: string[] } }
    }>()
    expect(body.data.current).toBeNull()
    expect(body.data.pending).toMatchObject({ status: 'pending', user_id: user.id, url: null })
    expect(body.data.limits).toEqual({
      max_bytes: 2 * 1024 * 1024,
      content_types: ['image/png', 'image/jpeg', 'image/webp'],
    })
  })

  it('shows the last refusal and its reason', async () => {
    const user = await createUser()
    const { token } = await signIn({ user })
    const pending = await createAvatarUpload(db(), env, {
      userId: user.id,
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })
    const reviewer = await createUser()
    const { rejectAvatar } = await import('@/services/avatars')
    await rejectAvatar(db(), env, pending, reviewer.id, 'Not a portrait')

    const body = await (await call('/me/avatar', token)).json<{ data: { rejected: { review_note: string } } }>()

    expect(body.data.rejected).toMatchObject({ status: 'rejected', review_note: 'Not a portrait' })
  })
})

describe('DELETE /me/avatar', () => {
  it('withdraws a pending upload and takes a published one down', async () => {
    const user = await createUser()
    const { token } = await signIn({ user })
    const published = await createAvatarUpload(db(), env, {
      userId: user.id,
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })
    await approveAvatar(db(), env, published, user.id)
    await upload(token, avatarForm(JPEG_BYTES))

    expect((await call('/me/avatar', token, { method: 'DELETE' })).status).toBe(204)

    const rows = await db().select().from(avatarUploads).where(eq(avatarUploads.userId, user.id))
    expect(rows.every((row) => row.status === 'superseded' && row.objectKey === null)).toBe(true)
    const [account] = await db().select().from(users).where(eq(users.id, user.id))
    expect(account?.picture).toBeNull()
  })

  it('leaves a picture that came from a provider alone', async () => {
    const user = await createUser({ picture: 'https://lh3.googleusercontent.com/a/abc' })
    const { token } = await signIn({ user })

    expect((await call('/me/avatar', token, { method: 'DELETE' })).status).toBe(204)

    const [account] = await db().select().from(users).where(eq(users.id, user.id))
    expect(account?.picture).toBe('https://lh3.googleusercontent.com/a/abc')
  })
})

describe('GET /avatars/:id', () => {
  it('serves an approved avatar to anybody, with no token at all', async () => {
    const user = await createUser()
    const row = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, row, user.id)

    const response = await call(`/avatars/${row.id}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toContain('immutable')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('answers 304 when the caller already has it', async () => {
    const user = await createUser()
    const row = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, row, user.id)

    const first = await call(`/avatars/${row.id}`)
    const etag = first.headers.get('ETag') as string
    const second = await call(`/avatars/${row.id}`, undefined, { headers: { 'If-None-Match': etag } })

    expect(second.status).toBe(304)
  })

  it('does not serve an upload that is only pending', async () => {
    const user = await createUser()
    const row = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })

    expect((await call(`/avatars/${row.id}`)).status).toBe(404)
  })

  it('stops serving one that was taken down', async () => {
    const user = await createUser()
    const reviewer = await createUser()
    const row = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, row, reviewer.id)
    expect((await call(`/avatars/${row.id}`)).status).toBe(200)

    const { rejectAvatar } = await import('@/services/avatars')
    const [approved] = await db().select().from(avatarUploads).where(eq(avatarUploads.id, row.id))
    await rejectAvatar(db(), env, approved, reviewer.id, 'Taken down')

    expect((await call(`/avatars/${row.id}`)).status).toBe(404)
  })

  it('404s on an id nobody uploaded', async () => {
    expect((await call('/avatars/00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })

  it('is the URL an approval writes onto the account', async () => {
    const user = await createUser()
    const row = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, row, user.id)

    const [account] = await db().select().from(users).where(eq(users.id, user.id))
    expect(account?.picture).toBe(avatarUrl(env, row.id))
    expect(new URL(account?.picture as string).pathname.endsWith(`/avatars/${row.id}`)).toBe(true)
  })
})
