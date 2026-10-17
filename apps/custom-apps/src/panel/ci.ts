import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { apps, auditLogs, ciTokens, releases } from '@/db/schema'
import type { AppEnv } from '@/env'
import { ARCHES, CHANNELS, PLATFORMS, RELEASES } from '@/lib/config'
import { isUniqueViolation } from '@/lib/errors'
import { isSemver } from '@/lib/semver'
import { hashToken, TOKEN_PREFIXES } from '@/lib/tokens'
import { validate } from '@/lib/validate'
import { isUuid } from '@/lib/validation'
import { bearerToken } from '@/middleware/admin'
import { invalidToken } from '@/middleware/installation'
import { auditRow } from '@/services/audit'
import { toRelease, verifyReleaseSignature } from '@/services/releases'
import { dataSchema, jsonContent } from '@/panel/shared'

/**
 * The one panel-host route that does not take a panel token: CI uploading a release.
 *
 * Mounted ahead of the `/v1` gate in `src/index.ts`, so `requireAdmin` never sees it — and it accepts
 * nothing but a CI token of the app in the path, so no panel token can reach it either. A CI token
 * can do this and only this.
 *
 * **The body is the artifact**, not a form: CI sends `curl --data-binary @build.msi` with the metadata
 * in the query string and the signature in a header. Nothing is buffered. The request is split in two
 * as it arrives — one half streams into R2, the other through SHA-256 — so a 96 MB installer never sits
 * in the Worker's 128 MB of memory. Once both finish, the digest is checked against the signature and
 * the app's public key; a build the devices would refuse is deleted before it is ever recorded.
 */
const app = new Hono<AppEnv>()

const uploadQuery = v.object({
  version: v.pipe(v.string(), v.trim(), v.maxLength(64), v.check(isSemver, 'must be a semantic version, e.g. 1.4.0')),
  channel: v.optional(v.picklist(CHANNELS), 'stable'),
  platform: v.picklist(PLATFORMS),
  arch: v.picklist(ARCHES),
  filename: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200), v.regex(/^[\w.+-]+$/, 'letters, digits, `.`, `_`, `+` and `-` only')),
  min_version: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64), v.check(isSemver, 'must be a semantic version'))),
  notes: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(RELEASES.maxNotesLength))),
})

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

