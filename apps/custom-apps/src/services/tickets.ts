import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { apps, companies, crashGroups, logEntries, ticketMessages, tickets } from '@/db/schema'
import type { Env } from '@/env'
import { SUPPORT } from '@/lib/config'
import { iso, parseJsonObject } from '@/lib/json'
import { modulesOf } from '@/services/apps'
import { publishNotification } from '@/services/notify'
import type { AppRow, InstallationRow } from '@/services/serialize'

/**
 * Support tickets: opened from inside a client's app, answered from the panel, read back by the app.
 *
 * Everything about a ticket lives here — the conversation, the device's context at the moment it was
 * opened, and (through the work log) the hours spent on it. The account the app's tickets are
 * assigned to hears about a new ticket and every message the requester adds in the website's bell;
 * nothing is emailed from here.
 *
 * The status moves with the conversation: a requester's message makes a ticket `open` (waiting on
 * us) again unless it was `closed`, and a reply from the panel makes it `pending` (waiting on them)
 * unless the reply says otherwise.
 */

type TicketRow = typeof tickets.$inferSelect
type TicketMessageRow = typeof ticketMessages.$inferSelect

type TicketContext = {
  installation: Record<string, string | null>
  logs: string[]
  crashes: string[]
}

/** What the device looked like when the ticket was opened: kept with the ticket, so it never drifts. */
const captureContext = async (db: Database, appRow: AppRow, installation: InstallationRow, includeDiagnostics: boolean): Promise<TicketContext> => {
  const modules = modulesOf(appRow)
  let logs: string[] = []
  let crashes: string[] = []
  if (includeDiagnostics && modules.includes('logs')) {
    const rows = await db
      .select({ level: logEntries.level, message: logEntries.message, target: logEntries.target, occurredAt: logEntries.occurredAt })
      .from(logEntries)
      .where(eq(logEntries.installationId, installation.id))
      .orderBy(desc(logEntries.occurredAt))
      .limit(SUPPORT.attachedLogs)
    logs = rows.reverse().map((row) => `${new Date(row.occurredAt).toISOString()} ${row.level} ${row.target ? `${row.target}: ` : ''}${row.message}`)
  }
  if (includeDiagnostics && modules.includes('crashes')) {
    const rows = await db
      .select({ title: crashGroups.title, occurrences: crashGroups.occurrences })
      .from(crashGroups)
      .where(and(eq(crashGroups.appId, appRow.id), eq(crashGroups.status, 'open'), eq(crashGroups.appVersion, installation.appVersion ?? '')))
      .orderBy(desc(crashGroups.lastSeenAt))
      .limit(SUPPORT.attachedCrashes)
    crashes = rows.map((row) => `${row.title} (×${row.occurrences})`)
  }
  return {
    installation: {
      name: installation.alias || installation.hostname || installation.deviceId,
      device_id: installation.deviceId,
      app_version: installation.appVersion,
      channel: installation.channel,
      platform: installation.platform,
      os: [installation.osName, installation.osVersion].filter(Boolean).join(' ') || null,
      arch: installation.arch,
      last_seen_at: iso(installation.lastSeenAt),
    },
    logs,
    crashes,
  }
}

const toTicketMessage = (row: TicketMessageRow) => ({
  id: row.id,
  author: row.author,
  author_name: row.authorName,
  body: row.body,
  seen_at: iso(row.seenAt),
  created_at: iso(row.createdAt),
})

/** A ticket as the panel sees it. */
const toTicket = (row: TicketRow, extra: { appName?: string | null; companyName?: string | null; installationName?: string | null; unread?: number; minutes?: number; messages?: TicketMessageRow[] } = {}) => ({
  id: row.id,
  number: row.number,
  app_id: row.appId,
  app_name: extra.appName ?? null,
  company_id: row.companyId,
  company_name: extra.companyName ?? null,
  installation_id: row.installationId,
  installation_name: extra.installationName ?? null,
  subject: row.subject,
  status: row.status,
  requester_name: row.requesterName,
  requester_email: row.requesterEmail,
  context: parseJsonObject<TicketContext>(row.context),
  last_message_at: iso(row.lastMessageAt),
  last_message_by: row.lastMessageBy,
  /** Requester messages nobody in the panel has opened yet. */
  unread: extra.unread ?? 0,
  /** Work logged against the ticket. */
  logged_minutes: extra.minutes ?? 0,
  resolved_at: iso(row.resolvedAt),
  resolved_by: row.resolvedBy,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  ...(extra.messages ? { messages: extra.messages.map(toTicketMessage) } : {}),
})

/** A ticket as the app that opened it sees it: no device context, no internal fields. */
const toDeviceTicket = (row: TicketRow, extra: { unread?: number; messages?: TicketMessageRow[] } = {}) => ({
  id: row.id,
  number: row.number,
  subject: row.subject,
  status: row.status,
  last_message_at: iso(row.lastMessageAt),
  last_message_by: row.lastMessageBy,
  /** Replies from support the app has not fetched yet. */
  unread: extra.unread ?? 0,
  created_at: iso(row.createdAt),
  ...(extra.messages ? { messages: extra.messages.map(toTicketMessage) } : {}),
})

/** Messages by `author` not yet seen by the other side, per ticket. */
const unreadBy = async (db: Database, ticketIds: string[], author: 'requester' | 'staff') => {
  if (ticketIds.length === 0) return new Map<string, number>()
  const rows = await db
    .select({ ticketId: ticketMessages.ticketId, count: sql<number>`COUNT(*)` })
    .from(ticketMessages)
    .where(and(inArray(ticketMessages.ticketId, ticketIds), eq(ticketMessages.author, author), isNull(ticketMessages.seenAt)))
    .groupBy(ticketMessages.ticketId)
  return new Map(rows.map((row) => [row.ticketId, Number(row.count)]))
}

/** Replies from support an installation has not read yet, across its tickets: the badge an app shows. */
const unreadForInstallation = async (db: D1Database, installationId: string) => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id
       WHERE t.installation_id = ? AND m.author = 'staff' AND m.seen_at IS NULL`,
    )
    .bind(installationId)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** Tells the account the app's tickets are assigned to. Never throws, like every publish. */
const notifyAssignee = async (env: Env, db: Database, ticket: TicketRow, type: 'custom_apps.ticket_opened' | 'custom_apps.ticket_message', excerpt: string) => {
  const [row] = await db
    .select({ name: apps.name, assigneeId: apps.supportAssigneeId, assigneeEmail: apps.supportAssigneeEmail, companyName: companies.tradeName, legalName: companies.legalName })
    .from(apps)
    .innerJoin(companies, eq(companies.id, apps.companyId))
    .where(eq(apps.id, ticket.appId))
    .limit(1)
  if (!row?.assigneeId) return false
  return publishNotification(env, {
    type,
    user: { id: row.assigneeId, email: row.assigneeEmail },
    url: `/custom-apps/tickets/${ticket.id}`,
    data: {
      ticket_id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      app_name: row.name,
      company_name: row.companyName || row.legalName,
      requester: ticket.requesterName || ticket.requesterEmail || '',
      excerpt: excerpt.length > 140 ? `${excerpt.slice(0, 139)}…` : excerpt,
    },
  })
}

export { captureContext, notifyAssignee, toDeviceTicket, toTicket, toTicketMessage, unreadBy, unreadForInstallation }
export type { TicketContext, TicketMessageRow, TicketRow }
