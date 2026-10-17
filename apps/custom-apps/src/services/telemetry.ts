import * as v from 'valibot'
import type { Env } from '@/env'
import { CRASHES, EVENT_TYPES, LOG_LEVELS, LOGS, TELEMETRY } from '@/lib/config'
import { hashToken } from '@/lib/tokens'

/**
 * What a device measures, and the queue that carries it to D1.
 *
 * Every measurement is optional and nullable. Platforms measure different subsets — a browser none
 * of the system ones, Android no GPU worth the name — and "this platform cannot tell" has to survive
 * all the way to the panel as N/A. A zero would be a lie: 0 % CPU is a measurement.
 */

const MAX_BYTES = Number.MAX_SAFE_INTEGER

/** A percentage. Clamped rather than refused above 100: per-core sums and rounding overshoot. */
const percent = v.optional(
  v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(10_000), v.transform((value) => Math.min(value, 100)))),
)
const bytes = v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_BYTES))))
const watts = v.optional(v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100_000))))

/** The light snapshot a heartbeat carries, and the measurement half of a metrics sample. */
const measurementEntries = {
  cpu_percent: percent,
  memory_used_bytes: bytes,
  memory_total_bytes: bytes,
  gpu_percent: percent,
  disk_used_bytes: bytes,
  disk_total_bytes: bytes,
  net_rx_bytes: bytes,
  net_tx_bytes: bytes,
  battery_percent: percent,
  battery_charging: v.optional(v.nullable(v.boolean())),
  power_watts: watts,
}

const snapshotSchema = v.object({
  ...measurementEntries,
  uptime_seconds: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
})
type Snapshot = v.InferOutput<typeof snapshotSchema>

/** A device timestamp: ISO 8601, turned into unix milliseconds. */
const deviceTime = v.pipe(
  v.string(),
  v.maxLength(40),
  v.transform((value) => Date.parse(value)),
  v.check((value) => Number.isFinite(value), 'must be an ISO 8601 timestamp'),
)

const sampleSchema = v.object({ recorded_at: deviceTime, ...measurementEntries })
type Sample = v.InferOutput<typeof sampleSchema>

const metricsBodySchema = v.object({
  samples: v.pipe(v.array(sampleSchema), v.minLength(1), v.maxLength(TELEMETRY.maxBatch)),
})

const eventSchema = v.object({
  /** Device-minted and unique per installation, so a retried batch is recognised. */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  type: v.picklist(EVENT_TYPES),
  name: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  session_id: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(64)))),
  occurred_at: deviceTime,
  properties: v.optional(
    v.nullable(
      v.pipe(
        v.record(v.string(), v.unknown()),
        v.check(
          (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= TELEMETRY.maxEventPropertiesBytes,
          `properties must serialise to at most ${TELEMETRY.maxEventPropertiesBytes} bytes`,
        ),
      ),
    ),
  ),
})
type UsageEventInput = v.InferOutput<typeof eventSchema>

const eventsBodySchema = v.object({
  events: v.pipe(v.array(eventSchema), v.minLength(1), v.maxLength(TELEMETRY.maxBatch)),
})

/** A flat-ish JSON object of at most `max` bytes once serialised. */
const boundedObject = (max: number, what: string) =>
  v.optional(
    v.nullable(
      v.pipe(
        v.record(v.string(), v.unknown()),
        v.check((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= max, `${what} must serialise to at most ${max} bytes`),
      ),
    ),
  )

/** Text cut to `max` UTF-16 units rather than refused: a log line is worth keeping even when long. */
const clipped = (max: number) => v.pipe(v.string(), v.transform((value) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)))

const logEntrySchema = v.object({
  /** Device-minted and unique per installation, so a retried batch is recognised. */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  level: v.picklist(LOG_LEVELS),
  message: v.pipe(v.string(), v.minLength(1), clipped(LOGS.maxMessageBytes)),
  target: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  occurred_at: deviceTime,
  context: boundedObject(LOGS.maxContextBytes, 'context'),
})
type LogEntryInput = v.InferOutput<typeof logEntrySchema>

