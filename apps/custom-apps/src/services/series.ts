import { ROLLUP, TELEMETRY } from '@/lib/config'
import { daysBetween, previousDay, zonedDay, zonedParts } from '@/lib/time'
import { computeDaily, type DailyRow } from '@/services/rollup'

/**
 * The read side of telemetry: the series the panel charts, the daily table, an app's usage over
 * time, and the usage heatmap maintenance windows are planned on.
 */

const MEMORY_PERCENT = 'CASE WHEN memory_total_bytes > 0 AND memory_used_bytes IS NOT NULL THEN memory_used_bytes * 100.0 / memory_total_bytes END'
const DISK_PERCENT = 'CASE WHEN disk_total_bytes > 0 AND disk_used_bytes IS NOT NULL THEN disk_used_bytes * 100.0 / disk_total_bytes END'

const numberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value))

/**
 * One installation's metrics between `from` and `to`, averaged into at most `points` buckets.
 *
 * Downsampled in the database so a 30-day range is a few hundred rows over the wire rather than
 * forty thousand. Network counters are *summed* per bucket — they are deltas — and everything else
 * averaged. A bucket with no samples is absent rather than zero; the chart draws the gap.
 */
const metricsSeries = async (db: D1Database, installationId: string, from: Date, to: Date, points: number) => {
  const spanSeconds = Math.max(60, Math.ceil((to.getTime() - from.getTime()) / 1000))
  const bucketSeconds = Math.max(60, Math.ceil(spanSeconds / points))
  const bucketMs = bucketSeconds * 1000

  const { results } = await db
    .prepare(
      `SELECT (recorded_at / ${bucketMs}) * ${bucketMs} AS bucket, COUNT(*) AS samples,
              AVG(cpu_percent) AS cpu_percent, AVG(${MEMORY_PERCENT}) AS memory_percent,
              AVG(memory_used_bytes) AS memory_used_bytes, AVG(gpu_percent) AS gpu_percent,
              AVG(${DISK_PERCENT}) AS disk_percent, SUM(net_rx_bytes) AS net_rx_bytes, SUM(net_tx_bytes) AS net_tx_bytes,
              AVG(battery_percent) AS battery_percent, AVG(power_watts) AS power_watts
       FROM metric_samples WHERE installation_id = ? AND recorded_at >= ? AND recorded_at < ?
       GROUP BY bucket ORDER BY bucket`,
    )
    .bind(installationId, from.getTime(), to.getTime())
    .all<Record<string, unknown>>()

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    bucket_seconds: bucketSeconds,
    points: results.map((row) => ({
      t: new Date(Number(row.bucket)).toISOString(),
      cpu_percent: numberOrNull(row.cpu_percent),
      memory_percent: numberOrNull(row.memory_percent),
      memory_used_bytes: row.memory_used_bytes === null ? null : Math.round(Number(row.memory_used_bytes)),
      gpu_percent: numberOrNull(row.gpu_percent),
      disk_percent: numberOrNull(row.disk_percent),
      net_rx_bytes: numberOrNull(row.net_rx_bytes),
      net_tx_bytes: numberOrNull(row.net_tx_bytes),
      battery_percent: numberOrNull(row.battery_percent),
      power_watts: numberOrNull(row.power_watts),
      samples: Number(row.samples),
    })),
  }
}

/** The earliest instant a raw query may start at. */
const rawWindowStart = (now: Date) => new Date(now.getTime() - TELEMETRY.rawRetentionDays * 86_400_000)

const toDailyStat = (row: Omit<DailyRow, 'installation_id' | 'app_id'>) => ({
  day: row.day,
  online_seconds: row.online_seconds,
  active_seconds: row.active_seconds,
  cpu_avg: row.cpu_avg,
  cpu_max: row.cpu_max,
  cpu_p95: row.cpu_p95,
  memory_avg: row.memory_avg,
  memory_max: row.memory_max,
  memory_p95: row.memory_p95,
  gpu_avg: row.gpu_avg,
  gpu_max: row.gpu_max,
  net_rx_bytes: row.net_rx_bytes,
  net_tx_bytes: row.net_tx_bytes,
  battery_min: row.battery_min,
  samples: row.samples,
  events: row.events,
})

const STORED_DAILY_COLUMNS = `day, online_seconds, active_seconds, cpu_avg, cpu_max, cpu_p95, memory_avg, memory_max, memory_p95,
  gpu_avg, gpu_max, net_rx_bytes, net_tx_bytes, battery_min, samples, events`

/**
 * Days the roll-up may not have stored yet, which are therefore computed live: today, always, and
 * yesterday until the night's roll-up has run.
 */
const liveDays = (now: Date) => {
  const today = zonedDay(now, ROLLUP.timeZone)
  return [previousDay(today), today]
}

/**
 * One installation's daily statistics from `from` to `to`, oldest first. Stored days come from the
 * roll-up; days it has not reached yet are computed from the raw tables, so the table is never a day
 * behind what the charts beside it show.
 */
