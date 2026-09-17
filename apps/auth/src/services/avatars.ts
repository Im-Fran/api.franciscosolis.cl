import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { avatarUploads, users } from '@/db/schema'
import type { Env } from '@/env'
import { generateId } from '@/lib/crypto'

type AvatarUpload = typeof avatarUploads.$inferSelect

/**
 * Magic-byte signatures of the formats an avatar may be in.
 *
 * The upload's own `Content-Type` is never what decides: it is a string the browser wrote and the
 * uploader can rewrite, and this Worker later serves the object back from its own origin with that
 * type on it. Sniffing the first bytes instead means a file that claims to be a PNG and is actually
 * an HTML document is refused at the door rather than becoming a same-origin page.
 */
const SIGNATURES: readonly { type: string; matches: (bytes: Uint8Array) => boolean }[] = [
  {
    type: 'image/png',
    matches: (bytes) =>
      bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  {
    type: 'image/jpeg',
    matches: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    // RIFF container whose form type is WEBP: 'RIFF' <4 size bytes> 'WEBP'.
    type: 'image/webp',
    matches: (bytes) =>
      bytes.length > 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50,
  },
]

/** The media type the bytes actually are, or null when they are none of the accepted formats. */
const sniffImageType = (bytes: Uint8Array): string | null =>
  SIGNATURES.find((signature) => signature.matches(bytes))?.type ?? null

/**
 * Key of an upload's object in the bucket.
 *
 * Prefixed by the account so everything one person ever uploaded can be listed — and deleted —
 * without consulting the database, which is what makes an account deletion something the bucket can
 * be brought back in step with after the row cascade has already happened.
 */
const objectKeyFor = (userId: string, uploadId: string) => `avatars/${userId}/${uploadId}`

/**
 * Public URL of an approved avatar.
 *
 * Built from `AUTH_PUBLIC_URL` for the same reason magic links are: behind the gateway's service
 * binding the incoming request URL is an internal one, so the address a browser can actually reach
 * is configuration, not something derivable from the request.
 */
const avatarUrl = (env: Env, uploadId: string) => `${env.AUTH_PUBLIC_URL}/avatars/${uploadId}`

/** Whether a stored picture is one of ours, as opposed to a URL a provider handed us. */
const isManagedAvatarUrl = (env: Env, picture: string | null) =>
  picture !== null && picture.startsWith(`${env.AUTH_PUBLIC_URL}/avatars/`)

/** How an upload is described to its owner and to a reviewer. Never exposes the object key. */
const toPublicAvatar = (env: Env, upload: AvatarUpload) => ({
  id: upload.id,
  user_id: upload.userId,
  status: upload.status,
  content_type: upload.contentType,
  size: upload.size,
  /** Only an approved upload has an address; a pending one is deliberately unreachable. */
  url: upload.status === 'approved' ? avatarUrl(env, upload.id) : null,
  review_note: upload.reviewNote,
  reviewed_by: upload.reviewedBy,
  reviewed_at: upload.reviewedAt?.toISOString() ?? null,
  created_at: upload.createdAt.toISOString(),
  updated_at: upload.updatedAt.toISOString(),
})

/** The newest upload of this user in one of the given states, or null. */
const findLatestByStatus = async (
  db: Database,
  userId: string,
  status: AvatarUpload['status'],
): Promise<AvatarUpload | null> => {
  const [row] = await db
    .select()
    .from(avatarUploads)
    .where(and(eq(avatarUploads.userId, userId), eq(avatarUploads.status, status)))
    .orderBy(desc(avatarUploads.createdAt))
    .limit(1)
  return row ?? null
}

const findAvatarById = async (db: Database, id: string): Promise<AvatarUpload | null> => {
  const [row] = await db.select().from(avatarUploads).where(eq(avatarUploads.id, id)).limit(1)
  return row ?? null
}

/**
 * Drops an upload's object from the bucket and forgets its key.
 *
 * Deleting the bytes rather than only the row is the point of the whole feature: a picture nobody
 * approved, or one an administrator took down, must stop existing, not merely stop being linked.
 * The row survives so the decision remains auditable.
 */
const discardObject = async (db: Database, env: Env, upload: AvatarUpload) => {
  if (upload.objectKey) {
    await env.AVATARS.delete(upload.objectKey)
  }
  await db
    .update(avatarUploads)
    .set({ objectKey: null, updatedAt: new Date() })
    .where(eq(avatarUploads.id, upload.id))
}

/** Retires an upload a newer one replaces: its status becomes `superseded` and its object goes. */
const supersedeAvatar = async (db: Database, env: Env, upload: AvatarUpload) => {
  await db
    .update(avatarUploads)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(eq(avatarUploads.id, upload.id))
  await discardObject(db, env, { ...upload, status: 'superseded' })
}

/**
 * Stores a new upload and parks it for review.
 *
 * Any pending upload of the same user is superseded first, so the queue never holds two pictures
 * from one person: the newest is the one they mean, and a reviewer deciding on an older one would
 * be deciding about something the user has already replaced. An already-approved avatar is left
 * alone — it stays the account's picture until this one is approved in its turn, rather than the
 * account going blank for as long as the review takes.
 */
const createAvatarUpload = async (
  db: Database,
  env: Env,
  input: { userId: string; bytes: Uint8Array; contentType: string },
) => {
  const pending = await findLatestByStatus(db, input.userId, 'pending')
  if (pending) {
    await supersedeAvatar(db, env, pending)
  }

  const id = generateId()
  const objectKey = objectKeyFor(input.userId, id)
  const now = new Date()

  await env.AVATARS.put(objectKey, input.bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: { userId: input.userId, uploadId: id },
  })

  const upload: AvatarUpload = {
    id,
    userId: input.userId,
    objectKey,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(avatarUploads).values(upload)

  return upload
}

/**
 * Publishes an upload: it becomes the account's picture and, from this moment, readable.
 *
 * Writing the URL onto `users.picture` is what makes an approval visible everywhere at once — the
 * profile, the id_token, `/oauth/userinfo` and every application reading them — instead of only on
 * the screens that happen to know about this table.
 */
const approveAvatar = async (db: Database, env: Env, upload: AvatarUpload, reviewerId: string) => {
  const previous = await findLatestByStatus(db, upload.userId, 'approved')
  if (previous && previous.id !== upload.id) {
    await supersedeAvatar(db, env, previous)
  }

  const now = new Date()
  await db
    .update(avatarUploads)
    .set({ status: 'approved', reviewedBy: reviewerId, reviewedAt: now, reviewNote: null, updatedAt: now })
    .where(eq(avatarUploads.id, upload.id))

  await db.update(users).set({ picture: avatarUrl(env, upload.id), updatedAt: now }).where(eq(users.id, upload.userId))

  return { ...upload, status: 'approved', reviewedBy: reviewerId, reviewedAt: now, reviewNote: null, updatedAt: now }
}

/**
 * Refuses an upload. The bytes go, the reason stays: a rejection the user cannot read is one they
 * can only answer by uploading the same picture again.
 *
 * Rejecting an avatar that is currently published also takes it off the account — that is what a
 * take-down is — and leaves the profile with no picture rather than falling back to an older one,
 * which would silently republish something a reviewer never looked at again.
 */
const rejectAvatar = async (
  db: Database,
  env: Env,
  upload: AvatarUpload,
  reviewerId: string,
  note: string | null,
) => {
  const now = new Date()
  await db
    .update(avatarUploads)
    .set({ status: 'rejected', reviewedBy: reviewerId, reviewedAt: now, reviewNote: note, updatedAt: now })
    .where(eq(avatarUploads.id, upload.id))
  await discardObject(db, env, upload)

  if (upload.status === 'approved') {
    await clearManagedPicture(db, env, upload.userId)
  }

  return { ...upload, status: 'rejected', reviewedBy: reviewerId, reviewedAt: now, reviewNote: note, updatedAt: now }
}

/**
 * Clears `users.picture` when it points at an avatar of ours.
 *
 * A picture that came from a provider (a Google profile photo) is left where it is: it was never
 * moderated here, and wiping it would turn "remove the avatar you uploaded" into "lose the picture
 * your provider gives you", which is not what either the user or the reviewer asked for.
 */
const clearManagedPicture = async (db: Database, env: Env, userId: string) => {
  const [user] = await db.select({ picture: users.picture }).from(users).where(eq(users.id, userId)).limit(1)
  if (!user || !isManagedAvatarUrl(env, user.picture)) {
    return
  }
  await db.update(users).set({ picture: null, updatedAt: new Date() }).where(eq(users.id, userId))
}

export {
  approveAvatar,
  avatarUrl,
  clearManagedPicture,
  createAvatarUpload,
  discardObject,
  findAvatarById,
  findLatestByStatus,
  isManagedAvatarUrl,
  objectKeyFor,
  rejectAvatar,
  sniffImageType,
  supersedeAvatar,
  toPublicAvatar,
}
export type { AvatarUpload }