const logsBodySchema = v.object({
  entries: v.pipe(v.array(logEntrySchema), v.minLength(1), v.maxLength(TELEMETRY.maxBatch)),
})

const crashSchema = v.object({
  /** Device-minted and unique per installation. */
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  occurred_at: deviceTime,
  app_version: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(64)))),
  /** Exception type or signal: `panic`, `SIGSEGV`, `TypeError`. */
  kind: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(120)))),
  message: v.optional(v.nullable(clipped(CRASHES.maxMessageBytes))),
  stack: v.optional(v.nullable(clipped(CRASHES.maxStackBytes))),
  context: boundedObject(CRASHES.maxContextBytes, 'context'),
})
type CrashInput = v.InferOutput<typeof crashSchema>

const crashesBodySchema = v.object({
  crashes: v.pipe(v.array(crashSchema), v.minLength(1), v.maxLength(CRASHES.maxBatch)),
})

/**
 * The frames that identify a crash, with everything that differs between two runs of the same bug
 * taken out: addresses, line and column numbers, and the numbers inside generic or closure names.
 * What is left is "which functions, in which order" — the same for every occurrence of one bug.
 */
const normaliseStack = (stack: string) =>
  stack
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/0x[0-9a-f]+/gi, '<addr>')
        .replace(/:\d+(?::\d+)?/g, '')
        .replace(/\d+/g, 'N')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(0, CRASHES.signatureFrames)
    .join('\n')

/**
 * What groups crashes: SHA-256 of the kind and the normalised top frames. A report with no stack is
 * grouped by its kind and message, numbers taken out, which is the best a stackless panic offers.
 */
const crashSignature = async (crash: Pick<CrashInput, 'kind' | 'message' | 'stack'>) => {
  const body = crash.stack?.trim() ? normaliseStack(crash.stack) : (crash.message ?? '').replace(/\d+/g, 'N').trim()
  return hashToken(`${crash.kind ?? ''}\n${body}`)
}

/** A crash group's title: its kind and the first line of its message. */
const crashTitle = (crash: Pick<CrashInput, 'kind' | 'message'>) => {
  const firstLine = (crash.message ?? '').split(/\r?\n/)[0]?.trim() ?? ''
  const title = [crash.kind, firstLine].filter(Boolean).join(': ') || 'Crash'
  return title.length > 200 ? `${title.slice(0, 199)}…` : title
}

type QueuedCrash = CrashInput & { signature: string; title: string }

/**
 * The queue's one message shape. `version` so a consumer deployed ahead of (or behind) a producer can
 * tell; both halves live in this Worker today, but a queue outlives a deploy by its retry window.
 */
type TelemetryMessage =
  | { version: 1; kind: 'metrics'; installation_id: string; app_id: string; received_at: number; samples: Sample[] }
  | { version: 1; kind: 'events'; installation_id: string; app_id: string; received_at: number; events: UsageEventInput[] }
  | { version: 1; kind: 'logs'; installation_id: string; app_id: string; received_at: number; entries: LogEntryInput[] }
  | { version: 1; kind: 'crashes'; installation_id: string; app_id: string; received_at: number; crashes: QueuedCrash[] }

/**
 * Drops what a device should not have sent: a timestamp in the future beyond the allowed skew, or
 * one older than the raw retention (it would be purged on the next run, after skewing a roll-up that
 * is already final). Reported back as a count, so a device with a wrong clock can be told.
 */
const withinWindow = (timestampMs: number, nowMs: number) =>
  timestampMs <= nowMs + TELEMETRY.maxClockSkewSeconds * 1000 &&
  timestampMs >= nowMs - TELEMETRY.rawRetentionDays * 86_400_000

const METRIC_COLUMNS = [
  'installation_id',
  'app_id',
  'recorded_at',
  'received_at',
  'cpu_percent',
  'memory_used_bytes',
  'memory_total_bytes',
  'gpu_percent',
  'disk_used_bytes',
  'disk_total_bytes',
  'net_rx_bytes',
  'net_tx_bytes',
  'battery_percent',
  'battery_charging',
  'power_watts',
] as const

