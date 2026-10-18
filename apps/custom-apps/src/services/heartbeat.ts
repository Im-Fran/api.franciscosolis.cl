import { eq } from 'drizzle-orm'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { apps, installations } from '@/db/schema'
import type { Env } from '@/env'
import { iso } from '@/lib/json'
import { modulesOf } from '@/services/apps'
import { takeOutstanding } from '@/services/commands'
import { activeMessages } from '@/services/messages'
import { effectiveState, heartbeatCredit, hourlyStatements } from '@/services/presence'
import { offerFor, toOfferSummary } from '@/services/releases'
import { unreadForInstallation } from '@/services/tickets'
import { effectiveLogLevel, etagOf, resolveConfig } from '@/services/remote-config'
import type { AppRow, InstallationRow } from '@/services/serialize'
import { heartbeatLogStatement, heartbeatSampleStatement, snapshotSchema } from '@/services/telemetry'

/**
 * A heartbeat, and the answer to one.
 *
 * Two transports carry heartbeats — `POST /heartbeat` in ping mode, a message down the socket in
 * socket mode — and both land here, so a device's presence, usage hours and audit row are written by
 * the same code whichever way it reports. The answer is the device's to-do list: the state to obey,
 * the presence settings, the commands it has not acknowledged yet, the version tags of its config and
 * messages, so it refetches those only when they changed, and the update waiting for it, if any.
 */

const heartbeatBodySchema = v.object({
  app_version: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(64)))),
  /** Seconds somebody used the app since the previous heartbeat (a visible tab, recent input). */
  active_seconds: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400)))),
  snapshot: v.optional(v.nullable(snapshotSchema)),
})
type HeartbeatBody = v.InferOutput<typeof heartbeatBodySchema>

/** The state an installation is told to obey, in the shape every ingest response carries it. */
const stateFor = (row: AppRow, installation: Pick<InstallationRow, 'stateOverride' | 'stateMessage'> | null) => {
  const override = installation?.stateOverride ?? null
  return {
    state: effectiveState(row.state, override),
    message: override ? (installation?.stateMessage ?? row.stateMessage) : row.stateMessage,
    until: iso(row.stateUntil),
  }
}

const presenceFor = (row: AppRow) => ({ mode: row.presenceMode, interval_seconds: row.heartbeatIntervalSeconds })

/**
 * What the panel has for a device right now. Every part belongs to a module and is null (or empty)
 * when the app does not have it, so a device never learns of features it was not built for.
 */
const directivesFor = async (env: Env, appRow: AppRow, installation: InstallationRow, now: Date = new Date()) => {
  const modules = modulesOf(appRow)
  const db = getDb(env)
  const device = { id: installation.id, channel: installation.channel }
  const [outstanding, config, messageList, offer, supportUnread] = await Promise.all([
    modules.includes('commands') ? takeOutstanding(db, installation.id, now) : Promise.resolve([]),
    modules.includes('config') ? resolveConfig(db, appRow.id, device) : Promise.resolve(null),
    modules.includes('messages') ? activeMessages(db, appRow.id, device, now) : Promise.resolve(null),
    modules.includes('updates') ? offerFor(db, { app: appRow, installation }) : Promise.resolve(null),
    modules.includes('support') ? unreadForInstallation(env.DB, installation.id) : Promise.resolve(null),
  ])
  return {
    state: stateFor(appRow, installation),
    presence: presenceFor(appRow),
    server_time: now.toISOString(),
    commands: outstanding,
    sync: {
      config_etag: config ? await etagOf(config) : null,
      messages_etag: messageList ? await etagOf(messageList) : null,
      log_level: modules.includes('logs') ? effectiveLogLevel(appRow, installation) : null,
      /** Replies from support this installation has not read yet; fetch its tickets when it grows. */
      support_unread: supportUnread,
    },
    /** The release to install, in short — `GET /updates/latest` has the rest. Null with nothing to do. */
    update: toOfferSummary(offer),
  }
}

type Directives = Awaited<ReturnType<typeof directivesFor>>

/** The app and the installation behind a device, or null when either is gone. */
const loadDevice = async (env: Env, installationId: string, appId: string) => {
  const db = getDb(env)
  const [[appRow], [installation]] = await Promise.all([
    db.select().from(apps).where(eq(apps.id, appId)).limit(1),
    db.select().from(installations).where(eq(installations.id, installationId)).limit(1),
  ])
  return appRow && installation ? { appRow, installation } : null
}

type HeartbeatInput = {
  installationId: string
  appId: string
  body: HeartbeatBody
  ip: string | null
  now?: Date
}

/**
 * Records a heartbeat and answers the device's directives, or null when the installation is gone or
 * revoked (the caller answers 401: the device's recovery is to enroll again). The HTTP route has
 * already checked that; a socket, held open across a revocation, relies on this.
 */
const recordHeartbeat = async (env: Env, input: HeartbeatInput): Promise<Directives | null> => {
  const now = input.now ?? new Date()
  const loaded = await loadDevice(env, input.installationId, input.appId)
  if (!loaded || loaded.installation.status !== 'active') return null
  const { appRow, installation } = loaded
  const { body } = input

  const credits = heartbeatCredit(installation.lastSeenAt, now, appRow.heartbeatIntervalSeconds, body.active_seconds)
  const versionChanged = body.app_version != null && body.app_version !== installation.appVersion
  const nowSeconds = Math.floor(now.getTime() / 1000)

  const assignments = ['last_seen_at = ?', 'last_ip = ?', 'updated_at = ?']
  const bindings: unknown[] = [nowSeconds, input.ip ?? installation.lastIp, nowSeconds]
  if (body.snapshot) {
    assignments.push('last_snapshot = ?')
    bindings.push(JSON.stringify(body.snapshot))
  }
  if (versionChanged) {
    assignments.push('app_version = ?', 'previous_app_version = ?')
    bindings.push(body.app_version, installation.appVersion)
  }

  const nowMs = now.getTime()
  const statements = [
    env.DB.prepare(`UPDATE installations SET ${assignments.join(', ')} WHERE id = ?`).bind(...bindings, installation.id),
    ...hourlyStatements(env.DB, installation.id, appRow.id, credits),
    heartbeatLogStatement(env.DB, {
      installationId: installation.id,
      appId: appRow.id,
      receivedAtMs: nowMs,
      ip: input.ip,
      appVersion: body.app_version ?? null,
      activeSeconds: body.active_seconds ?? null,
      creditedSeconds: credits.reduce((sum, credit) => sum + credit.onlineSeconds, 0),
      snapshot: body.snapshot ?? null,
    }),
  ]
  if (body.snapshot && modulesOf(appRow).includes('metrics')) {
    statements.push(heartbeatSampleStatement(env.DB, installation.id, appRow.id, nowMs, body.snapshot))
  }

  // One batch, so the presence update, the hours it is filed under, the audit row and the minute's
  // sample commit together: the panel never shows a connected installation with no use recorded
  // for the hour, a sample with no heartbeat behind it, or the reverse.
  await env.DB.batch(statements)

  // The version this heartbeat reported is the one an update is measured against.
  return directivesFor(env, appRow, versionChanged ? { ...installation, appVersion: body.app_version ?? installation.appVersion } : installation, now)
}

export { directivesFor, heartbeatBodySchema, loadDevice, presenceFor, recordHeartbeat, stateFor }
export type { Directives, HeartbeatBody }
