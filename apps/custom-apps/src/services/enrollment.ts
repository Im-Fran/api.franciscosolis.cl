import { and, eq } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'
import type { Database } from '@/db/client'
import { appKeys, auditLogs, installations } from '@/db/schema'
import { CHANNELS, PLATFORMS, TOKENS } from '@/lib/config'
import { isUniqueViolation } from '@/lib/errors'
import { hashToken, randomToken, TOKEN_PREFIXES } from '@/lib/tokens'
import { auditRow } from '@/services/audit'
import type { AppKeyRow, AppRow, InstallationRow } from '@/services/serialize'

/**
 * Enrollment and token refresh: how a device becomes an installation and stays one.
 *
 * Enrollment is auto-approved by decision. Anybody holding an app's public key gets a token, so the
 * defences are around it rather than in front of it: the token is good for exactly one revocable
 * installation, enrollment is rate limited per IP and per app (in the route), and every new
 * installation is flagged `needs_review` until somebody looks at it in the panel.
 */

const optionalField = (max: number) => v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(max))))

const enrollBodySchema = v.object({
  app_key: v.pipe(v.string(), v.trim(), v.minLength(8), v.maxLength(128)),
  /**
   * Stable per device and per app: a hardware id, a machine GUID, Android's per-app id, or a random
   * id a browser keeps in storage. Enrolling twice with the same one is a re-enrollment, not a second
   * installation — which is how a device that lost its token recovers.
   */
  device_id: v.pipe(v.string(), v.trim(), v.minLength(8), v.maxLength(128)),
  platform: v.picklist(PLATFORMS),
  os_name: optionalField(64),
  os_version: optionalField(64),
  arch: optionalField(32),
  hostname: optionalField(255),
  app_version: optionalField(64),
  alias: optionalField(120),
  channel: v.optional(v.picklist(CHANNELS)),
})
type EnrollBody = v.InferOutput<typeof enrollBodySchema>

const refreshBodySchema = v.object({
  refresh_token: v.pipe(v.string(), v.trim(), v.minLength(8), v.maxLength(256)),
})

type IssuedTokens = {
  accessToken: string
  accessTokenExpiresAt: Date
  refreshToken: string
  refreshTokenExpiresAt: Date
}

/** A fresh pair, and the hashed columns that store it. The plaintext only ever leaves in the response. */
const issueTokens = async (now: Date) => {
  const accessToken = randomToken(TOKEN_PREFIXES.access)
  const refreshToken = randomToken(TOKEN_PREFIXES.refresh)
  const tokens: IssuedTokens = {
    accessToken,
    accessTokenExpiresAt: new Date(now.getTime() + TOKENS.accessTtlSeconds * 1000),
    refreshToken,
    refreshTokenExpiresAt: new Date(now.getTime() + TOKENS.refreshTtlSeconds * 1000),
  }
  const columns = {
    accessTokenHash: await hashToken(accessToken),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenHash: await hashToken(refreshToken),
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  }
  return { tokens, columns }
}

type EnrollContext = {
  app: AppRow
  key: AppKeyRow
  body: EnrollBody
  ip: string | null
  userAgent: string | null
  now?: Date
}

type EnrollResult = { installation: InstallationRow; tokens: IssuedTokens; created: boolean }

const findByDevice = async (db: Database, appId: string, deviceId: string) =>
  (await db.select().from(installations).where(and(eq(installations.appId, appId), eq(installations.deviceId, deviceId))).limit(1))[0] ??
  null

/**
 * Enrolls a device, or re-enrolls one this app already knows.
 *
 * A re-enrollment rotates the tokens and refreshes what the device reports about itself, and keeps
 * everything the panel decided: the alias, the channel, the review. A device that was revoked is
 * refused — revocation is meant to stick, and letting the same device id straight back in with the
 * public key would make it a suggestion.
 */
