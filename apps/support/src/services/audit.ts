import type { Context } from 'hono'
import type { Database } from '@/db/client'
import { auditLogs } from '@/db/schema'
import type { AppEnv } from '@/env'

/** Events recorded in `audit_logs`. Kept as a closed set so queries over the trail stay reliable. */
type AuditEvent =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.deleted'
  | 'ticket.assigned'
  | 'ticket.claimed'
  | 'ticket.link_rotated'
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'participant.added'
  | 'participant.removed'
  | 'label.created'
  | 'label.updated'
  | 'label.deleted'
  | 'help.category.created'
  | 'help.category.updated'
  | 'help.category.deleted'
  | 'help.article.created'
  | 'help.article.updated'
  | 'help.article.deleted'
  | 'help.article.reindexed'
  | 'email.inbound_rejected'
  | 'email.inbound_ingested'
  | 'notification.sent'
  | 'assist.requested'

type AuditInput = {
  event: AuditEvent
  actorEmail?: string | null
  actorId?: string | null
  resourceType?: string | null
  resourceId?: string | null
  ip?: string | null
  userAgent?: string | null
  /**
   * Structured context. **Never a message body.** This table is read out in the support console and
   * exported by `GET /admin/audit`, and a ticket body is somebody's personal data — the id of the
   * message is enough to find it through the route that already checks who is asking.
   */
  metadata?: Record<string, unknown> | null
}

/**
 * Appends an entry to the audit trail. Never throws: losing an audit row must not turn a successful
 * write into a 500, and the trail is a diagnostic aid rather than a transactional guarantee.
 */
const recordAudit = async (db: Database, input: AuditInput) => {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      event: input.event,
      actorEmail: input.actorEmail ?? null,
      actorId: input.actorId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : '{}',
    })
  } catch (error) {
    console.error('failed to write audit log', input.event, error)
  }
}

/**
 * The same thing, for the two entry points that have no Hono context.
 *
 * `email()` is invoked by Email Routing and `scheduled()` by the cron, neither of which carries a
 * Request — so there is no `CF-Connecting-IP` and no `User-Agent` to record. Rather than let callers
 * hand-roll an audit row with nulls in it and get the shape subtly wrong, this names the case.
 */
const recordSystemAudit = async (db: Database, input: Omit<AuditInput, 'ip' | 'userAgent'>) =>
  recordAudit(db, { ...input, ip: null, userAgent: null })

/** Client fingerprint taken from Cloudflare's own headers, used on audit rows. */
const getRequestContext = (c: Context<AppEnv>) => ({
  ip: c.req.header('CF-Connecting-IP') ?? null,
  userAgent: c.req.header('User-Agent') ?? null,
})

/** Shorthand for the actor fields of an audit row, read off the authenticated agent. */
const getActorContext = (c: Context<AppEnv>) => {
  const agent = c.get('agent')
  return { actorEmail: agent.email, actorId: agent.id }
}

export { getActorContext, getRequestContext, recordAudit, recordSystemAudit }
export type { AuditEvent, AuditInput }