const INSERT_SAMPLE = `INSERT OR IGNORE INTO metric_samples (${METRIC_COLUMNS.join(', ')}) VALUES (${METRIC_COLUMNS.map(() => '?').join(', ')})`

const INSERT_EVENT =
  'INSERT OR IGNORE INTO usage_events (installation_id, event_id, app_id, type, name, session_id, occurred_at, received_at, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

const sampleStatement = (db: D1Database, message: Extract<TelemetryMessage, { kind: 'metrics' }>, sample: Sample) =>
  db.prepare(INSERT_SAMPLE).bind(
    message.installation_id,
    message.app_id,
    Math.round(sample.recorded_at),
    message.received_at,
    sample.cpu_percent ?? null,
    sample.memory_used_bytes ?? null,
    sample.memory_total_bytes ?? null,
    sample.gpu_percent ?? null,
    sample.disk_used_bytes ?? null,
    sample.disk_total_bytes ?? null,
    sample.net_rx_bytes ?? null,
    sample.net_tx_bytes ?? null,
    sample.battery_percent ?? null,
    sample.battery_charging === undefined || sample.battery_charging === null ? null : sample.battery_charging ? 1 : 0,
    sample.power_watts ?? null,
  )

const eventStatement = (db: D1Database, message: Extract<TelemetryMessage, { kind: 'events' }>, event: UsageEventInput) =>
  db.prepare(INSERT_EVENT).bind(
    message.installation_id,
    event.id,
    message.app_id,
    event.type,
    event.name ?? null,
    event.session_id ?? null,
    Math.round(event.occurred_at),
    message.received_at,
    event.properties ? JSON.stringify(event.properties) : null,
  )

/** The measurement columns a heartbeat's snapshot fills, gauges first and the two counters last. */
const GAUGE_COLUMNS = [
  'cpu_percent',
  'memory_used_bytes',
  'memory_total_bytes',
  'gpu_percent',
  'disk_used_bytes',
  'disk_total_bytes',
  'battery_percent',
  'battery_charging',
  'power_watts',
] as const
const COUNTER_COLUMNS = ['net_rx_bytes', 'net_tx_bytes'] as const

const UPSERT_HEARTBEAT_SAMPLE = `INSERT INTO metric_samples (installation_id, app_id, source, recorded_at, received_at, ${[...GAUGE_COLUMNS, ...COUNTER_COLUMNS].join(', ')})
VALUES (?, ?, 'heartbeat', ?, ?, ${[...GAUGE_COLUMNS, ...COUNTER_COLUMNS].map(() => '?').join(', ')})
ON CONFLICT (installation_id, source, recorded_at) DO UPDATE SET
  received_at = excluded.received_at,
  ${GAUGE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(',\n  ')},
  ${COUNTER_COLUMNS.map((column) => `${column} = CASE WHEN excluded.${column} IS NULL THEN metric_samples.${column} ELSE COALESCE(metric_samples.${column}, 0) + excluded.${column} END`).join(',\n  ')}`

/** Start of the minute containing `ms`, in unix milliseconds. */
const minuteStart = (ms: number) => ms - (ms % 60_000)

/**
 * The statement filing a heartbeat's snapshot as the sample of its minute.
 *
 * One row per installation per minute, keyed on the minute's start: the first heartbeat of a minute
 * inserts it, every later one overwrites it, so the chart shows the **last** heartbeat of each minute
 * however often a device sends. The gauges (CPU, memory, battery…) are replaced — the latest reading
 * is the truth — while the network counters are *added*, because they are bytes moved since the
 * previous report and a second heartbeat does not undo the traffic the first one counted.
 *
 * Written synchronously with the heartbeat rather than through the queue: "last" has to mean last to
 * arrive, and a queue does not promise delivery order.
 */
