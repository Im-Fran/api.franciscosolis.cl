import type { Context } from 'hono'
import type { AppEnv } from '@/env'
import type { Database } from '@/db/client'
import { auditLogs } from '@/db/schema'
import { generateId } from '@/lib/crypto'

/**
 * Events recorded in `audit_logs`. A closed set, and a runtime one: queries over the trail stay
 * reliable, and the administration API can hand an interface the whole catalog to filter by rather
 * than making it hardcode a list that drifts the moment an event is added here.
 */
const AUDIT_EVENTS = [
  'magic_link.requested',
  'magic_link.rate_limited',
  'magic_link.consumed',
  'magic_link.rejected',
  'oauth.authorize.started',
  'oauth.callback.succeeded',
  'oauth.callback.rejected',
  'signup.rejected',
  'user.created',
  'user.updated',
  'user.disabled',
  'user.enabled',
  'identity.linked',
  'token.issued',
  'token.refreshed',
  'token.reuse_detected',
  'token.revoked',
  'session.revoked',
  'invitation.created',
  'invitation.revoked',
  'invitation.resent',
  'invitation.accepted',
  'application.created',
  'application.updated',
  'application.secret_issued',
  'application.secret_rotated',
  'application.secret_revoked',
  /** A client presented credentials the token, revocation or introspection endpoint refused. */
  'client.authentication_failed',
  // Only `scripts/configure-applications.mjs` writes this one: the admin API deliberately has no
  // route that deletes a client, so it stays an operator-only action.
  'application.deleted',
  'role.created',
  'role.updated',
  'role.deleted',
  'role.granted',
  'role.revoked',
  'permission.created',
  'permission.updated',
  'permission.deleted',
  /** Avatar moderation: a user uploaded or withdrew one, a reviewer published or refused one. */
  'avatar.uploaded',
  'avatar.withdrawn',
  'avatar.approved',
  'avatar.rejected',
] as const

type AuditEvent = (typeof AUDIT_EVENTS)[number]

type AuditInput = {
  event: AuditEvent
  userId?: string | null
  applicationId?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * Appends an entry to the audit trail. Never throws: losing an audit row must not turn a successful
 * sign-in into a 500, and the trail is a diagnostic aid rather than a transactional guarantee.
 * `metadata` must never carry a token, a secret or a raw provider profile.
 */
const recordAudit = async (db: Database, input: AuditInput) => {
  try {
    await db.insert(auditLogs).values({
      id: generateId(),
      event: input.event,
      userId: input.userId ?? null,
      applicationId: input.applicationId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
  } catch (error) {
    console.error('failed to write audit log', input.event, error)
  }
}

/** Client fingerprint taken from Cloudflare's own headers, used on audit rows and sessions. */
const getRequestContext = (c: Context<AppEnv>) => ({
  ip: c.req.header('CF-Connecting-IP') ?? null,
  userAgent: c.req.header('User-Agent') ?? null,
})

export { AUDIT_EVENTS, getRequestContext, recordAudit }
export type { AuditEvent, AuditInput }
