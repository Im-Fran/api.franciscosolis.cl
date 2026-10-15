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