app.post(
  '/apps/:appId/releases/upload',
  describeRoute({
    description: `Uploads a release from CI as a **draft**, authenticated with a CI token of the app (\`Authorization: Bearer cic_…\`), never a panel token. The body is the artifact itself (at most ${RELEASES.maxArtifactBytes / (1024 * 1024)} MB, \`Content-Length\` required); \`version\`, \`platform\`, \`arch\`, \`filename\`, and optionally \`channel\` (default \`stable\`), \`min_version\` and \`notes\` go in the query. \`X-Signature\` carries the Ed25519 signature, base64, over the **raw 32-byte SHA-256 digest** of the artifact, made with the private key whose public half is the app's \`release_public_key\`; it is verified before the release is recorded, and \`X-Sha256\` (hex), when sent, is checked too. A person publishes the draft from the panel.`,
    tags: ['Releases'],
    responses: {
      201: { description: 'Uploaded as a draft', content: jsonContent(dataSchema(v.looseObject({ id: v.string() }), 201)) },
      401: { description: 'Missing, unknown or revoked CI token' },
      409: { description: 'That version already exists on that line, or the app has no release key' },
      411: { description: 'Content-Length is required' },
      413: { description: 'The artifact is too large' },
      422: { description: 'The signature or the checksum does not match' },
    },
  }),
  validate('query', uploadQuery),
  async (c) => {
    const appId = c.req.param('appId') ?? ''
    const token = bearerToken(c.req.header('Authorization'))
    if (!token || !token.startsWith(TOKEN_PREFIXES.ci) || !isUuid(appId)) {
      throw invalidToken('A Bearer CI token of this app is required')
    }
    const db = getDb(c.env)
    const [ci] = await db
      .select()
      .from(ciTokens)
      .where(and(eq(ciTokens.tokenHash, await hashToken(token)), eq(ciTokens.appId, appId), isNull(ciTokens.revokedAt)))
      .limit(1)
    if (!ci) throw invalidToken('The CI token is invalid, revoked or belongs to another app')

    const [appRow] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1)
    if (!appRow) throw invalidToken('The CI token is invalid, revoked or belongs to another app')
    if (!appRow.releasePublicKey) {
      throw new HTTPException(409, { message: 'This app has no release public key yet; set one in the panel before uploading' })
    }

    const query = c.req.valid('query')
    const signature = c.req.header('X-Signature')?.trim()
    if (!signature) throw new HTTPException(422, { message: 'X-Signature is required: Ed25519 over the SHA-256 digest, base64' })
    const length = Number(c.req.header('Content-Length') ?? Number.NaN)
    if (!Number.isInteger(length) || length <= 0) throw new HTTPException(411, { message: 'Content-Length is required' })
    if (length > RELEASES.maxArtifactBytes) throw new HTTPException(413, { message: `Artifacts are limited to ${RELEASES.maxArtifactBytes} bytes` })
    const body = c.req.raw.body
    if (!body) throw new HTTPException(411, { message: 'The artifact is the request body' })

    const line = and(
      eq(releases.appId, appId),
      eq(releases.channel, query.channel),
      eq(releases.platform, query.platform),
      eq(releases.arch, query.arch),
      eq(releases.version, query.version),
    )
    const [existing] = await db.select({ id: releases.id }).from(releases).where(line).limit(1)
    if (existing) throw new HTTPException(409, { message: `${query.version} already exists for ${query.channel}/${query.platform}/${query.arch}` })

    const id = crypto.randomUUID()
    const objectKey = `releases/${appId}/${id}/${query.filename}`
    const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim() || 'application/octet-stream'

    // One half into R2 at its declared length, the other through SHA-256, both as the bytes arrive.
    const [toBucket, toDigest] = body.tee()
    const sized = new FixedLengthStream(length)
    const digest = new crypto.DigestStream('SHA-256')
    let stored: R2Object | null
    let digestBuffer: ArrayBuffer
    try {
      ;[stored, digestBuffer] = await Promise.all([
        (async () => {
          const pipe = toBucket.pipeTo(sized.writable)
          const put = c.env.RELEASES.put(objectKey, sized.readable, { httpMetadata: { contentType } })
          await pipe
          return put
        })(),
        toDigest.pipeTo(digest).then(() => digest.digest),
      ])
    } catch (error) {
      await c.env.RELEASES.delete(objectKey)
      console.error('release upload failed while streaming', error)
      throw new HTTPException(400, { message: 'The upload did not complete: the body ended before Content-Length, or the connection dropped' })
    }

    const refuse = async (message: string) => {
      await c.env.RELEASES.delete(objectKey)
      return new HTTPException(422, { message })
    }
    if (!stored || stored.size !== length) throw await refuse('The stored artifact does not match Content-Length')
    const sha256 = hex(digestBuffer)
    const declared = c.req.header('X-Sha256')?.trim().toLowerCase()
    if (declared && declared !== sha256) throw await refuse(`X-Sha256 does not match: the artifact hashes to ${sha256}`)
    if (!(await verifyReleaseSignature(appRow.releasePublicKey, new Uint8Array(digestBuffer), signature))) {
      throw await refuse("The signature does not verify against the app's release public key")
    }

    try {
      await db.batch([
        db.insert(releases).values({
          id,
          appId,
          version: query.version,
          channel: query.channel,
          platform: query.platform,
          arch: query.arch,
          status: 'draft',
          minVersion: query.min_version ?? null,
          notes: query.notes ?? null,
          objectKey,
          filename: query.filename,
          contentType,
          sizeBytes: length,
          sha256,
          signature,
          uploadedBy: `ci:${ci.id}`,
        }),
        db.update(ciTokens).set({ lastUsedAt: new Date() }).where(eq(ciTokens.id, ci.id)),
        db.insert(auditLogs).values(
          auditRow({
            event: 'release.uploaded',
            resourceType: 'app',
            resourceId: appId,
            ip: c.req.header('CF-Connecting-IP') ?? null,
            userAgent: c.req.header('User-Agent') ?? null,
            metadata: { release_id: id, ci_token_id: ci.id, version: query.version, channel: query.channel, platform: query.platform, arch: query.arch, sha256, size_bytes: length },
          }),
        ),
      ])
    } catch (error) {
      await c.env.RELEASES.delete(objectKey)
      if (isUniqueViolation(error)) throw new HTTPException(409, { message: `${query.version} already exists for ${query.channel}/${query.platform}/${query.arch}` })
      throw error
    }
    const [row] = await db.select().from(releases).where(eq(releases.id, id))
    return c.json({ code: 201 as const, data: toRelease(row!) }, 201)
  },
)

export { app as ci }
