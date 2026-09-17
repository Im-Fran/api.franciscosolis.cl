import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { avatarUploads, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { AVATAR_STATUS } from '@/lib/config'
import { requirePermission } from '@/middleware/auth'
import { getRequestContext, recordAudit } from '@/services/audit'
import { approveAvatar, findAvatarById, rejectAvatar, toPublicAvatar } from '@/services/avatars'

const app = new Hono<AppEnv>()

const listQuerySchema = v.object({
  status: v.optional(v.picklist(AVATAR_STATUS)),
  user_id: v.optional(v.string()),
  limit: v.optional(v.pipe(v.string(), v.regex(/^\d{1,3}$/), v.transform(Number), v.maxValue(200))),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,6}$/), v.transform(Number))),
})

const listResponseSchema = v.object({
  code: v.literal(200),
  data: v.array(
    v.looseObject({
      id: v.string(),
      user_id: v.string(),
      status: v.string(),
      /** Only set for an approved upload; a pending one has no public address. */
      url: v.nullable(v.string()),
      /** Data URL of the bytes, so a reviewer can look at a picture that is not public yet. */
      preview: v.nullable(v.string()),
    }),
  ),
})

/**
 * Bytes of an upload as a `data:` URL, for the review screen.
 *
 * A pending upload has no URL of its own — that is the whole point — so the only way to put it in
 * front of a reviewer is to inline it in the answer they are already authenticated for. It stays
 * cheap because the limit on an avatar is 2 MB, and it is built only for the rows actually listed.
 */
const previewOf = async (env: AppEnv['Bindings'], objectKey: string | null, contentType: string) => {
  if (!objectKey) {
    return null
  }
  const object = await env.AVATARS.get(objectKey)
  if (!object) {
    return null
  }

  const bytes = new Uint8Array(await object.arrayBuffer())
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `data:${contentType};base64,${btoa(binary)}`
}

app.get(
  '/avatars',
  describeRoute({
    description:
      'Avatar uploads, newest first, filtered by `status` (default `pending`) and optionally by `user_id`. Each row carries the account it belongs to and a `preview` data URL of the bytes, because an upload waiting for review has no public address to link to.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Avatar uploads',
        content: { 'application/json': { schema: resolver(listResponseSchema) } },
      },
      403: { description: 'Missing the avatars:read permission' },
    },
  }),
  requirePermission('avatars:read'),
  validator('query', listQuerySchema),
  async (c) => {
    const { status = 'pending', user_id: userId, limit = 50, offset = 0 } = c.req.valid('query')
    const db = getDb(c.env)

    const rows = await db
      .select({
        upload: avatarUploads,
        email: users.email,
        name: users.name,
        picture: users.picture,
      })
      .from(avatarUploads)
      .innerJoin(users, eq(users.id, avatarUploads.userId))
      .where(
        userId
          ? and(eq(avatarUploads.status, status), eq(avatarUploads.userId, userId))
          : eq(avatarUploads.status, status),
      )
      .orderBy(desc(avatarUploads.createdAt))
      .limit(limit)
      .offset(offset)

    return c.json({
      code: 200,
      data: await Promise.all(
        rows.map(async (row) => ({
          ...toPublicAvatar(c.env, row.upload),
          user_email: row.email,
          user_name: row.name,
          user_picture: row.picture,
          preview: await previewOf(c.env, row.upload.objectKey, row.upload.contentType),
        })),
      ),
    })
  },
)

/** The one row a decision is about, or a 404 when the id names nothing. */
const loadUpload = async (db: ReturnType<typeof getDb>, id: string) => {
  const upload = await findAvatarById(db, id)
  if (!upload) {
    throw new HTTPException(404, { message: 'Avatar upload not found' })
  }
  return upload
}

app.post(
  '/avatars/:id/approve',
  describeRoute({
    description:
      'Publishes an upload: it becomes readable at its public URL and is written onto the account as its picture, replacing whatever avatar was published before.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The approved upload' },
      403: { description: 'Missing the avatars:review permission' },
      404: { description: 'No such upload' },
      409: { description: 'The upload has no bytes left to publish' },
    },
  }),
  requirePermission('avatars:review'),
  async (c) => {
    const actor = c.get('actor')
    const db = getDb(c.env)
    const upload = await loadUpload(db, c.req.param('id'))

    if (!upload.objectKey) {
      throw new HTTPException(409, {
        message: 'This upload was withdrawn, replaced or rejected, and its image no longer exists',
      })
    }

    const approved = await approveAvatar(db, c.env, upload, actor.user.id)

    await recordAudit(db, {
      event: 'avatar.approved',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: { avatar_id: upload.id, subject_user_id: upload.userId },
    })

    return c.json({ code: 200, data: toPublicAvatar(c.env, approved) })
  },
)

const rejectSchema = v.object({
  /** Shown to the user, so a refusal is something they can act on rather than only absorb. */
  reason: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(300)))),
})

app.post(
  '/avatars/:id/reject',
  describeRoute({
    description:
      'Refuses an upload and deletes its image. Rejecting one that is currently published is how an avatar is taken down: the account is left with no picture of ours rather than falling back to an older one.',
    tags: ['Admin'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The rejected upload' },
      403: { description: 'Missing the avatars:review permission' },
      404: { description: 'No such upload' },
    },
  }),
  requirePermission('avatars:review'),
  validator('json', rejectSchema),
  async (c) => {
    const actor = c.get('actor')
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const upload = await loadUpload(db, c.req.param('id'))

    const rejected = await rejectAvatar(db, c.env, upload, actor.user.id, body.reason?.trim() || null)

    await recordAudit(db, {
      event: 'avatar.rejected',
      userId: actor.user.id,
      applicationId: actor.applicationId,
      ...getRequestContext(c),
      metadata: {
        avatar_id: upload.id,
        subject_user_id: upload.userId,
        was_published: upload.status === 'approved',
      },
    })

    return c.json({ code: 200, data: toPublicAvatar(c.env, rejected) })
  },
)

export default app