const heartbeatSampleStatement = (db: D1Database, installationId: string, appId: string, receivedAtMs: number, snapshot: Snapshot) =>
  db
    .prepare(UPSERT_HEARTBEAT_SAMPLE)
    .bind(
      installationId,
      appId,
      minuteStart(receivedAtMs),
      Math.floor(receivedAtMs / 1000),
      snapshot.cpu_percent ?? null,
      snapshot.memory_used_bytes ?? null,
      snapshot.memory_total_bytes ?? null,
      snapshot.gpu_percent ?? null,
      snapshot.disk_used_bytes ?? null,
      snapshot.disk_total_bytes ?? null,
      snapshot.battery_percent ?? null,
      snapshot.battery_charging === undefined || snapshot.battery_charging === null ? null : snapshot.battery_charging ? 1 : 0,
      snapshot.power_watts ?? null,
      snapshot.net_rx_bytes ?? null,
      snapshot.net_tx_bytes ?? null,
    )

const INSERT_HEARTBEAT_LOG =
  'INSERT INTO heartbeat_log (installation_id, app_id, received_at, ip, app_version, active_seconds, credited_seconds, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

type HeartbeatLogEntry = {
  installationId: string
  appId: string
  receivedAtMs: number
  ip: string | null
  appVersion: string | null
  activeSeconds: number | null
  creditedSeconds: number
  snapshot: Snapshot | null
}

/** The audit row for one heartbeat: everything it carried, as it arrived. */
const heartbeatLogStatement = (db: D1Database, entry: HeartbeatLogEntry) =>
  db
    .prepare(INSERT_HEARTBEAT_LOG)
    .bind(
      entry.installationId,
      entry.appId,
      entry.receivedAtMs,
      entry.ip,
      entry.appVersion,
      entry.activeSeconds,
      entry.creditedSeconds,
      entry.snapshot ? JSON.stringify(entry.snapshot) : null,
    )

const INSERT_LOG =
  'INSERT OR IGNORE INTO log_entries (installation_id, entry_id, app_id, level, severity, message, target, context, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

const logStatement = (db: D1Database, message: Extract<TelemetryMessage, { kind: 'logs' }>, entry: LogEntryInput) =>
  db.prepare(INSERT_LOG).bind(
    message.installation_id,
    entry.id,
    message.app_id,
    entry.level,
    LOG_LEVELS.indexOf(entry.level),
    entry.message,
    entry.target ?? null,
    entry.context ? JSON.stringify(entry.context) : null,
    Math.round(entry.occurred_at),
    message.received_at,
  )

/**
 * Counts a crash into its group — creating the group on its first report — but only when this report
 * has not been stored before, so a redelivered batch counts nothing twice. A report that occurred
 * after its group was resolved reopens it: the fix did not hold. An `ignored` group stays ignored.
 * The `WHERE` on the `SELECT` is also what lets SQLite parse the `ON CONFLICT` after it.
 */
const UPSERT_CRASH_GROUP = `INSERT INTO crash_groups (id, app_id, signature, app_version, title, status, occurrences, first_seen_at, last_seen_at)
SELECT ?, ?, ?, ?, ?, 'open', 1, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM crash_reports WHERE installation_id = ? AND report_id = ?)
ON CONFLICT (app_id, signature, app_version) DO UPDATE SET
  occurrences = crash_groups.occurrences + 1,
  first_seen_at = MIN(crash_groups.first_seen_at, excluded.first_seen_at),
  last_seen_at = MAX(crash_groups.last_seen_at, excluded.last_seen_at),
  status = CASE WHEN crash_groups.status = 'resolved' AND excluded.last_seen_at > crash_groups.resolved_at THEN 'open' ELSE crash_groups.status END,
  resolved_by = CASE WHEN crash_groups.status = 'resolved' AND excluded.last_seen_at > crash_groups.resolved_at THEN NULL ELSE crash_groups.resolved_by END,
  resolved_at = CASE WHEN crash_groups.status = 'resolved' AND excluded.last_seen_at > crash_groups.resolved_at THEN NULL ELSE crash_groups.resolved_at END`

