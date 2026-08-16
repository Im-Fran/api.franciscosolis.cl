import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { identities, invitations, userRoles, users } from '@/db/schema'
import { OAuthException } from '@/lib/errors'
import type { ProviderProfile } from '@/providers/types'
import {
  findUserByEmail,
  findUserById,
  getDefaultRoles,
  getRoleBySlug,
  getUserAuthorization,
  grantRole,
  isBootstrapAdmin,
  normalizeEmail,
  resolveUserForProfile,
  toPublicUser,
} from '@/services/users'
import { createInvitation, createRole, createUser, db, grant, SEED, uniqueEmail } from '../helpers/db'
import { testEnv } from '../helpers/env'

const profile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  provider: 'google',
  providerAccountId: `sub-${crypto.randomUUID()}`,
  email: uniqueEmail('profile'),
  emailVerified: true,
  ...overrides,
})

/** An environment where nobody is a bootstrap admin, so the invitation rules are the only path in. */
const closedEnv = testEnv({ BOOTSTRAP_ADMIN_EMAILS: '' })

const rolesOf = async (userId: string) =>
  (await db().select().from(userRoles).where(eq(userRoles.userId, userId))).map((row) => row.roleId).sort()

describe('normalizeEmail', () => {
  it('lowercases and trims, because it is the key providers are matched on', () => {
    expect(normalizeEmail('  Someone@Example.TEST \n')).toBe('someone@example.test')
  })

  it('leaves an already-normalized address alone', () => {
    expect(normalizeEmail('someone@example.test')).toBe('someone@example.test')
  })
})

describe('isBootstrapAdmin', () => {
  it('matches an address in the list regardless of case or padding', () => {
    const configured = testEnv({ BOOTSTRAP_ADMIN_EMAILS: ' First@Example.test , second@example.test ' })

    expect(isBootstrapAdmin(configured, 'first@example.test')).toBe(true)
    expect(isBootstrapAdmin(configured, ' SECOND@example.TEST ')).toBe(true)
  })

  it('refuses an address that is not listed', () => {
    const configured = testEnv({ BOOTSTRAP_ADMIN_EMAILS: 'first@example.test' })

    expect(isBootstrapAdmin(configured, 'other@example.test')).toBe(false)
    // A prefix must not match: sign-up would otherwise be open to a lookalike address.
    expect(isBootstrapAdmin(configured, 'first@example.test.evil')).toBe(false)
  })

  it('treats an empty or missing variable as nobody, not everybody', () => {
    expect(isBootstrapAdmin(testEnv({ BOOTSTRAP_ADMIN_EMAILS: '' }), '')).toBe(false)
    expect(isBootstrapAdmin(testEnv({ BOOTSTRAP_ADMIN_EMAILS: ',,' }), '')).toBe(false)
    expect(isBootstrapAdmin(testEnv({ BOOTSTRAP_ADMIN_EMAILS: undefined as unknown as string }), 'a@b.test')).toBe(false)
  })

  it('recognises the address configured for this deployment', () => {
    expect(isBootstrapAdmin(env, SEED.bootstrapAdminEmail)).toBe(true)
  })
})

describe('findUserByEmail / findUserById', () => {
  it('finds a user by their normalized address', async () => {
    const user = await createUser({ email: uniqueEmail('lookup') })

    await expect(findUserByEmail(db(), user.email.toUpperCase())).resolves.toMatchObject({ id: user.id })
    await expect(findUserById(db(), user.id)).resolves.toMatchObject({ email: user.email })
  })

  it('returns null instead of throwing when nobody matches', async () => {
    await expect(findUserByEmail(db(), 'nobody@example.test')).resolves.toBeNull()
    await expect(findUserById(db(), crypto.randomUUID())).resolves.toBeNull()
  })
})

