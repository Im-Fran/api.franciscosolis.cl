import { and, eq, gt, isNull, or } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { invitations } from '@/db/schema'

type Invitation = typeof invitations.$inferSelect

/**
 * Finds a usable invitation for an address. An invitation is usable while it has not been accepted,
 * not been revoked and not expired. Global invitations (`application_id` NULL) grant access to every
 * client application; scoped ones only to the application they were issued for.
 */
const findPendingInvitation = async (
  db: Database,
  email: string,
  applicationId: string,
): Promise<Invitation | null> => {
  const [invitation] = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
        or(isNull(invitations.applicationId), eq(invitations.applicationId, applicationId)),
      ),
    )
    .limit(1)
  return invitation ?? null
}

/**
 * Marks an invitation as accepted. Guarded on `accepted_at IS NULL` so two concurrent sign-ups for
 * the same address cannot both consume it; the loser gets an empty result and simply moves on,
 * since by then the user row already exists either way.
 */
const acceptInvitation = async (db: Database, invitationId: string, userId: string) => {
  const accepted = await db
    .update(invitations)
    .set({ acceptedAt: new Date(), acceptedByUserId: userId, updatedAt: new Date() })
    .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt)))
    .returning({ id: invitations.id })

  return accepted.length > 0
}

/** Public shape of an invitation for the admin API. Carries no token material. */
const toPublicInvitation = (invitation: Invitation) => ({
  id: invitation.id,
  email: invitation.email,
  application_id: invitation.applicationId,
  role_id: invitation.roleId,
  invited_by: invitation.invitedBy,
  status: invitation.revokedAt
    ? 'revoked'
    : invitation.acceptedAt
      ? 'accepted'
      : invitation.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : 'pending',
  expires_at: invitation.expiresAt.toISOString(),
  accepted_at: invitation.acceptedAt?.toISOString() ?? null,
  accepted_by_user_id: invitation.acceptedByUserId,
  revoked_at: invitation.revokedAt?.toISOString() ?? null,
  created_at: invitation.createdAt.toISOString(),
})

export { acceptInvitation, findPendingInvitation, toPublicInvitation }
export type { Invitation }
