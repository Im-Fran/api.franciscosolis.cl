import type { Env } from '@/env'
import { ROLLUP, TELEMETRY } from '@/lib/config'
import { previousDay, zonedDay, zonedDayRange, zonedParts } from '@/lib/time'

/**
 * The daily roll-up and the retention purge.
 *
 * Raw telemetry lives 30 days. Before it goes, every installation's day is condensed into one row of
 * `installation_daily` — average, maximum and 95th percentile of each measurement, hours connected
 * and in use, network totals, events — which is kept for good. A roll-up *recomputes* the day from
 * the raw tables and replaces its row, so running it twice, or again after a device flushed an
 * offline backlog, gives the same answer rather than a doubled one.
 */

type DailyRow = {
  installation_id: string
  app_id: string
  day: string
  online_seconds: number
  active_seconds: number
  cpu_avg: number | null
  cpu_max: number | null
  cpu_p95: number | null
  memory_avg: number | null
  memory_max: number | null
  memory_p95: number | null
  gpu_avg: number | null
  gpu_max: number | null
  net_rx_bytes: number
  net_tx_bytes: number
  battery_min: number | null
  samples: number
  events: number
}

/** Memory as a percentage, for the rows that report both halves. */
const MEMORY_PERCENT = 'CASE WHEN memory_total_bytes > 0 AND memory_used_bytes IS NOT NULL THEN memory_used_bytes * 100.0 / memory_total_bytes END'

/**
 * The 95th percentile of `expression` per installation, by the nearest-rank method:
 * the smallest value with at least 95 % of the samples at or below it. `(n * 95 + 99) / 100` is
 * `ceil(n * 0.95)` in integer arithmetic, which SQLite has where `CEIL` may not be compiled in.
 */
const percentileSql = (expression: string, scope: string) => `
WITH ranked AS (
  SELECT installation_id, value,
         ROW_NUMBER() OVER (PARTITION BY installation_id ORDER BY value) AS rank,
         COUNT(*) OVER (PARTITION BY installation_id) AS total
  FROM (SELECT installation_id, ${expression} AS value FROM metric_samples WHERE ${scope})
  WHERE value IS NOT NULL
)
SELECT installation_id, MIN(value) AS p95 FROM ranked WHERE rank >= (total * 95 + 99) / 100 GROUP BY installation_id`

type Scope = { installationId?: string; appId?: string }

/** `AND …` clauses and their bindings narrowing a computation to one installation or one app. */
const scopeFilter = (scope: Scope) => {
  const clauses: string[] = []
  const bindings: string[] = []
  if (scope.installationId) {
    clauses.push('installation_id = ?')
    bindings.push(scope.installationId)
  }
  if (scope.appId) {
    clauses.push('app_id = ?')
    bindings.push(scope.appId)
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(''), bindings }
}

/**
 * One day's statistics per installation, computed from the raw tables without writing anything.
 * Used by the roll-up and, for the day in progress, by the panel's daily view.
 */
