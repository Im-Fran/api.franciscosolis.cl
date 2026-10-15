import * as v from 'valibot'
import type { Env } from '@/env'
import { EVENT_TYPES, TELEMETRY } from '@/lib/config'

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

/**
 * The queue's one message shape. `version` so a consumer deployed ahead of (or behind) a producer can
 * tell; both halves live in this Worker today, but a queue outlives a deploy by its retry window.
 */
type TelemetryMessage =
  | { version: 1; kind: 'metrics'; installation_id: string; app_id: string; received_at: number; samples: Sample[] }
  | { version: 1; kind: 'events'; installation_id: string; app_id: string; received_at: number; events: UsageEventInput[] }

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
  const statements = batch.messages.flatMap((message) => statementsFor(env.DB, message.body))
  for (let index = 0; index < statements.length; index += BATCH_CHUNK) {
    await env.DB.batch(statements.slice(index, index + BATCH_CHUNK))
  }
  return { messages: batch.messages.length, rows: statements.length }
}

export {
  consumeTelemetry,
  eventsBodySchema,
  metricsBodySchema,
  snapshotSchema,
  withinWindow,
}
export type { Sample, Snapshot, TelemetryMessage, UsageEventInput }