const dailyStats = async (db: D1Database, installationId: string, from: string, to: string, now: Date = new Date()) => {
  const { results } = await db
    .prepare(`SELECT ${STORED_DAILY_COLUMNS} FROM installation_daily WHERE installation_id = ? AND day >= ? AND day <= ? ORDER BY day`)
    .bind(installationId, from, to)
    .all<Omit<DailyRow, 'installation_id' | 'app_id'>>()

  const byDay = new Map(results.map((row) => [row.day, toDailyStat(row)]))
  for (const day of liveDays(now)) {
    if (day < from || day > to || byDay.has(day)) continue
    const [live] = await computeDaily(db, day, { installationId })
    if (live) byDay.set(day, toDailyStat(live))
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

type UsageDay = { day: string; online_seconds: number; active_seconds: number; installations: number; events: number }

/** An app's fleet-wide usage per day: hours connected and in use, how many installations, events. */
const appUsage = async (db: D1Database, appId: string, from: string, to: string, now: Date = new Date()): Promise<UsageDay[]> => {
  const { results } = await db
    .prepare(
      `SELECT day, SUM(online_seconds) AS online_seconds, SUM(active_seconds) AS active_seconds,
              SUM(CASE WHEN online_seconds > 0 OR samples > 0 OR events > 0 THEN 1 ELSE 0 END) AS installations,
              SUM(events) AS events
       FROM installation_daily WHERE app_id = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day`,
    )
    .bind(appId, from, to)
    .all<UsageDay>()

  const byDay = new Map<string, UsageDay>(
    results.map((row) => [
      row.day,
      {
        day: row.day,
        online_seconds: Number(row.online_seconds ?? 0),
        active_seconds: Number(row.active_seconds ?? 0),
        installations: Number(row.installations ?? 0),
        events: Number(row.events ?? 0),
      },
    ]),
  )
  for (const day of liveDays(now)) {
    if (day < from || day > to || byDay.has(day)) continue
    const rows = await computeDaily(db, day, { appId })
    if (rows.length === 0) continue
    byDay.set(day, {
      day,
      online_seconds: rows.reduce((sum, row) => sum + row.online_seconds, 0),
      active_seconds: rows.reduce((sum, row) => sum + row.active_seconds, 0),
      installations: rows.filter((row) => row.online_seconds > 0 || row.samples > 0 || row.events > 0).length,
      events: rows.reduce((sum, row) => sum + row.events, 0),
    })
  }

  // Every day in the range, so a chart has a zero where nothing ran rather than a missing bar.
  return daysBetween(from, to).map(
    (day) => byDay.get(day) ?? { day, online_seconds: 0, active_seconds: 0, installations: 0, events: 0 },
  )
}

const HEATMAP_DAYS = 30

/**
 * Average use per weekday and hour over the last 30 days, in Santiago time: a 7 × 24 grid, Monday
 * first, of the seconds of use (and of connection) an average such hour saw across the fleet — or
 * one installation, when given.
 *
 * Averaged over every occurrence of that hour in the window, not over the hours that happened to
 * have data: an hour nobody used is a zero, and that zero is precisely what a maintenance window is
 * looking for.
 */
const usageHeatmap = async (db: D1Database, appId: string, installationId: string | null, now: Date = new Date()) => {
  const end = Math.floor(now.getTime() / 1000 / 3600) * 3600
  const start = end - HEATMAP_DAYS * 86_400

  const { results } = await db
    .prepare(
      `SELECT hour_start, SUM(active_seconds) AS active_seconds, SUM(online_seconds) AS online_seconds
       FROM usage_hourly WHERE app_id = ? AND hour_start >= ? AND hour_start < ?${installationId ? ' AND installation_id = ?' : ''}
       GROUP BY hour_start`,
    )
    .bind(...(installationId ? [appId, start, end, installationId] : [appId, start, end]))
    .all<{ hour_start: number; active_seconds: number; online_seconds: number }>()

  const grid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const active = grid()
  const online = grid()
  const occurrences = grid()

  const slot = (hourStartSeconds: number) => {
    const parts = zonedParts(new Date(hourStartSeconds * 1000), ROLLUP.timeZone)
    return [parts.weekday, parts.hour] as const
  }
  for (let hour = start; hour < end; hour += 3600) {
    const [weekday, local] = slot(hour)
    occurrences[weekday]![local]! += 1
  }
  for (const row of results) {
    const [weekday, local] = slot(Number(row.hour_start))
    active[weekday]![local]! += Number(row.active_seconds ?? 0)
    online[weekday]![local]! += Number(row.online_seconds ?? 0)
  }

  const average = (sums: number[][]) =>
    sums.map((row, weekday) => row.map((sum, hour) => Math.round(sum / Math.max(1, occurrences[weekday]![hour]!))))
  const cells = average(active)
  return {
    timezone: ROLLUP.timeZone,
    days: HEATMAP_DAYS,
    cells,
    online: average(online),
    max: Math.max(0, ...cells.flat()),
  }
}

export { appUsage, dailyStats, metricsSeries, rawWindowStart, usageHeatmap }
