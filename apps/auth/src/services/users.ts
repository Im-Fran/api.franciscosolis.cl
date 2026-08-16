import { and, eq, isNull, or } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { identities, permissions, rolePermissions, roles, userRoles, users } from '@/db/schema'
import type { ProviderName } from '@/lib/config'
import { generateId } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { acceptInvitation, findPendingInvitation } from '@/services/invitations'
import type { ProviderProfile } from '@/providers/types'

type User = typeof users.$inferSelect

/** Emails are compared case-insensitively; the normalized form is what gets stored. */
const normalizeEmail = (email: string) => email.trim().toLowerCase()

const findUserByEmail = async (db: Database, email: string): Promise<User | null> => {
  const [user] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1)
  return user ?? null
}

const findUserById = async (db: Database, id: string): Promise<User | null> => {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return user ?? null
}

/** Roles in scope for an application: global roles plus roles scoped to that application. */
const inScope = (applicationId: string) => or(isNull(roles.applicationId), eq(roles.applicationId, applicationId))

/**
 * Resolves the role slugs and permission slugs a user holds for one application. This is the single
 * place authorization is computed — both the access token claims and the admin route guards read it,
 * so a token and a live check can never disagree about what a role means.
 */
const getUserAuthorization = async (db: Database, userId: string, applicationId: string) => {
  const roleRows = await db
    .select({ id: roles.id, slug: roles.slug })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), inScope(applicationId)))

  const permissionRows = await db
    .select({ slug: permissions.slug })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(userRoles.userId, userId), inScope(applicationId)))

  return {
    roles: [...new Set(roleRows.map((row) => row.slug))].sort(),
    permissions: [...new Set(permissionRows.map((row) => row.slug))].sort(),
  }
}

const grantRole = async (db: Database, userId: string, roleId: string, grantedBy?: string | null) => {
  await db
    .insert(userRoles)
    .values({ userId, roleId, grantedBy: grantedBy ?? null })
    .onConflictDoNothing()
}

/** Roles handed out automatically on first sign-in: the global default plus the app's own default. */
const getDefaultRoles = async (db: Database, applicationId: string) =>
  db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.isDefault, true), inScope(applicationId)))

const getRoleBySlug = async (db: Database, slug: string, applicationId: string | null) => {
  const [role] = await db
    .select()
    .from(roles)
    .where(
      and(
        eq(roles.slug, slug),
        applicationId === null ? isNull(roles.applicationId) : eq(roles.applicationId, applicationId),
      ),
    )
    .limit(1)
  return role ?? null
}

type ResolveResult = {
  user: User
  isNewUser: boolean
}

/**
 * Turns a verified provider profile into a user row — the step every provider funnels into.
 *
 * Three cases, in order:
 *  1. The provider identity is already linked: that user signs in.
 *  2. The email matches an existing user: the identity is linked to it. Only safe because the
 *     caller guarantees the provider verified the address (see the check below); linking on an
 *     unverified email would let anyone claim an account by signing up elsewhere with that address.
 *  3. Nobody matches: this is a sign-up, which requires a pending invitation for the address.
 *     The very first account is seeded straight into the database by `scripts/bootstrap-admin.mjs`.
 */
