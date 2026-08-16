import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  applications,
  identities,
  invitations,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
} from '@/db/schema'
import type { ProviderName } from '@/lib/config'
import { generateId } from '@/lib/crypto'
import { signAccessToken } from '@/lib/jwt'
import type { Session } from '@/services/tokens'
import type { User } from '@/services/users'

/** Ids written by `0001_seed.sql` / `0002_cms_application.sql`, pinned so a change to them is loud. */
const SEED = {
  webAppId: 'franciscosolis-web',
  cmsAppId: 'franciscosolis-cms',
  webRedirectUri: 'https://franciscosolis.cl/auth/callback',
  webLocalRedirectUri: 'http://localhost:5173/auth/callback',
  cmsRedirectUri: 'https://cms.franciscosolis.cl/auth/callback',
  adminRoleId: '8e7a797c-5012-4a96-a9a2-e8b5bdaeb802',
  userRoleId: 'e159f911-541f-4d48-806e-aaa94971c9a9',
  /** The single address `BOOTSTRAP_ADMIN_EMAILS` carries in `wrangler.jsonc`. */
  bootstrapAdminEmail: 'f.solism@icloud.com',
} as const

const db = () => getDb(env)

/**
 * D1 stores every timestamp as whole unix seconds, so a fixture built with millisecond precision
 * would not survive a round trip. Truncating up front keeps `createUser(...)` comparable with what
 * the API later renders.
 */
const nowInSeconds = () => new Date(Math.floor(Date.now() / 1000) * 1000)

/** Every test file shares one database, so addresses have to be unique per test to stay isolated. */
const uniqueEmail = (prefix = 'user') => `${prefix}-${crypto.randomUUID()}@example.test`

type CreateUserInput = Partial<Omit<User, 'id'>> & { id?: string }

const createUser = async (overrides: CreateUserInput = {}): Promise<User> => {
  const now = nowInSeconds()
  const user: User = {
    id: overrides.id ?? generateId(),
    email: overrides.email ?? uniqueEmail(),
    // An explicit null has to survive: an unverified address is a state the tests need to build.
    emailVerifiedAt: 'emailVerifiedAt' in overrides ? (overrides.emailVerifiedAt ?? null) : now,
    name: overrides.name ?? null,
    givenName: overrides.givenName ?? null,
    familyName: overrides.familyName ?? null,
    picture: overrides.picture ?? null,
    locale: overrides.locale ?? null,
    status: overrides.status ?? 'active',
    lastLoginAt: overrides.lastLoginAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  }
  await db().insert(users).values(user)
  return user
}

