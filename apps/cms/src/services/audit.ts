import type { Context } from 'hono'
import type { Database } from '@/db/client'
import { auditLogs } from '@/db/schema'
import type { AppEnv } from '@/env'

/** Events recorded in `audit_logs`. Kept as a closed set so queries over the trail stay reliable. */
type AuditEvent =
  | 'content.created'
  | 'content.updated'
  | 'content.deleted'
  | 'content.reordered'
  | 'legal.created'
  | 'legal.updated'
  | 'legal.deleted'
  | 'email_template.created'
  | 'email_template.updated'
  | 'email_template.deleted'
  | 'email.sent'
  | 'email.failed'

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

/**
 * Appends an entry to the audit trail. Never throws: losing an audit row must not turn a successful
 * edit into a 500, and the trail is a diagnostic aid rather than a transactional guarantee.
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
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
  } catch (error) {
    console.error('failed to write audit log', input.event, error)
  }
}

/** Client fingerprint taken from Cloudflare's own headers, used on audit rows. */
const getRequestContext = (c: Context<AppEnv>) => ({
  ip: c.req.header('CF-Connecting-IP') ?? null,
  userAgent: c.req.header('User-Agent') ?? null,
})

/** Shorthand for the actor fields of an audit row, read off the authenticated editor. */
const getActorContext = (c: Context<AppEnv>) => {
  const editor = c.get('editor')
  return { actorEmail: editor.email, actorId: editor.id }
}

export { getActorContext, getRequestContext, recordAudit }
export type { AuditEvent, AuditInput }