describe('getUserAuthorization', () => {
  it('returns nothing for a user with no roles', async () => {
    const user = await createUser()

    await expect(getUserAuthorization(db(), user.id, SEED.webAppId)).resolves.toEqual({ roles: [], permissions: [] })
  })

  it('applies a global role to every application', async () => {
    const user = await createUser()
    await grant(user.id, SEED.adminRoleId)

    for (const applicationId of [SEED.webAppId, SEED.cmsAppId]) {
      const authorization = await getUserAuthorization(db(), user.id, applicationId)
      expect(authorization.roles).toEqual(['admin'])
      expect(authorization.permissions).toContain('users:read')
    }
  })

  it('applies an application-scoped role only inside its own application', async () => {
    const user = await createUser()
    const scoped = await createRole({ slug: 'editor', applicationId: SEED.cmsAppId, permissions: ['users:read'] })
    await grant(user.id, scoped.id)

    await expect(getUserAuthorization(db(), user.id, SEED.cmsAppId)).resolves.toEqual({
      roles: ['editor'],
      permissions: ['users:read'],
    })
    await expect(getUserAuthorization(db(), user.id, SEED.webAppId)).resolves.toEqual({ roles: [], permissions: [] })
  })

  it('merges global and scoped roles, sorted, granting a shared permission exactly once', async () => {
    const user = await createUser()
    // Both roles carry `users:read`, so the union has to collapse it; each also carries one
    // permission of its own, so a union that dropped either role would be visible too.
    const global = await createRole({ slug: 'global-auditor', permissions: ['users:read', 'audit:read'] })
    const scoped = await createRole({
      slug: 'web-auditor',
      applicationId: SEED.webAppId,
      permissions: ['users:read', 'roles:read'],
    })
    await grant(user.id, global.id)
    await grant(user.id, scoped.id)

    const authorization = await getUserAuthorization(db(), user.id, SEED.webAppId)

    expect(authorization.roles).toEqual(['global-auditor', 'web-auditor'])
    expect(authorization.permissions).toEqual(['audit:read', 'roles:read', 'users:read'])
    expect(authorization.permissions.filter((slug) => slug === 'users:read')).toHaveLength(1)
  })

  it('lists a slug once when a global and a scoped role happen to share it', async () => {
    const user = await createUser()
    // The schema allows this: the unique indexes on `roles.slug` are partial, one per scope.
    const global = await createRole({ slug: 'ambiguous', applicationId: null, permissions: ['audit:read'] })
    const scoped = await createRole({ slug: 'ambiguous', applicationId: SEED.webAppId, permissions: ['audit:read'] })
    await grant(user.id, global.id)
    await grant(user.id, scoped.id)

    const authorization = await getUserAuthorization(db(), user.id, SEED.webAppId)

    expect(authorization.roles).toEqual(['ambiguous'])
    expect(authorization.permissions).toEqual(['audit:read'])
  })

  it('keeps a permission the user still holds through a second role after one is revoked', async () => {
    const user = await createUser()
    const first = await createRole({ slug: 'overlap-a', permissions: ['users:read'] })
    const second = await createRole({ slug: 'overlap-b', permissions: ['users:read'] })
    await grant(user.id, first.id)
    await grant(user.id, second.id)

    await db().delete(userRoles).where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, first.id)))

    await expect(getUserAuthorization(db(), user.id, SEED.webAppId)).resolves.toEqual({
      roles: ['overlap-b'],
      permissions: ['users:read'],
    })
  })

  it('drops a permission as soon as the role granting it is revoked', async () => {
    const user = await createUser()
    const role = await createRole({ permissions: ['roles:write'] })
    await grant(user.id, role.id)

    await expect(getUserAuthorization(db(), user.id, SEED.webAppId)).resolves.toMatchObject({
      permissions: ['roles:write'],
    })

    await db().delete(userRoles).where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, role.id)))

    await expect(getUserAuthorization(db(), user.id, SEED.webAppId)).resolves.toEqual({ roles: [], permissions: [] })
  })

  it('lists a role with no permissions attached', async () => {
    const user = await createUser()
    const role = await createRole({ slug: 'empty-role' })
    await grant(user.id, role.id)

    await expect(getUserAuthorization(db(), user.id, SEED.webAppId)).resolves.toEqual({
      roles: ['empty-role'],
      permissions: [],
    })
  })
})

describe('grantRole', () => {
  it('is idempotent, so granting twice does not fail or duplicate the row', async () => {
    const user = await createUser()

    await grantRole(db(), user.id, SEED.userRoleId)
    await grantRole(db(), user.id, SEED.userRoleId)

    expect(await rolesOf(user.id)).toEqual([SEED.userRoleId])
  })

  it('records who granted the role when told', async () => {
    const [user, granter] = await Promise.all([createUser(), createUser()])
    await grantRole(db(), user.id, SEED.adminRoleId, granter.id)

    const [row] = await db().select().from(userRoles).where(eq(userRoles.userId, user.id))

    expect(row?.grantedBy).toBe(granter.id)
  })
})