const resolveUserForProfile = async (
  db: Database,
  profile: ProviderProfile,
  applicationId: string,
): Promise<ResolveResult> => {
  if (!profile.emailVerified) {
    throw new OAuthException(403, 'access_denied', 'The provider did not verify this email address')
  }

  const email = normalizeEmail(profile.email)
  const now = new Date()

  const [existingIdentity] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.provider, profile.provider), eq(identities.providerAccountId, profile.providerAccountId)))
    .limit(1)

  if (existingIdentity) {
    const user = await findUserById(db, existingIdentity.userId)
    if (!user) {
      throw new OAuthException(500, 'server_error', 'Identity points at a user that no longer exists')
    }
    assertUserActive(user)

    await db
      .update(identities)
      .set({ email, profile: JSON.stringify(profile.raw ?? null), lastUsedAt: now, updatedAt: now })
      .where(eq(identities.id, existingIdentity.id))

    return { user: await applyProfileToUser(db, user, profile), isNewUser: false }
  }

  const existingUser = await findUserByEmail(db, email)
  if (existingUser) {
    assertUserActive(existingUser)
    await linkIdentity(db, existingUser.id, profile, email)
    return { user: await applyProfileToUser(db, existingUser, profile), isNewUser: false }
  }

  const invitation = await findPendingInvitation(db, email, applicationId)
  if (!invitation) {
    throw new OAuthException(403, 'access_denied', 'This email address has not been invited')
  }

  const user: User = {
    id: generateId(),
    email,
    emailVerifiedAt: now,
    name: profile.name ?? null,
    givenName: profile.givenName ?? null,
    familyName: profile.familyName ?? null,
    picture: profile.picture ?? null,
    locale: profile.locale ?? null,
    status: 'active',
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(users).values(user)
  await linkIdentity(db, user.id, profile, email)

  for (const role of await getDefaultRoles(db, applicationId)) {
    await grantRole(db, user.id, role.id)
  }

  if (invitation.roleId) {
    await grantRole(db, user.id, invitation.roleId, invitation.invitedBy)
  }
  await acceptInvitation(db, invitation.id, user.id)

  return { user, isNewUser: true }
}

const assertUserActive = (user: User) => {
  if (user.status !== 'active') {
    throw new OAuthException(403, 'access_denied', 'This account is disabled')
  }
}

const linkIdentity = async (db: Database, userId: string, profile: ProviderProfile, email: string) => {
  const now = new Date()
  await db.insert(identities).values({
    id: generateId(),
    userId,
    provider: profile.provider,
    providerAccountId: profile.providerAccountId,
    email,
    profile: JSON.stringify(profile.raw ?? null),
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * Refreshes the profile fields a provider owns, without overwriting anything the user set by hand:
 * a Google display name fills an empty `name`, it does not replace one the user chose themselves.
 */
const applyProfileToUser = async (db: Database, user: User, profile: ProviderProfile): Promise<User> => {
  const now = new Date()
  const updated: User = {
    ...user,
    name: user.name ?? profile.name ?? null,
    givenName: user.givenName ?? profile.givenName ?? null,
    familyName: user.familyName ?? profile.familyName ?? null,
    picture: user.picture ?? profile.picture ?? null,
    locale: user.locale ?? profile.locale ?? null,
    emailVerifiedAt: user.emailVerifiedAt ?? now,
    lastLoginAt: now,
    updatedAt: now,
  }

  await db
    .update(users)
    .set({
      name: updated.name,
      givenName: updated.givenName,
      familyName: updated.familyName,
      picture: updated.picture,
      locale: updated.locale,
      emailVerifiedAt: updated.emailVerifiedAt,
      lastLoginAt: updated.lastLoginAt,
      updatedAt: updated.updatedAt,
    })
    .where(eq(users.id, user.id))

  return updated
}

/** Public shape of a user, shared by `/me` and the admin API. */
const toPublicUser = (user: User) => ({
  id: user.id,
  email: user.email,
  email_verified: user.emailVerifiedAt !== null,
  name: user.name,
  given_name: user.givenName,
  family_name: user.familyName,
  picture: user.picture,
  locale: user.locale,
  status: user.status,
  last_login_at: user.lastLoginAt?.toISOString() ?? null,
  created_at: user.createdAt.toISOString(),
  updated_at: user.updatedAt.toISOString(),
})

export {
  findUserByEmail,
  findUserById,
  getDefaultRoles,
  getRoleBySlug,
  getUserAuthorization,
  grantRole,
  normalizeEmail,
  resolveUserForProfile,
  toPublicUser,
}
export type { User }
