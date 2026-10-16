import { and, eq, lte } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { apps, auditLogs } from '@/db/schema'
import type { Env } from '@/env'
import { evaluateAlerts } from '@/services/alerts'
import { auditRow } from '@/services/audit'
import { expireCommands } from '@/services/commands'
import { runHourly } from '@/services/rollup'
import { syncApp } from '@/services/socket'

/**
 * The cron, every five minutes. Each run expires stale commands, ends grace periods that ran out and
 * evaluates the alert rules; the first run of each hour also does the hourly work (purge, and the
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

const runScheduled = async (env: Env, now: Date) => {
  const expiredCommands = await expireCommands(env.DB, now)
  const suspended = await endGracePeriods(env, now)
  const alerts = await evaluateAlerts(env, now)
  const hourly = now.getUTCMinutes() < 5 ? await runHourly(env, now) : null
  return { expired_commands: expiredCommands, suspended_apps: suspended, alerts, hourly }
}

export { endGracePeriods, runScheduled }
