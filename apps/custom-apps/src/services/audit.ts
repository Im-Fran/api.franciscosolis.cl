import type { Context } from 'hono'
import type { Database } from '@/db/client'
import { auditLogs } from '@/db/schema'
import type { AppEnv } from '@/env'

/** Events recorded in `audit_logs`. A closed set, so queries over the trail stay reliable. */
type AuditEvent =
  | 'company.created'
  | 'company.updated'
  | 'company.deleted'
  | 'contact.created'
  | 'contact.updated'
  | 'contact.deleted'
  | 'company_contact.linked'
  | 'company_contact.unlinked'
  | 'app.created'
  | 'app.updated'
  | 'app.deleted'
  /** The kill switch, kept apart from `app.updated`: "who suspended this app, and when" is its own question. */
  | 'app.state_changed'
  | 'app_key.created'
  | 'app_key.rotated'
  | 'app_key.revoked'
  /** Written by the ingest surface with no actor: auto-approval means nobody approved it. */
  | 'installation.enrolled'
  | 'installation.reenrolled'
  | 'installation.updated'
  | 'installation.reviewed'
  | 'installation.revoked'
  /** Remote operation: every command sent to a client's device, and every withdrawal of one. */
  | 'command.created'
  | 'command.cancelled'
  /** A screenshot removed — a client asking for an image of their customers to be deleted. */
  | 'screenshot.deleted'
  | 'flag.created'
  | 'flag.updated'
  | 'flag.deleted'
  /** A new version of the remote config document, schema changes included. */
  | 'config.published'
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'crash.status_changed'
  | 'alert_rule.created'
  | 'alert_rule.updated'
  | 'alert_rule.deleted'
  | 'alert.acknowledged'
  | 'alert.resolved'
  | 'ci_token.created'
  | 'ci_token.revoked'
  /** Written by the CI upload route, with no actor: the CI token is in the metadata. */
  | 'release.uploaded'
  | 'release.updated'
  | 'release.published'
  | 'release.rollout_changed'
  | 'release.paused'
  | 'release.resumed'
  | 'release.withdrawn'
  | 'release.rolled_back'
  | 'release.deleted'
  | 'contract.created'
  | 'contract.updated'
  /** By hand, or with no actor when a contract that renews itself reached its end. */
  | 'contract.renewed'
  | 'contract.cancelled'
  | 'contract.deleted'
  /** Written by the cron: the client was emailed and the covered apps show the notice. */
  | 'contract.notice_sent'
  /** Written by the cron: the contract ended without renewal and its apps went into grace. */
  | 'contract.lapsed'
  /** With no actor when the calendar closed it. */
  | 'cycle.closed'
  | 'cycle.billed'
  | 'work_log.created'
  | 'work_log.updated'
  | 'work_log.deleted'
  /** Written by the ingest surface with no actor: an app opened a support ticket. */
  | 'ticket.opened'
  | 'ticket.replied'
  | 'ticket.status_changed'
  /**
   * Scheduled maintenances. Every transition is its own event, with `resource_type = 'maintenance'`
   * and the app in the metadata. The cron's are written with no actor and `automatic: true`; an answer
   * through an approval link carries the address the link was sent to as the actor, no `actor_id`, and
   * `via: 'approval_link'`.
   */
  | 'maintenance.created'
  | 'maintenance.updated'
  | 'maintenance.deleted'
  | 'maintenance.window_added'
  | 'maintenance.window_updated'
  | 'maintenance.window_removed'
  | 'maintenance.sent'
  | 'maintenance.resent'
  | 'maintenance.approved'
  | 'maintenance.rejected'
  | 'maintenance.auto_applied'
  | 'maintenance.no_response'
  | 'maintenance.scheduled'
  | 'maintenance.reminded'
  | 'maintenance.started'
  | 'maintenance.completed'
  | 'maintenance.failed'
  | 'maintenance.cancelled'

type AuditInput = {
  event: AuditEvent
  actorEmail?: string | null
  actorId?: string | null
  resourceType?: string | null
  resourceId?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown> | null
}

/** The row an `auditLogs` insert takes, so a write can join a batch with the change it records. */
const auditRow = (input: AuditInput) => ({
  id: crypto.randomUUID(),
  event: input.event,
  actorEmail: input.actorEmail ?? null,
  actorId: input.actorId ?? null,
  resourceType: input.resourceType ?? null,
  resourceId: input.resourceId ?? null,
  ip: input.ip ?? null,
  userAgent: input.userAgent ?? null,
  metadata: input.metadata ? JSON.stringify(input.metadata) : null,
})

/**
 * Appends an entry to the audit trail. Never throws: losing an audit row must not turn a successful
 * change into a 500.
 */
const recordAudit = async (db: Database, input: AuditInput) => {
  try {
    await db.insert(auditLogs).values(auditRow(input))
  } catch (error) {
    console.error('failed to write audit log', input.event, error)
  }
}

/**
 * The fields of `before` that differ in `after`, as `{ before, after }` holding only those fields.
 * What an edit's audit row carries, so the trail says what changed rather than restating the row.
 */
const diff = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updated_at' || key === 'updated_by') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changedBefore[key] = before[key] ?? null
      changedAfter[key] = after[key] ?? null
    }
  }
  return { before: changedBefore, after: changedAfter }
}

/** Client fingerprint taken from Cloudflare's own headers. */
const getRequestContext = (c: Context<AppEnv>) => ({
  ip: c.req.header('CF-Connecting-IP') ?? null,
  userAgent: c.req.header('User-Agent') ?? null,
})

/** The actor fields of an audit row, read off the authenticated editor, plus the request context. */
const getActorContext = (c: Context<AppEnv>) => {
  const admin = c.get('admin')
  return { actorEmail: admin.email, actorId: admin.id, ...getRequestContext(c) }
}

export { auditRow, diff, getActorContext, getRequestContext, recordAudit }
export type { AuditEvent, AuditInput }
