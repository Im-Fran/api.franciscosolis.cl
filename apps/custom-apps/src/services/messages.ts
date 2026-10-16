import { and, eq, isNull, lte, gt, or, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { messageReceipts, messages } from '@/db/schema'
import { iso } from '@/lib/json'
import { appliesTo, type DeviceTarget } from '@/services/targeting'

/**
 * In-app messages as a device sees them: those running now, aimed at it, each saying whether this
 * device already confirmed showing it.
 */

type MessageRow = typeof messages.$inferSelect

const toDeviceMessage = (row: MessageRow, seen: boolean) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  severity: row.severity,
  display: row.display,
  starts_at: iso(row.startsAt),
  ends_at: iso(row.endsAt),
  updated_at: iso(row.updatedAt),
  seen,
})

type DeviceMessage = ReturnType<typeof toDeviceMessage>

/** Running at `now`: started, and not ended. */
const runningAt = (now: Date) => and(lte(messages.startsAt, now), or(isNull(messages.endsAt), gt(messages.endsAt, now)))

const activeMessages = async (db: Database, appId: string, device: DeviceTarget, now: Date = new Date()): Promise<DeviceMessage[]> => {
  const rows = await db
    .select({ message: messages, seenAt: messageReceipts.seenAt })
    .from(messages)
    .leftJoin(messageReceipts, and(eq(messageReceipts.messageId, messages.id), eq(messageReceipts.installationId, device.id)))
    .where(and(eq(messages.appId, appId), runningAt(now)))
    .orderBy(sql`CASE ${messages.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`, messages.startsAt, messages.id)
  return rows.filter((row) => appliesTo(row.message, device)).map((row) => toDeviceMessage(row.message, row.seenAt !== null))
}

export { activeMessages, runningAt, toDeviceMessage }
export type { DeviceMessage, MessageRow }