const findUser = async (id: string) => {
  const [row] = await db().select().from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

type CreateRoleInput = {
  slug?: string
  name?: string
  applicationId?: string | null
  isDefault?: boolean
  permissions?: string[]
}

/** Creates a role and attaches the named seeded permissions to it. */
const createRole = async (input: CreateRoleInput = {}) => {
  const now = new Date()
  const role = {
    id: generateId(),
    applicationId: input.applicationId ?? null,
    slug: input.slug ?? `role-${crypto.randomUUID().slice(0, 8)}`,
    name: input.name ?? 'Test role',
    description: null,
    isDefault: input.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(roles).values(role)

  for (const slug of input.permissions ?? []) {
    const [permission] = await db().select().from(permissions).where(eq(permissions.slug, slug)).limit(1)
    if (!permission) {
      throw new Error(`unknown seeded permission: ${slug}`)
    }
    await db().insert(rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing()
  }

  return role
}

const grant = async (userId: string, roleId: string) => {
  await db().insert(userRoles).values({ userId, roleId }).onConflictDoNothing()
}

const createApplication = async (
  overrides: { id?: string; name?: string; redirectUris?: string[]; clientSecretHash?: string | null; isActive?: boolean } = {},
) => {
  const now = new Date()
  const application = {
    id: overrides.id ?? `app-${crypto.randomUUID().slice(0, 8)}`,
    name: overrides.name ?? 'Test application',
    description: null,
    clientSecretHash: overrides.clientSecretHash ?? null,
    redirectUris: JSON.stringify(overrides.redirectUris ?? ['https://client.test/callback']),
    isActive: overrides.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(applications).values(application)
  return application
}

const createSessionRow = async (
  input: { userId: string; applicationId?: string; provider?: ProviderName; scope?: string | null; revokedAt?: Date | null },
): Promise<Session> => {
  const now = new Date()
  const session: Session = {
    id: generateId(),
    userId: input.userId,
    applicationId: input.applicationId ?? SEED.webAppId,
    provider: input.provider ?? 'magic_link',
    scope: input.scope ?? 'openid profile email',
    lastSeenAt: now,
    revokedAt: input.revokedAt ?? null,
    revokedReason: input.revokedAt ? 'test' : null,
    ip: null,
    userAgent: null,
    createdAt: now,
  }
  await db().insert(sessions).values(session)
  return session
}

const createInvitation = async (
  input: {
    email: string
    applicationId?: string | null
    roleId?: string | null
    invitedBy?: string | null
    expiresAt?: Date
    acceptedAt?: Date | null
    revokedAt?: Date | null
  },
) => {
  const now = new Date()
  const invitation = {
    id: generateId(),
    email: input.email,
    applicationId: input.applicationId ?? null,
    roleId: input.roleId ?? null,
    invitedBy: input.invitedBy ?? null,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 86_400_000),
    acceptedAt: input.acceptedAt ?? null,
    acceptedByUserId: null,
    revokedAt: input.revokedAt ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(invitations).values(invitation)
  return invitation
}

const createIdentity = async (
  input: {
    userId: string
    provider: ProviderName
    providerAccountId: string
    email?: string | null
    lastUsedAt?: Date | null
  },
) => {
  const now = nowInSeconds()
  const identity = {
    id: generateId(),
    userId: input.userId,
    provider: input.provider,
    providerAccountId: input.providerAccountId,
    email: input.email ?? null,
    profile: null,
    lastUsedAt: 'lastUsedAt' in input ? (input.lastUsedAt ?? null) : now,
    createdAt: now,
    updatedAt: now,
  }
  await db().insert(identities).values(identity)
  return identity
}

type SignInInput = {
  user?: User
  applicationId?: string
  provider?: ProviderName
  roleIds?: string[]
  /** Claims baked into the token. They are deliberately allowed to disagree with the database. */
  claimedRoles?: string[]
  claimedPermissions?: string[]
}

/**
 * Mints an access token for a real user and a real session, which is what every authenticated
 * request in this suite needs. `claimedRoles` / `claimedPermissions` exist so a test can prove the
 * middleware ignores the token body and reads the database instead.
 */
const signIn = async (input: SignInInput = {}) => {
  const user = input.user ?? (await createUser())
  const applicationId = input.applicationId ?? SEED.webAppId
  for (const roleId of input.roleIds ?? []) {
    await grant(user.id, roleId)
  }
  const session = await createSessionRow({ userId: user.id, applicationId, provider: input.provider })
  const { token, expiresAt } = await signAccessToken(env, {
    sub: user.id,
    aud: applicationId,
    sid: session.id,
    provider: input.provider ?? 'magic_link',
    email: user.email,
    email_verified: user.emailVerifiedAt !== null,
    name: user.name,
    picture: user.picture,
    roles: input.claimedRoles ?? [],
    permissions: input.claimedPermissions ?? [],
  })

  return { user, session, token, expiresAt, applicationId }
}

/** An access token whose bearer holds every seeded permission, for exercising the admin API. */
const signInAsAdmin = async (input: SignInInput = {}) => signIn({ ...input, roleIds: [SEED.adminRoleId, ...(input.roleIds ?? [])] })

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

export {
  bearer,
  createApplication,
  createIdentity,
  createInvitation,
  createRole,
  createSessionRow,
  createUser,
  db,
  findUser,
  grant,
  SEED,
  signIn,
  signInAsAdmin,
  uniqueEmail,
}
