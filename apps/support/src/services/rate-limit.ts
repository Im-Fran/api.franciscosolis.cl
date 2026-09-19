import { and, count, eq, gte } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { aiRequests, auditLogs, inboundEmails, tickets } from '@/db/schema'

/**
 * Rate limits, counted in D1.
 *
 * Cloudflare's rate-limiting binding would be cheaper, but it is per-colo and approximate, and the
 * two limits that matter here are protecting something other than CPU: `POST /tickets` sends an
 * email to an address the caller chose, which makes an unlimited endpoint a spam cannon pointed at
 * the sending reputation of `mail.franciscosolis.cl` — the same reputation `apps/auth`'s magic links
 * depend on. Burning it breaks sign-in for everybody. A count that is exact and durable is worth a
 * query for that.
 *
 * Every limit reuses a table that is already being written for another reason, so none of them adds
 * a row of its own.
 */

const hourAgo = (now: Date) => new Date(now.getTime() - 3600_000)

/** Tickets opened from one client IP in the last hour. Read off the audit trail, which records it. */
const ticketsFromIp = async (db: Database, ip: string, now: Date): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(auditLogs)
    .where(and(eq(auditLogs.event, 'ticket.created'), eq(auditLogs.ip, ip), gte(auditLogs.createdAt, hourAgo(now))))
  return row?.total ?? 0
}

/** Tickets opened by one address in the last hour. */
const ticketsFromEmail = async (db: Database, email: string, now: Date): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(tickets)
    .where(and(eq(tickets.requesterEmail, email.toLowerCase()), gte(tickets.createdAt, hourAgo(now))))
  return row?.total ?? 0
}

/**
 * Messages accepted from one sender in the last hour.
 *
 * Counted over `inbound_emails` rather than a counter of its own, which means a rejected message
 * still counts against the sender — deliberately. Somebody hammering the inbox should not get their
 * quota refunded because the first twenty were refused.
 */
const inboundFromSender = async (db: Database, email: string, now: Date): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.fromEmail, email.toLowerCase()), gte(inboundEmails.receivedAt, hourAgo(now))))
  return row?.total ?? 0
}

/** Assistant calls one agent has made in the last hour. */
const assistCallsByAgent = async (db: Database, email: string, now: Date): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(aiRequests)
    .where(
      and(
        eq(aiRequests.kind, 'assist'),
        eq(aiRequests.actorEmail, email.toLowerCase()),
        gte(aiRequests.createdAt, hourAgo(now)),
      ),
    )
  return row?.total ?? 0
}

/**
 * Translation drafts one agent has asked for in the last hour.
 *
 * Counted apart from `assistCallsByAgent` on purpose: drafting a reply and translating the help
 * centre are two different spends by the same person, and exhausting one should not close the other.
 * A call that failed still counts — a front-end stuck in a loop is billing neurons whether or not
 * the answers came back, and that is the thing being limited.
 */
const translationsByAgent = async (db: Database, email: string, now: Date): Promise<number> => {
  const [row] = await db
    .select({ total: count() })
    .from(aiRequests)
    .where(
      and(
        eq(aiRequests.kind, 'translate'),
        eq(aiRequests.actorEmail, email.toLowerCase()),
        gte(aiRequests.createdAt, hourAgo(now)),
      ),
    )
  return row?.total ?? 0
}

/** Seconds until the top of the next hour-window, for a `Retry-After` header. */
const retryAfterSeconds = (now: Date): number => 3600 - Math.floor((now.getTime() / 1000) % 3600)

export {
  assistCallsByAgent,
  inboundFromSender,
  retryAfterSeconds,
  ticketsFromEmail,
  ticketsFromIp,
  translationsByAgent,
}