const enroll = async (db: Database, context: EnrollContext): Promise<EnrollResult> => {
  const now = context.now ?? new Date()
  const { app, key, body } = context
  const { tokens, columns } = await issueTokens(now)
  const userAgent = body.platform === 'web' ? context.userAgent?.slice(0, 512) ?? null : null

  const reenroll = async (existing: InstallationRow): Promise<EnrollResult> => {
    if (existing.status === 'revoked') {
      throw new HTTPException(403, { message: 'This installation has been revoked and cannot enroll again' })
    }
    const versionChanged = body.app_version != null && body.app_version !== existing.appVersion
    const [installation] = await db.batch([
      db
        .update(installations)
        .set({
          ...columns,
          platform: body.platform,
          osName: body.os_name ?? existing.osName,
          osVersion: body.os_version ?? existing.osVersion,
          arch: body.arch ?? existing.arch,
          hostname: body.hostname ?? existing.hostname,
          userAgent: userAgent ?? existing.userAgent,
          appVersion: body.app_version ?? existing.appVersion,
          previousAppVersion: versionChanged ? existing.appVersion : existing.previousAppVersion,
          alias: existing.alias ?? body.alias ?? null,
          lastIp: context.ip,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(installations.id, existing.id))
        .returning(),
      db.update(appKeys).set({ lastUsedAt: now }).where(eq(appKeys.id, key.id)),
      db.insert(auditLogs).values(
        auditRow({
          event: 'installation.reenrolled',
          resourceType: 'installation',
          resourceId: existing.id,
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { app_id: app.id, key_id: key.id, device_id: body.device_id },
        }),
      ),
    ])
    return { installation: installation[0]!, tokens, created: false }
  }

  const existing = await findByDevice(db, app.id, body.device_id)
  if (existing) {
    return reenroll(existing)
  }

  const id = crypto.randomUUID()
  try {
    const [inserted] = await db.batch([
      db
        .insert(installations)
        .values({
          id,
          appId: app.id,
          deviceId: body.device_id,
          alias: body.alias ?? null,
          platform: body.platform,
          osName: body.os_name ?? null,
          osVersion: body.os_version ?? null,
          arch: body.arch ?? null,
          hostname: body.hostname ?? null,
          userAgent,
          appVersion: body.app_version ?? null,
          channel: body.channel ?? 'stable',
          needsReview: true,
          enrolledWithKeyId: key.id,
          enrolledIp: context.ip,
          enrolledAt: now,
          lastIp: context.ip,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
          ...columns,
        })
        .returning(),
      db.update(appKeys).set({ lastUsedAt: now }).where(eq(appKeys.id, key.id)),
      db.insert(auditLogs).values(
        auditRow({
          event: 'installation.enrolled',
          resourceType: 'installation',
          resourceId: id,
          ip: context.ip,
          userAgent: context.userAgent,
          metadata: { app_id: app.id, key_id: key.id, device_id: body.device_id, platform: body.platform },
        }),
      ),
    ])
    return { installation: inserted[0]!, tokens, created: true }
  } catch (error) {
    // Two enrollments of the same device racing: the loser finds the winner's row and re-enrolls it.
    if (isUniqueViolation(error)) {
      const winner = await findByDevice(db, app.id, body.device_id)
      if (winner) {
        return reenroll(winner)
      }
    }
    throw error
  }
}

/**
 * Exchanges a refresh token for a new pair. Both rotate, so a refresh token works once: a copy used
 * after the device has refreshed finds nothing. A device whose answer was lost in transit is left
 * holding a dead token, and recovers by enrolling again under the same device id.
 */
const refresh = async (db: Database, appId: string, refreshToken: string, ip: string | null, now: Date = new Date()) => {
  const [row] = await db
    .select()
    .from(installations)
    .where(and(eq(installations.refreshTokenHash, await hashToken(refreshToken)), eq(installations.appId, appId)))
    .limit(1)
  if (!row || row.status !== 'active' || !row.refreshTokenExpiresAt || row.refreshTokenExpiresAt.getTime() <= now.getTime()) {
    return null
  }
  const { tokens, columns } = await issueTokens(now)
  const [installation] = await db
    .update(installations)
    // Conditional on the hash still being the one presented, so two refreshes racing cannot both win.
    .set({ ...columns, lastIp: ip, updatedAt: now })
    .where(and(eq(installations.id, row.id), eq(installations.refreshTokenHash, row.refreshTokenHash!)))
    .returning()
  return installation ? { installation, tokens } : null
}

export { enroll, enrollBodySchema, issueTokens, refresh, refreshBodySchema }
export type { EnrollBody, IssuedTokens }
