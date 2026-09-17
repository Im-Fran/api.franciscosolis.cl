import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { avatarUploads } from '@/db/schema'
import type { AppEnv } from '@/env'
import { AVATAR_UPLOAD } from '@/lib/config'
import { requireAuth } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import {
  clearManagedPicture,
  createAvatarUpload,
  findAvatarById,
  findLatestByStatus,
  sniffImageType,
  supersedeAvatar,
  toPublicAvatar,
} from '@/services/avatars'

const app = new Hono<AppEnv>()

/*
 * The `/me` routes in `routes/me.ts` already carry a `/me/*` guard, and both files are mounted at
 * the root of the same Hono app, so this is stated again rather than inherited: which file mounts
 * first is not something an authenticated route should depend on. `requireAuth` running twice costs
 * a repeated lookup on one endpoint and nothing else; the alternative failure mode is an avatar
 * upload quietly becoming public.
 */
app.use('/me/avatar', requireAuth)

const avatarSchema = v.object({
  id: v.string(),
  user_id: v.string(),
  status: v.string(),
  content_type: v.string(),
  size: v.number(),
  url: v.nullable(v.string()),
  review_note: v.nullable(v.string()),
  reviewed_by: v.nullable(v.string()),
  reviewed_at: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
})

const myAvatarResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    /** The avatar currently published on the account, if one of ours is. */
    current: v.nullable(avatarSchema),
    /** An upload waiting for a decision. At most one exists at a time. */
    pending: v.nullable(avatarSchema),
    /** The last refusal, so the screen can say why rather than only that. */
    rejected: v.nullable(avatarSchema),
    limits: v.object({
      max_bytes: v.number(),
      content_types: v.array(v.string()),
    }),
  }),
})

/**
 * Serves an approved avatar.
 *
 * This is the only public route in this file, and the only one that touches the bucket without a
 * token. The status is read from D1 first and an upload that is not `approved` answers 404 — the
 * object of a pending or rejected upload is unreachable even by someone who knows its id, which is
 * what makes "pending review" mean anything at all.
 */
app.get(
  '/avatars/:id',
  describeRoute({
    description:
      'Serves an approved avatar. An upload that is pending, rejected or superseded answers 404: moderation decides what is readable, not whether anybody links to it.',
    tags: ['Avatars'],
    responses: {
      200: { description: 'The image bytes' },
      304: { description: 'The caller already has this avatar' },
      404: { description: 'No approved avatar under this id' },
    },
  }),
  async (c) => {
    const id = c.req.param('id')
    const upload = await findAvatarById(getDb(c.env), id)

    if (!upload || upload.status !== 'approved' || !upload.objectKey) {
      throw new HTTPException(404, { message: 'Avatar not found' })
    }

    const object = await c.env.AVATARS.get(upload.objectKey, {
      // R2 answers the conditional itself, which is what turns a repeat view into a 304 without
      // the bytes ever leaving the bucket.
      onlyIf: c.req.raw.headers,
    })
    if (!object) {
      throw new HTTPException(404, { message: 'Avatar not found' })
    }

    const headers = new Headers({
      'Content-Type': upload.contentType,
      // An avatar is immutable: approving a new picture mints a new id rather than replacing these
      // bytes, so this can be cached for as long as anyone is willing to keep it.
      'Cache-Control': `public, max-age=${AVATAR_UPLOAD.cacheSeconds}, immutable`,
      ETag: object.httpEtag,
      // The bytes were sniffed on upload, but a browser that guesses anyway must not be able to
      // reinterpret them as a document on this origin.
      'X-Content-Type-Options': 'nosniff',
    })

    // `onlyIf` returning an object with no body is R2's way of saying the precondition failed,
    // which for an `If-None-Match` hit is exactly a 304.
    if (!('body' in object)) {
      return c.body(null, 304, Object.fromEntries(headers))
    }

    return c.body(object.body, 200, Object.fromEntries(headers))
  },
)