const INSERT_CRASH_REPORT = `INSERT OR IGNORE INTO crash_reports (installation_id, report_id, app_id, group_id, app_version, kind, message, stack, context, occurred_at, received_at)
VALUES (?, ?, ?, (SELECT id FROM crash_groups WHERE app_id = ? AND signature = ? AND app_version = ?), ?, ?, ?, ?, ?, ?, ?)`

const crashStatements = (db: D1Database, message: Extract<TelemetryMessage, { kind: 'crashes' }>, crash: QueuedCrash) => {
  const version = crash.app_version ?? ''
  const occurredSeconds = Math.floor(crash.occurred_at / 1000)
  return [
    db
      .prepare(UPSERT_CRASH_GROUP)
      .bind(crypto.randomUUID(), message.app_id, crash.signature, version, crash.title, occurredSeconds, occurredSeconds, message.installation_id, crash.id),
    db
      .prepare(INSERT_CRASH_REPORT)
      .bind(
        message.installation_id,
        crash.id,
        message.app_id,
        message.app_id,
        crash.signature,
        version,
        crash.app_version ?? null,
        crash.kind ?? null,
        crash.message ?? null,
        crash.stack ?? null,
        crash.context ? JSON.stringify(crash.context) : null,
        Math.round(crash.occurred_at),
        message.received_at,
      ),
  ]
}

/** The D1 statements one message turns into. Unknown shapes turn into none, and are acknowledged. */
const statementsFor = (db: D1Database, body: unknown): D1PreparedStatement[] => {
  const message = body as Partial<TelemetryMessage> | null
  if (!message || message.version !== 1 || typeof message.installation_id !== 'string') {
    return []
  }
  if (message.kind === 'metrics' && Array.isArray(message.samples)) {
    return message.samples.map((sample) => sampleStatement(db, message as Extract<TelemetryMessage, { kind: 'metrics' }>, sample))
  }
  if (message.kind === 'events' && Array.isArray(message.events)) {
    return message.events.map((event) => eventStatement(db, message as Extract<TelemetryMessage, { kind: 'events' }>, event))
  }
  if (message.kind === 'logs' && Array.isArray(message.entries)) {
    return message.entries.map((entry) => logStatement(db, message as Extract<TelemetryMessage, { kind: 'logs' }>, entry))
  }
  if (message.kind === 'crashes' && Array.isArray(message.crashes)) {
    return message.crashes.flatMap((crash) => crashStatements(db, message as Extract<TelemetryMessage, { kind: 'crashes' }>, crash))
  }
  return []
}

/** Statements per `DB.batch` call. A batch is one transaction; this keeps each one short. */
const BATCH_CHUNK = 500

/**
 * The queue consumer. Every insert is `OR IGNORE` against a natural key, so a redelivered batch
 * writes nothing twice and the whole batch can simply be retried on a failure — which is what
 * throwing here does. A message of a shape this version does not know is acknowledged and dropped
 * rather than retried forever.
 */
const consumeTelemetry = async (env: Env, batch: MessageBatch<unknown>) => {
  // Chunked by message, never inside one: a crash's two statements — the group count and the report
  // that count is gated on — must commit in the same transaction.
  const chunks: D1PreparedStatement[][] = [[]]
  let rows = 0
  for (const message of batch.messages) {
    const statements = statementsFor(env.DB, message.body)
    rows += statements.length
    const current = chunks[chunks.length - 1]!
    if (current.length > 0 && current.length + statements.length > BATCH_CHUNK) chunks.push([...statements])
    else current.push(...statements)
  }
  for (const chunk of chunks) {
    if (chunk.length > 0) await env.DB.batch(chunk)
  }
  return { messages: batch.messages.length, rows }
}

export {
  consumeTelemetry,
  crashesBodySchema,
  crashSignature,
  crashTitle,
  eventsBodySchema,
  heartbeatLogStatement,
  heartbeatSampleStatement,
  logsBodySchema,
  minuteStart,
  metricsBodySchema,
  normaliseStack,
  snapshotSchema,
  withinWindow,
}
export type { CrashInput, LogEntryInput, QueuedCrash, Sample, Snapshot, TelemetryMessage, UsageEventInput }