const computeDaily = async (db: D1Database, day: string, scope: Scope = {}): Promise<DailyRow[]> => {
  const { start, end } = zonedDayRange(day, ROLLUP.timeZone)
  const startMs = start.getTime()
  const endMs = end.getTime()
  const filter = scopeFilter(scope)
  const sampleScope = `recorded_at >= ${startMs} AND recorded_at < ${endMs}${filter.sql}`

  const [metrics, cpuP95, memoryP95, usage, events] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT installation_id, app_id, COUNT(*) AS samples,
                AVG(cpu_percent) AS cpu_avg, MAX(cpu_percent) AS cpu_max,
                AVG(${MEMORY_PERCENT}) AS memory_avg, MAX(${MEMORY_PERCENT}) AS memory_max,
                AVG(gpu_percent) AS gpu_avg, MAX(gpu_percent) AS gpu_max,
                COALESCE(SUM(net_rx_bytes), 0) AS net_rx_bytes, COALESCE(SUM(net_tx_bytes), 0) AS net_tx_bytes,
                MIN(battery_percent) AS battery_min
         FROM metric_samples WHERE ${sampleScope} GROUP BY installation_id, app_id`,
      )
      .bind(...filter.bindings),
    db.prepare(percentileSql('cpu_percent', sampleScope)).bind(...filter.bindings),
    db.prepare(percentileSql(MEMORY_PERCENT, sampleScope)).bind(...filter.bindings),
    db
      .prepare(
        `SELECT installation_id, app_id, SUM(online_seconds) AS online_seconds, SUM(active_seconds) AS active_seconds
         FROM usage_hourly WHERE hour_start >= ? AND hour_start < ?${filter.sql} GROUP BY installation_id, app_id`,
      )
      .bind(Math.floor(startMs / 1000), Math.floor(endMs / 1000), ...filter.bindings),
    db
      .prepare(
        `SELECT installation_id, app_id, COUNT(*) AS events
         FROM usage_events WHERE occurred_at >= ? AND occurred_at < ?${filter.sql} GROUP BY installation_id, app_id`,
      )
      .bind(startMs, endMs, ...filter.bindings),
  ])

  const rows = new Map<string, DailyRow>()
  const rowFor = (installationId: string, appId: string): DailyRow => {
    let row = rows.get(installationId)
    if (!row) {
      row = {
        installation_id: installationId,
        app_id: appId,
        day,
        online_seconds: 0,
        active_seconds: 0,
        cpu_avg: null,
        cpu_max: null,
        cpu_p95: null,
        memory_avg: null,
        memory_max: null,
        memory_p95: null,
        gpu_avg: null,
        gpu_max: null,
        net_rx_bytes: 0,
        net_tx_bytes: 0,
        battery_min: null,
        samples: 0,
        events: 0,
      }
      rows.set(installationId, row)
    }
    return row
  }
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))

  for (const result of metrics!.results) {
    const row = rowFor(String(result.installation_id), String(result.app_id))
    row.samples = Number(result.samples)
    row.cpu_avg = num(result.cpu_avg)
    row.cpu_max = num(result.cpu_max)
    row.memory_avg = num(result.memory_avg)
    row.memory_max = num(result.memory_max)
    row.gpu_avg = num(result.gpu_avg)
    row.gpu_max = num(result.gpu_max)
    row.net_rx_bytes = Number(result.net_rx_bytes ?? 0)
    row.net_tx_bytes = Number(result.net_tx_bytes ?? 0)
    row.battery_min = num(result.battery_min)
  }
  for (const result of cpuP95!.results) {
    const row = rows.get(String(result.installation_id))
    if (row) row.cpu_p95 = num(result.p95)
  }
  for (const result of memoryP95!.results) {
    const row = rows.get(String(result.installation_id))
    if (row) row.memory_p95 = num(result.p95)
  }
  for (const result of usage!.results) {
    const row = rowFor(String(result.installation_id), String(result.app_id))
    row.online_seconds = Number(result.online_seconds ?? 0)
    row.active_seconds = Number(result.active_seconds ?? 0)
  }
  for (const result of events!.results) {
    const row = rowFor(String(result.installation_id), String(result.app_id))
    row.events = Number(result.events ?? 0)
  }

  return [...rows.values()]
}

const UPSERT_DAILY = `INSERT INTO installation_daily (installation_id, app_id, day, online_seconds, active_seconds,
  cpu_avg, cpu_max, cpu_p95, memory_avg, memory_max, memory_p95, gpu_avg, gpu_max,
  net_rx_bytes, net_tx_bytes, battery_min, samples, events, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
ON CONFLICT (installation_id, day) DO UPDATE SET
  app_id = excluded.app_id, online_seconds = excluded.online_seconds, active_seconds = excluded.active_seconds,
  cpu_avg = excluded.cpu_avg, cpu_max = excluded.cpu_max, cpu_p95 = excluded.cpu_p95,
  memory_avg = excluded.memory_avg, memory_max = excluded.memory_max, memory_p95 = excluded.memory_p95,
  gpu_avg = excluded.gpu_avg, gpu_max = excluded.gpu_max, net_rx_bytes = excluded.net_rx_bytes,
  net_tx_bytes = excluded.net_tx_bytes, battery_min = excluded.battery_min, samples = excluded.samples,
  events = excluded.events, computed_at = excluded.computed_at`

/** Recomputes and stores one day for every installation that reported anything on it. */
const rollupDay = async (db: D1Database, day: string): Promise<number> => {
  const rows = await computeDaily(db, day)
  if (rows.length === 0) {
    return 0
  }
  await db.batch(
    rows.map((row) =>
      db
        .prepare(UPSERT_DAILY)
        .bind(
          row.installation_id,
          row.app_id,
          row.day,
          row.online_seconds,
          row.active_seconds,
          row.cpu_avg,
          row.cpu_max,
          row.cpu_p95,
          row.memory_avg,
          row.memory_max,
          row.memory_p95,
          row.gpu_avg,
          row.gpu_max,
          row.net_rx_bytes,
          row.net_tx_bytes,
          row.battery_min,
          row.samples,
          row.events,
        ),
    ),
  )
  return rows.length
}

/**
 * Deletes raw rows past retention, a chunk at a time, so one run never holds the database for long.
 * A backlog bigger than the per-run allowance is finished by the next hourly run.
 */
const purgeTable = async (db: D1Database, table: string, column: string, before: number) => {
  let deleted = 0
  for (let chunk = 0; chunk < TELEMETRY.purgeMaxChunks; chunk += 1) {
    const result = await db
      .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ${TELEMETRY.purgeChunk})`)
      .bind(before)
      .run()
    const changes = result.meta.changes ?? 0
    deleted += changes
    if (changes < TELEMETRY.purgeChunk) break
  }
  return deleted
}

const purgeExpired = async (db: D1Database, now: Date) => {
  const rawCutoffMs = now.getTime() - TELEMETRY.rawRetentionDays * 86_400_000
  const hourlyCutoff = Math.floor(now.getTime() / 1000) - TELEMETRY.hourlyRetentionDays * 86_400
  return {
    metric_samples: await purgeTable(db, 'metric_samples', 'recorded_at', rawCutoffMs),
    usage_events: await purgeTable(db, 'usage_events', 'occurred_at', rawCutoffMs),
    heartbeat_log: await purgeTable(db, 'heartbeat_log', 'received_at', rawCutoffMs),
    usage_hourly: await purgeTable(db, 'usage_hourly', 'hour_start', hourlyCutoff),
  }
}

/**
 * The hourly cron. Purges every run; at `ROLLUP.hour` in Santiago it also rolls up the two days
 * before today — yesterday, which has just ended, and the day before, again, so a device that came
 * back online and flushed its offline queue late still lands in its totals.
 */
const runScheduled = async (env: Env, now: Date) => {
  const purged = await purgeExpired(env.DB, now)
  const rolledUp: Record<string, number> = {}
  if (zonedParts(now, ROLLUP.timeZone).hour === ROLLUP.hour) {
    const yesterday = previousDay(zonedDay(now, ROLLUP.timeZone))
    for (const day of [previousDay(yesterday), yesterday]) {
      rolledUp[day] = await rollupDay(env.DB, day)
    }
  }
  return { purged, rolled_up: rolledUp }
}

export { computeDaily, purgeExpired, rollupDay, runScheduled }
export type { DailyRow }
