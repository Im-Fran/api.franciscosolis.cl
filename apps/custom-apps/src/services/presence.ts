import { APP_STATES, HEARTBEAT, type AppState } from '@/lib/config'
import { hourStart, splitByHour } from '@/lib/time'

/**
 * Presence: whether an installation is connected now, and how much of each hour it was.
 *
 * "Connected" is derived, never stored. It is `last_seen_at` compared with the app's interval at the
 * moment somebody asks, so there is no flag to go stale when a device simply stops talking — which
 * is exactly the case it has to get right.
 */

/** True while the last heartbeat is younger than `offlineAfterIntervals` intervals. */
const isConnected = (lastSeenAt: Date | null, intervalSeconds: number, now: Date = new Date()) =>
  lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() <= intervalSeconds * HEARTBEAT.offlineAfterIntervals * 1000

/** The state an installation obeys: its own override when set, the app's otherwise. */
const effectiveState = (appState: string, override: string | null): AppState => {
  const candidate = override ?? appState
  return (APP_STATES as readonly string[]).includes(candidate) ? (candidate as AppState) : 'active'
}

type HourCredit = { hourStart: number; onlineSeconds: number; activeSeconds: number; heartbeats: number }

/**
 * What one heartbeat adds to the hourly usage table.
 *
 * The time since the previous heartbeat is credited as online — split across the hours it spans —
 * as long as the installation never went offline in between. After a gap longer than the offline
 * threshold nothing is credited for the gap: the device was not there, and inventing an interval's
 * worth would turn every reconnect into phantom use. The heartbeat itself is counted in the hour it
 * arrived either way.
 *
 * `reportedActive` is the device's own count of seconds somebody was using it since its last
 * heartbeat. It is capped at the credited online time — an app cannot be used while it is not
 * running — and spread over the same hours in proportion.
 */
const heartbeatCredit = (
  previousSeenAt: Date | null,
  now: Date,
  intervalSeconds: number,
  reportedActive: number | null | undefined,
): HourCredit[] => {
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const previous = previousSeenAt ? Math.floor(previousSeenAt.getTime() / 1000) : null
  const gap = previous === null ? 0 : nowSeconds - previous
  const credited = gap > 0 && gap <= intervalSeconds * HEARTBEAT.offlineAfterIntervals ? gap : 0
  const active = Math.max(0, Math.min(Math.floor(reportedActive ?? 0), credited))

  const pieces = credited > 0 ? splitByHour(nowSeconds - credited, nowSeconds) : []
  const byHour = new Map<number, HourCredit>()
  let activeLeft = active
  pieces.forEach(([start, seconds], index) => {
    const share = index === pieces.length - 1 ? activeLeft : Math.round((active * seconds) / credited)
    activeLeft -= share
    byHour.set(start, { hourStart: start, onlineSeconds: seconds, activeSeconds: Math.max(0, share), heartbeats: 0 })
  })

  const currentHour = hourStart(nowSeconds)
  const current = byHour.get(currentHour) ?? { hourStart: currentHour, onlineSeconds: 0, activeSeconds: 0, heartbeats: 0 }
  current.heartbeats += 1
  byHour.set(currentHour, current)

  return [...byHour.values()].sort((a, b) => a.hourStart - b.hourStart)
}

const UPSERT_HOUR = `INSERT INTO usage_hourly (installation_id, app_id, hour_start, online_seconds, active_seconds, heartbeats)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (installation_id, hour_start) DO UPDATE SET
  online_seconds = MIN(3600, usage_hourly.online_seconds + excluded.online_seconds),
  active_seconds = MIN(3600, usage_hourly.active_seconds + excluded.active_seconds),
  heartbeats = usage_hourly.heartbeats + excluded.heartbeats`

/** The upserts filing one heartbeat's credit, to run in the same batch as the presence update. */
const hourlyStatements = (db: D1Database, installationId: string, appId: string, credits: HourCredit[]) =>
  credits.map((credit) =>
    db
      .prepare(UPSERT_HOUR)
      .bind(installationId, appId, credit.hourStart, credit.onlineSeconds, credit.activeSeconds, credit.heartbeats),
  )

export { effectiveState, heartbeatCredit, hourlyStatements, isConnected }
export type { HourCredit }