describe('getDefaultRoles', () => {
  it('includes the seeded global default role for every application', async () => {
    const web = await getDefaultRoles(db(), SEED.webAppId)
    const cms = await getDefaultRoles(db(), SEED.cmsAppId)

    expect(web.map((role) => role.id)).toContain(SEED.userRoleId)
    expect(cms.map((role) => role.id)).toContain(SEED.userRoleId)
  })

  it('includes an application-scoped default only for that application', async () => {
    const scoped = await createRole({ slug: 'cms-default', applicationId: SEED.cmsAppId, isDefault: true })

    expect((await getDefaultRoles(db(), SEED.cmsAppId)).map((role) => role.id)).toContain(scoped.id)
    expect((await getDefaultRoles(db(), SEED.webAppId)).map((role) => role.id)).not.toContain(scoped.id)
  })

  it('excludes roles that are not marked default', async () => {
    const role = await createRole({ slug: 'not-default', isDefault: false })

    expect((await getDefaultRoles(db(), SEED.webAppId)).map((entry) => entry.id)).not.toContain(role.id)
  })
})

describe('getRoleBySlug', () => {
  it('finds a global role when asked for the global scope', async () => {
    await expect(getRoleBySlug(db(), 'admin', null)).resolves.toMatchObject({ id: SEED.adminRoleId })
  })

  it('does not return a global role when an application scope was asked for', async () => {
    await expect(getRoleBySlug(db(), 'admin', SEED.webAppId)).resolves.toBeNull()
  })

  it('distinguishes two roles that share a slug across scopes', async () => {
    const scoped = await createRole({ slug: 'shared-slug', applicationId: SEED.webAppId })
    const global = await createRole({ slug: 'shared-slug', applicationId: null })

    await expect(getRoleBySlug(db(), 'shared-slug', SEED.webAppId)).resolves.toMatchObject({ id: scoped.id })
    await expect(getRoleBySlug(db(), 'shared-slug', null)).resolves.toMatchObject({ id: global.id })
  })

  it('returns null for an unknown slug', async () => {
    await expect(getRoleBySlug(db(), 'no-such-role', null)).resolves.toBeNull()
  })
})

