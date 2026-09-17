import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { avatarUploads, users } from '@/db/schema'
import {
  approveAvatar,
  avatarUrl,
  clearManagedPicture,
  createAvatarUpload,
  findLatestByStatus,
  isManagedAvatarUrl,
  objectKeyFor,
  rejectAvatar,
  sniffImageType,
  supersedeAvatar,
  toPublicAvatar,
} from '@/services/avatars'
import { createUser, db } from '../helpers/db'
import { GIF_BYTES, JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from '../helpers/images'

describe('sniffImageType', () => {
  it('reads the format out of the bytes', () => {
    expect(sniffImageType(PNG_BYTES)).toBe('image/png')
    expect(sniffImageType(JPEG_BYTES)).toBe('image/jpeg')
    expect(sniffImageType(WEBP_BYTES)).toBe('image/webp')
  })

  it('refuses a format that is not one of the three, whatever it claims to be', () => {
    expect(sniffImageType(GIF_BYTES)).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('<!doctype html><script>alert(1)</script>'))).toBeNull()
  })

  it('refuses bytes too short to carry a signature', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(sniffImageType(new Uint8Array())).toBeNull()
  })

  it('does not take a RIFF container that is not WEBP for one', () => {
    const riffWave = new Uint8Array(PNG_BYTES.length)
    riffWave.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    expect(sniffImageType(riffWave)).toBeNull()
  })
})

describe('avatar URLs', () => {
  it('builds the public URL from AUTH_PUBLIC_URL, not from the request', () => {
    expect(avatarUrl(env, 'abc')).toBe(`${env.AUTH_PUBLIC_URL}/avatars/abc`)
  })

  it('tells one of ours apart from a picture a provider handed us', () => {
    expect(isManagedAvatarUrl(env, avatarUrl(env, 'abc'))).toBe(true)
    expect(isManagedAvatarUrl(env, 'https://lh3.googleusercontent.com/a/abc')).toBe(false)
    expect(isManagedAvatarUrl(env, null)).toBe(false)
  })

  it('keys an object under the account that uploaded it', () => {
    expect(objectKeyFor('user-1', 'upload-1')).toBe('avatars/user-1/upload-1')
  })
})

describe('createAvatarUpload', () => {
  it('stores the bytes and parks the row for review', async () => {
    const user = await createUser()

    const upload = await createAvatarUpload(db(), env, {
      userId: user.id,
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })

    expect(upload.status).toBe('pending')
    expect(upload.size).toBe(PNG_BYTES.byteLength)
    await expect(env.AVATARS.get(upload.objectKey as string)).resolves.not.toBeNull()

    // Nothing is published by uploading: the account's picture is untouched and the row has no URL.
    expect(toPublicAvatar(env, upload).url).toBeNull()
    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBeNull()
  })

  it('replaces a previous pending upload instead of queueing a second one', async () => {
    const user = await createUser()
    const first = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    const second = await createAvatarUpload(db(), env, { userId: user.id, bytes: JPEG_BYTES, contentType: 'image/jpeg' })

    const rows = await db().select().from(avatarUploads).where(eq(avatarUploads.userId, user.id))
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(await findLatestByStatus(db(), user.id, 'pending')).toMatchObject({ id: second.id })

    // The superseded upload's bytes are gone, not merely unlinked.
    const superseded = rows.find((row) => row.id === first.id)
    expect(superseded?.status).toBe('superseded')
    expect(superseded?.objectKey).toBeNull()
    await expect(env.AVATARS.get(objectKeyFor(user.id, first.id))).resolves.toBeNull()
  })

  it('leaves a published avatar in place while the new one waits', async () => {
    const user = await createUser()
    const published = await createAvatarUpload(db(), env, {
      userId: user.id,
      bytes: PNG_BYTES,
      contentType: 'image/png',
    })
    await approveAvatar(db(), env, published, user.id)

    await createAvatarUpload(db(), env, { userId: user.id, bytes: JPEG_BYTES, contentType: 'image/jpeg' })

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBe(avatarUrl(env, published.id))
  })
})

describe('approveAvatar', () => {
  it('publishes the upload onto the account', async () => {
    const user = await createUser()
    const reviewer = await createUser()
    const upload = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })

    const approved = await approveAvatar(db(), env, upload, reviewer.id)

    expect(approved.status).toBe('approved')
    expect(approved.reviewedBy).toBe(reviewer.id)
    expect(toPublicAvatar(env, approved).url).toBe(avatarUrl(env, upload.id))

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBe(avatarUrl(env, upload.id))
  })

  it('retires the avatar it replaces, bytes and all', async () => {
    const user = await createUser()
    const reviewer = await createUser()
    const first = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, first, reviewer.id)

    const second = await createAvatarUpload(db(), env, { userId: user.id, bytes: JPEG_BYTES, contentType: 'image/jpeg' })
    await approveAvatar(db(), env, second, reviewer.id)

    const [old] = await db().select().from(avatarUploads).where(eq(avatarUploads.id, first.id))
    expect(old?.status).toBe('superseded')
    await expect(env.AVATARS.get(objectKeyFor(user.id, first.id))).resolves.toBeNull()

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBe(avatarUrl(env, second.id))
  })
})

describe('rejectAvatar', () => {
  it('keeps the reason and deletes the image', async () => {
    const user = await createUser()
    const reviewer = await createUser()
    const upload = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })

    const rejected = await rejectAvatar(db(), env, upload, reviewer.id, 'Not a portrait')

    expect(rejected).toMatchObject({ status: 'rejected', reviewNote: 'Not a portrait', reviewedBy: reviewer.id })
    await expect(env.AVATARS.get(objectKeyFor(user.id, upload.id))).resolves.toBeNull()
  })

  it('takes a published avatar off the account', async () => {
    const user = await createUser()
    const reviewer = await createUser()
    const upload = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, upload, reviewer.id)

    const [approvedRow] = await db().select().from(avatarUploads).where(eq(avatarUploads.id, upload.id))
    await rejectAvatar(db(), env, approvedRow, reviewer.id, null)

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBeNull()
  })
})

describe('clearManagedPicture', () => {
  it('leaves a provider picture alone', async () => {
    const user = await createUser({ picture: 'https://lh3.googleusercontent.com/a/abc' })

    await clearManagedPicture(db(), env, user.id)

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBe('https://lh3.googleusercontent.com/a/abc')
  })

  it('clears one of ours', async () => {
    const user = await createUser()
    const upload = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await approveAvatar(db(), env, upload, user.id)

    await clearManagedPicture(db(), env, user.id)

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBeNull()
  })
})

describe('supersedeAvatar', () => {
  it('is safe on a row whose object is already gone', async () => {
    const user = await createUser()
    const upload = await createAvatarUpload(db(), env, { userId: user.id, bytes: PNG_BYTES, contentType: 'image/png' })
    await supersedeAvatar(db(), env, upload)

    const [row] = await db().select().from(avatarUploads).where(eq(avatarUploads.id, upload.id))
    await expect(supersedeAvatar(db(), env, row)).resolves.toBeUndefined()
  })
})