app.get(
  '/me/avatar',
  describeRoute({
    description:
      'The authenticated user\'s avatar: what is published, what is waiting for review and what was last refused, together with the limits an upload has to satisfy.',
    tags: ['Avatars'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The avatar state of this account',
        content: { 'application/json': { schema: resolver(myAvatarResponseSchema) } },
      },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    const [current, pending, rejected] = await Promise.all([
      findLatestByStatus(db, actor.user.id, 'approved'),
      findLatestByStatus(db, actor.user.id, 'pending'),
      findLatestByStatus(db, actor.user.id, 'rejected'),
    ])

    return c.json({
      code: 200,
      data: {
        current: current ? toPublicAvatar(c.env, current) : null,
        pending: pending ? toPublicAvatar(c.env, pending) : null,
        /* Only worth showing while it is the newest thing that happened to this account. */
        rejected:
          rejected && !pending && (!current || current.createdAt < rejected.createdAt)
            ? toPublicAvatar(c.env, rejected)
            : null,
        limits: { max_bytes: AVATAR_UPLOAD.maxBytes, content_types: [...AVATAR_UPLOAD.contentTypes] },
      },
    })
  },
)

/**
 * Reads the uploaded file out of a `multipart/form-data` body.
 *
 * Multipart rather than a raw body or a base64 field: it is what a `<form>` and a `FormData` both
 * produce, so the browser never has to re-encode the file, and a base64 payload would inflate a
 * 2 MB picture to 2.7 MB of JSON for no gain.
 */
const readUploadedFile = async (request: Request): Promise<File> => {
  const contentType = request.headers.get('Content-Type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new HTTPException(415, { message: 'The avatar must be sent as multipart/form-data' })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new HTTPException(400, { message: 'The multipart body could not be read' })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: 'A `file` part is required' })
  }
  return file
}

app.post(
  '/me/avatar',
  describeRoute({
    description:
      'Uploads a new avatar as `multipart/form-data` with a `file` part. It is stored out of reach and answers 202: nothing is published until an administrator approves it. A previous upload of this account that was still waiting is replaced by this one.',
    tags: ['Avatars'],
    security: [{ bearerAuth: [] }],
    responses: {
      202: {
        description: 'The upload was accepted and is waiting for review',
        content: { 'application/json': { schema: resolver(v.object({ code: v.literal(202), data: avatarSchema })) } },
      },
      400: { description: 'No file, or bytes that are not one of the accepted image formats' },
      401: { description: 'Missing, invalid or revoked access token' },
      413: { description: 'The file is larger than the limit' },
      415: { description: 'The request was not multipart/form-data' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const file = await readUploadedFile(c.req.raw)

    // Checked before reading the body into memory, and again on the bytes themselves below: the
    // declared size is a hint, the measured one is the fact.
    if (file.size > AVATAR_UPLOAD.maxBytes) {
      throw new HTTPException(413, { message: `The avatar must be at most ${AVATAR_UPLOAD.maxBytes} bytes` })
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength === 0) {
      throw new HTTPException(400, { message: 'The uploaded file is empty' })
    }
    if (bytes.byteLength > AVATAR_UPLOAD.maxBytes) {
      throw new HTTPException(413, { message: `The avatar must be at most ${AVATAR_UPLOAD.maxBytes} bytes` })
    }

    const contentType = sniffImageType(bytes)
    if (!contentType) {
      throw new HTTPException(400, {
        message: `The avatar must be one of: ${AVATAR_UPLOAD.contentTypes.join(', ')}`,
      })
    }

    const db = getDb(c.env)
    const upload = await createAvatarUpload(db, c.env, { userId: actor.user.id, bytes, contentType })

    await recordAudit(db, {
      event: 'avatar.uploaded',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { avatar_id: upload.id, content_type: contentType, size: upload.size },
    })

    return c.json({ code: 202, data: toPublicAvatar(c.env, upload) }, 202)
  },
)

app.delete(
  '/me/avatar',
  describeRoute({
    description:
      'Withdraws the authenticated user\'s avatar: an upload waiting for review is cancelled and a published one is taken off the account. A picture that came from a sign-in provider is left alone — it was never uploaded here.',
    tags: ['Avatars'],
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Nothing of this account is uploaded or published any more' },
      401: { description: 'Missing, invalid or revoked access token' },
    },
  }),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)

    const rows = await db
      .select()
      .from(avatarUploads)
      .where(eq(avatarUploads.userId, actor.user.id))
      .orderBy(desc(avatarUploads.createdAt))

    const live = rows.filter((row) => row.status === 'pending' || row.status === 'approved')
    for (const row of live) {
      await supersedeAvatar(db, c.env, row)
    }
    await clearManagedPicture(db, c.env, actor.user.id)

    if (live.length > 0) {
      await recordAudit(db, {
        event: 'avatar.withdrawn',
        userId: actor.user.id,
        applicationId: actor.applicationId,
        ...getRequestContext(c),
        metadata: { avatar_ids: live.map((row) => row.id) },
      })
    }

    return c.body(null, 204)
  },
)

export default app