describe('resolveUserForProfile', () => {
  it('refuses a profile the provider did not verify', async () => {
    // Linking on an unverified address would let a new provider claim someone else's account.
    await expect(
      resolveUserForProfile(db(), closedEnv, profile({ emailVerified: false }), SEED.webAppId),
    ).rejects.toThrow(new OAuthException(403, 'access_denied', 'The provider did not verify this email address'))
  })

  it('refuses an unknown address with no invitation', async () => {
    await expect(resolveUserForProfile(db(), closedEnv, profile(), SEED.webAppId)).rejects.toMatchObject({
      status: 403,
      code: 'access_denied',
      description: 'This email address has not been invited',
    })
  })

  it('creates the account when a pending invitation exists, and consumes the invitation', async () => {
    const email = uniqueEmail('invited')
    const role = await createRole({ slug: 'invited-role' })
    const invitation = await createInvitation({ email, roleId: role.id })

    const result = await resolveUserForProfile(db(), closedEnv, profile({ email }), SEED.webAppId)

    expect(result.isNewUser).toBe(true)
    expect(result.user.email).toBe(email)
    expect(result.user.emailVerifiedAt).not.toBeNull()

    const [stored] = await db().select().from(invitations).where(eq(invitations.id, invitation.id))
    expect(stored?.acceptedAt).not.toBeNull()
    expect(stored?.acceptedByUserId).toBe(result.user.id)

    // The invitation's role is granted on top of the scope's default role.
    expect(await rolesOf(result.user.id)).toEqual([role.id, SEED.userRoleId].sort())
  })

  it('creates the account from a global invitation with no role attached', async () => {
    const email = uniqueEmail('plain-invite')
    await createInvitation({ email })

    const result = await resolveUserForProfile(db(), closedEnv, profile({ email }), SEED.webAppId)

    expect(await rolesOf(result.user.id)).toEqual([SEED.userRoleId])
  })

  it('ignores an invitation scoped to another application', async () => {
    const email = uniqueEmail('scoped-invite')
    await createInvitation({ email, applicationId: SEED.cmsAppId })

    await expect(resolveUserForProfile(db(), closedEnv, profile({ email }), SEED.webAppId)).rejects.toThrow(
      'This email address has not been invited',
    )
    await expect(resolveUserForProfile(db(), closedEnv, profile({ email }), SEED.cmsAppId)).resolves.toMatchObject({
      isNewUser: true,
    })
  })

  it('lets a bootstrap admin in without an invitation and grants them the admin role', async () => {
    const email = uniqueEmail('bootstrap')
    const bootstrapEnv = testEnv({ BOOTSTRAP_ADMIN_EMAILS: `other@example.test,${email.toUpperCase()}` })

    const result = await resolveUserForProfile(db(), bootstrapEnv, profile({ email }), SEED.webAppId)

    expect(result.isNewUser).toBe(true)
    expect(await rolesOf(result.user.id)).toEqual([SEED.adminRoleId, SEED.userRoleId].sort())
  })

  it('records the profile fields and the raw payload on the new identity', async () => {
    const email = uniqueEmail('identity')
    await createInvitation({ email })
    const raw = { sub: 'abc', hd: 'example.test' }

    const result = await resolveUserForProfile(
      db(),
      closedEnv,
      profile({ email, providerAccountId: 'sub-identity', name: 'Ada', givenName: 'Ada', familyName: 'L', picture: 'https://p.test/a.png', locale: 'en', raw }),
      SEED.webAppId,
    )

    expect(result.user).toMatchObject({ name: 'Ada', givenName: 'Ada', familyName: 'L', locale: 'en' })

    const [identity] = await db().select().from(identities).where(eq(identities.userId, result.user.id))
    expect(identity).toMatchObject({ provider: 'google', providerAccountId: 'sub-identity', email })
    expect(JSON.parse(identity?.profile ?? 'null')).toEqual(raw)
  })

  it('signs an existing identity straight in, without needing an invitation', async () => {
    const email = uniqueEmail('returning')
    await createInvitation({ email })
    const first = await resolveUserForProfile(db(), closedEnv, profile({ email, providerAccountId: 'sub-returning' }), SEED.webAppId)

    const second = await resolveUserForProfile(
      db(),
      closedEnv,
      profile({ email, providerAccountId: 'sub-returning' }),
      SEED.webAppId,
    )

    expect(second.isNewUser).toBe(false)
    expect(second.user.id).toBe(first.user.id)
    expect(await db().select().from(identities).where(eq(identities.userId, first.user.id))).toHaveLength(1)
  })

  it('links a second provider to an existing account matched by email', async () => {
    const user = await createUser({ email: uniqueEmail('linked') })

    const result = await resolveUserForProfile(
      db(),
      closedEnv,
      profile({ email: user.email.toUpperCase(), providerAccountId: 'sub-link' }),
      SEED.webAppId,
    )

    expect(result.isNewUser).toBe(false)
    expect(result.user.id).toBe(user.id)

    const linked = await db().select().from(identities).where(eq(identities.userId, user.id))
    expect(linked).toHaveLength(1)
    expect(linked[0]?.email).toBe(user.email)
  })

  it('does not hand a linked account any default role it was not already given', async () => {
    const user = await createUser({ email: uniqueEmail('nodefault') })

    await resolveUserForProfile(db(), closedEnv, profile({ email: user.email }), SEED.webAppId)

    expect(await rolesOf(user.id)).toEqual([])
  })

  it('refuses a disabled account reached through an existing identity', async () => {
    const email = uniqueEmail('disabled-identity')
    await createInvitation({ email })
    const created = await resolveUserForProfile(db(), closedEnv, profile({ email, providerAccountId: 'sub-disabled' }), SEED.webAppId)
    await db().update(users).set({ status: 'disabled' }).where(eq(users.id, created.user.id))

    await expect(
      resolveUserForProfile(db(), closedEnv, profile({ email, providerAccountId: 'sub-disabled' }), SEED.webAppId),
    ).rejects.toThrow(new OAuthException(403, 'access_denied', 'This account is disabled'))
  })

  it('refuses a disabled account reached by email, without linking a new identity', async () => {
    const user = await createUser({ email: uniqueEmail('disabled-email'), status: 'disabled' })

    await expect(resolveUserForProfile(db(), closedEnv, profile({ email: user.email }), SEED.webAppId)).rejects.toThrow(
      'This account is disabled',
    )
    expect(await db().select().from(identities).where(eq(identities.userId, user.id))).toHaveLength(0)
  })

  it('fills in empty profile fields on sign-in but never overwrites what the user set', async () => {
    const user = await createUser({ email: uniqueEmail('merge'), name: 'Chosen name', picture: null })

    const result = await resolveUserForProfile(
      db(),
      closedEnv,
      profile({ email: user.email, name: 'Provider name', picture: 'https://p.test/new.png', locale: 'es' }),
      SEED.webAppId,
    )

    expect(result.user.name).toBe('Chosen name')
    expect(result.user.picture).toBe('https://p.test/new.png')
    expect(result.user.locale).toBe('es')

    const [persisted] = await db().select().from(users).where(eq(users.id, user.id))
    expect(persisted).toMatchObject({ name: 'Chosen name', picture: 'https://p.test/new.png' })
  })

  it('stamps lastLoginAt and verifies the address on an existing account', async () => {
    const user = await createUser({ email: uniqueEmail('lastlogin'), emailVerifiedAt: null, lastLoginAt: null })

    await resolveUserForProfile(db(), closedEnv, profile({ email: user.email }), SEED.webAppId)

    const [persisted] = await db().select().from(users).where(eq(users.id, user.id))
    expect(persisted?.lastLoginAt).not.toBeNull()
    expect(persisted?.emailVerifiedAt).not.toBeNull()
  })

  it('refreshes the identity row on every sign-in', async () => {
    const email = uniqueEmail('refresh-identity')
    await createInvitation({ email })
    const created = await resolveUserForProfile(db(), closedEnv, profile({ email, providerAccountId: 'sub-refresh' }), SEED.webAppId)
    const [before] = await db().select().from(identities).where(eq(identities.userId, created.user.id))

    await resolveUserForProfile(
      db(),
      closedEnv,
      profile({ email, providerAccountId: 'sub-refresh', raw: { round: 'two' } }),
      SEED.webAppId,
    )

    const [after] = await db().select().from(identities).where(eq(identities.userId, created.user.id))
    expect(JSON.parse(after?.profile ?? 'null')).toEqual({ round: 'two' })
    expect(after?.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(before?.lastUsedAt?.getTime() ?? 0)
  })

  it('stores the address normalized even when the provider reports it in mixed case', async () => {
    const email = uniqueEmail('MixedCase').toUpperCase()
    await createInvitation({ email: email.toLowerCase() })

    const result = await resolveUserForProfile(db(), closedEnv, profile({ email }), SEED.webAppId)

    expect(result.user.email).toBe(email.toLowerCase())
  })
})

describe('toPublicUser', () => {
  it('renders timestamps as ISO strings and derives email_verified', async () => {
    const user = await createUser({
      name: 'Ada',
      lastLoginAt: new Date('2026-01-02T03:04:05.000Z'),
      createdAt: new Date('2025-12-31T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(toPublicUser(user)).toEqual({
      id: user.id,
      email: user.email,
      email_verified: true,
      name: 'Ada',
      given_name: null,
      family_name: null,
      picture: null,
      locale: null,
      status: 'active',
      last_login_at: '2026-01-02T03:04:05.000Z',
      created_at: '2025-12-31T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
  })

  it('reports an unverified address and a user who has never signed in', async () => {
    const user = await createUser({ emailVerifiedAt: null, lastLoginAt: null })

    expect(toPublicUser(user)).toMatchObject({ email_verified: false, last_login_at: null })
  })

  it('never exposes anything beyond the documented fields', async () => {
    const user = await createUser()

    expect(Object.keys(toPublicUser(user)).sort()).toEqual([
      'created_at',
      'email',
      'email_verified',
      'family_name',
      'given_name',
      'id',
      'last_login_at',
      'locale',
      'name',
      'picture',
      'status',
      'updated_at',
    ])
  })
})
