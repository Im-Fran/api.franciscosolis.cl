import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm'
import * as v from 'valibot'
import type { Database } from '@/db/client'
import { commands } from '@/db/schema'
import { COMMANDS } from '@/lib/config'
import { iso, parseJsonObject } from '@/lib/json'

/**
 * Remote commands on their way to a device.
 *
 * Delivery is at least once: a command is repeated in every heartbeat answer (or socket sync) until
 * the device acknowledges it or it expires, because an answer can be lost on the way back and a
 * command silently swallowed is worse than one a device has to recognise twice. The device
 * deduplicates by `id`. `delivered_at` records the first time it was handed over.
 */

type CommandRow = typeof commands.$inferSelect

/** What the device is handed. No authorship: the device has no business knowing who asked. */
const toDeviceCommand = (row: CommandRow) => ({
  id: row.id,
  type: row.type,
  payload: parseJsonObject(row.payload),
  created_at: iso(row.createdAt),
  expires_at: iso(row.expiresAt),
})

type DeviceCommand = ReturnType<typeof toDeviceCommand>

/** What the panel shows. */
const toCommand = (row: CommandRow) => ({
  ...toDeviceCommand(row),
  installation_id: row.installationId,
  app_id: row.appId,
  status: row.status,
  delivered_at: iso(row.deliveredAt),
  completed_at: iso(row.completedAt),
  result: parseJsonObject(row.result),
  created_by: row.createdBy,
  cancelled_by: row.cancelledBy,
})

/**
 * Commands a device still has to act on, oldest first, and the first-delivery stamp on any handed
 * over for the first time. Expired ones are left for the cron to mark, and never handed over.
 */
const takeOutstanding = async (db: Database, installationId: string, now: Date = new Date()): Promise<DeviceCommand[]> => {
  const rows = await db
    .select()
    .from(commands)
    .where(and(eq(commands.installationId, installationId), inArray(commands.status, ['pending', 'delivered']), gt(commands.expiresAt, now)))
    .orderBy(asc(commands.createdAt), asc(commands.id))
    .limit(COMMANDS.maxPerDelivery)
  const fresh = rows.filter((row) => row.status === 'pending').map((row) => row.id)
  if (fresh.length > 0) {
    await db
      .update(commands)
      .set({ status: 'delivered', deliveredAt: now })
      .where(and(inArray(commands.id, fresh), eq(commands.status, 'pending'), isNull(commands.deliveredAt)))
  }
  return rows.map(toDeviceCommand)
}

/** Marks every pending or delivered command past its expiry as expired. Answers how many. */
const expireCommands = async (db: D1Database, now: Date = new Date()) => {
  const result = await db
    .prepare("UPDATE commands SET status = 'expired' WHERE status IN ('pending', 'delivered') AND expires_at <= ?")
    .bind(Math.floor(now.getTime() / 1000))
    .run()
  return result.meta.changes ?? 0
}

/** A JSON object of at most `COMMANDS.maxPayloadBytes`, as a payload or a result. */
const commandObject = v.pipe(
  v.record(v.string(), v.unknown()),
  v.check(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= COMMANDS.maxPayloadBytes,
    `must serialise to at most ${COMMANDS.maxPayloadBytes} bytes`,
  ),
)

/** What a device reports when it is done with a command. */
const commandAckSchema = v.object({
  status: v.picklist(['succeeded', 'failed']),
  /** Free-form detail: an error message, the log range uploaded, the version found. */
  result: v.optional(v.nullable(commandObject)),
})
type CommandAck = v.InferOutput<typeof commandAckSchema>

type AckOutcome = { outcome: 'recorded' | 'already_recorded'; row: CommandRow } | { outcome: 'not_found' } | { outcome: 'closed'; row: CommandRow }

/**
 * Records a device's result for one of its own commands. Idempotent for a device that sends the same
 * acknowledgement twice; a command that expired or was cancelled first stays as it is (`closed`).
 */
const acknowledgeCommand = async (db: Database, installationId: string, commandId: string, ack: CommandAck, now: Date = new Date()): Promise<AckOutcome> => {
  const [row] = await db.select().from(commands).where(and(eq(commands.id, commandId), eq(commands.installationId, installationId))).limit(1)
  if (!row) return { outcome: 'not_found' }
  if (row.status === 'succeeded' || row.status === 'failed') return { outcome: 'already_recorded', row }
  if (row.status !== 'pending' && row.status !== 'delivered') return { outcome: 'closed', row }
  const [updated] = await db
    .update(commands)
    .set({
      status: ack.status,
      completedAt: now,
      deliveredAt: row.deliveredAt ?? now,
      result: ack.result ? JSON.stringify(ack.result) : null,
    })
    .where(and(eq(commands.id, commandId), inArray(commands.status, ['pending', 'delivered'])))
    .returning()
  return updated ? { outcome: 'recorded', row: updated } : { outcome: 'closed', row }
}

export { acknowledgeCommand, commandAckSchema, commandObject, expireCommands, takeOutstanding, toCommand, toDeviceCommand }
export type { AckOutcome, CommandAck, CommandRow, DeviceCommand }
