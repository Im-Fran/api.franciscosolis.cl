import { and, eq, lte } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { apps, auditLogs, releases } from '@/db/schema'
import type { Env } from '@/env'
import { evaluateAlerts } from '@/services/alerts'
import { auditRow } from '@/services/audit'
import { expireCommands } from '@/services/commands'
import { runContracts } from '@/services/contracts'
import { pauseReason, releaseStats } from '@/services/releases'
import { runHourly } from '@/services/rollup'
import { syncApp } from '@/services/socket'

/**
 * The cron, every five minutes. Each run expires stale commands, renews, warns about and lapses
 * contracts and keeps their hours cycles current, ends grace periods that ran out, pauses rollouts
 * that are going wrong and evaluates the alert rules; the first run of each hour also does the hourly work (purge, and the
 * daily roll-up at its hour). The minute check is on UTC, which is the same as Santiago's: Chile's
 * offset is a whole number of hours.
 */

/**
 * A grace period that reached its end suspends the app, as the contract says it does. Recorded in
 * the audit trail with no actor — nobody pressed anything — and pushed to the devices holding a
 * socket; the others read it on their next heartbeat.
 */
const endGracePeriods = async (env: Env, now: Date) => {
  const db = getDb(env)
  const due = await db.select().from(apps).where(and(eq(apps.state, 'grace'), lte(apps.stateUntil, now)))
  for (const app of due) {
    const [updated] = await db
      .update(apps)
      .set({ state: 'suspended', stateUntil: null, updatedAt: now })
      .where(and(eq(apps.id, app.id), eq(apps.state, 'grace')))
      .returning()
    if (!updated) continue
    await db.insert(auditLogs).values(
      auditRow({
        event: 'app.state_changed',
        resourceType: 'app',
        resourceId: app.id,
        metadata: {
          automatic: true,
          reason: 'grace_period_ended',
          before: { state: 'grace', message: app.stateMessage, until: app.stateUntil?.toISOString() ?? null },
          after: { state: 'suspended', message: updated.stateMessage, until: null },
        },
      }),
    )
    await syncApp(env, app.id)
  }
  return due.length
}

/**
 * A published release whose devices are rolling back or crashing past the app's thresholds pauses
 * itself: nobody new is offered it, and the devices already on it stay there. Paused rather than
 * withdrawn, because withdrawing sends every device back down — that is a person's call. Recorded with
 * no actor and pushed to the sockets like any other change to what a device is offered.
 */
const evaluateRollouts = async (env: Env, now: Date) => {
  const db = getDb(env)
  const rows = await db
    .select({ release: releases, app: apps })
    .from(releases)
    .innerJoin(apps, eq(apps.id, releases.appId))
    .where(eq(releases.status, 'published'))
  let paused = 0
  for (const { release, app } of rows) {
    const stats = await releaseStats(env.DB, release)
    const reason = pauseReason(stats, app)
    if (!reason) continue
    const statusReason = { automatic: true, ...reason }
    const [updated] = await db
      .update(releases)
      .set({ status: 'paused', statusChangedAt: now, statusReason: JSON.stringify(statusReason), updatedAt: now })
      .where(and(eq(releases.id, release.id), eq(releases.status, 'published')))
      .returning()
    if (!updated) continue
    paused += 1
    await db.insert(auditLogs).values(
      auditRow({
        event: 'release.paused',
        resourceType: 'app',
        resourceId: app.id,
        metadata: { release_id: release.id, version: release.version, channel: release.channel, platform: release.platform, arch: release.arch, ...statusReason, stats },
      }),
    )
    await syncApp(env, app.id)
  }
  return paused
}

const runScheduled = async (env: Env, now: Date) => {
  const expiredCommands = await expireCommands(env.DB, now)
  // Contracts first: a lapse puts apps in grace, and a grace period ending today should be seen by
  // the grace expiry in the same run.
  const contractsResult = await runContracts(env, now)
  const suspended = await endGracePeriods(env, now)
  const pausedReleases = await evaluateRollouts(env, now)
  const alerts = await evaluateAlerts(env, now)
  const hourly = now.getUTCMinutes() < 5 ? await runHourly(env, now) : null
  return { expired_commands: expiredCommands, contracts: contractsResult, suspended_apps: suspended, paused_releases: pausedReleases, alerts, hourly }
}

export { endGracePeriods, evaluateRollouts, runScheduled }
