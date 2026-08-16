import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { invitations } from '@/db/schema'
import { acceptInvitation, findPendingInvitation, toPublicInvitation } from '@/services/invitations'
import type { Invitation } from '@/services/invitations'
import { createInvitation, createUser, db, SEED, uniqueEmail } from '../helpers/db'

const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
  id: 'inv-1',
  email: 'someone@example.test',
  applicationId: null,
  roleId: null,
  invitedBy: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  acceptedAt: null,
  acceptedByUserId: null,
  revokedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
})

describe('findPendingInvitation', () => {
  it('finds a global invitation from any application', async () => {
    const email = uniqueEmail('global-invite')
    const created = await createInvitation({ email })

    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toMatchObject({ id: created.id })
    await expect(findPendingInvitation(db(), email, SEED.cmsAppId)).resolves.toMatchObject({ id: created.id })
  })

  it('confines a scoped invitation to its own application', async () => {
    const email = uniqueEmail('scoped-invite')
    const created = await createInvitation({ email, applicationId: SEED.cmsAppId })

    await expect(findPendingInvitation(db(), email, SEED.cmsAppId)).resolves.toMatchObject({ id: created.id })
    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toBeNull()
  })

  it('ignores an accepted invitation', async () => {
    const email = uniqueEmail('accepted-invite')
    await createInvitation({ email, acceptedAt: new Date() })

    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toBeNull()
  })

  it('ignores a revoked invitation', async () => {
    const email = uniqueEmail('revoked-invite')
    await createInvitation({ email, revokedAt: new Date() })

    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toBeNull()
  })

  it('ignores an expired invitation, including one that expired a second ago', async () => {
    const email = uniqueEmail('expired-invite')
    await createInvitation({ email, expiresAt: new Date(Date.now() - 1000) })

    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toBeNull()
  })

  it('matches the address exactly, without normalizing it', async () => {
    const email = uniqueEmail('exact-invite')
    await createInvitation({ email })

    // Callers normalize before asking; the query itself does not, so an un-normalized address misses.
    await expect(findPendingInvitation(db(), email.toUpperCase(), SEED.webAppId)).resolves.toBeNull()
  })

  it('returns null for an address that was never invited', async () => {
    await expect(findPendingInvitation(db(), uniqueEmail('never'), SEED.webAppId)).resolves.toBeNull()
  })
})

describe('acceptInvitation', () => {
  it('records who accepted it and when', async () => {
    const email = uniqueEmail('accept')
    const created = await createInvitation({ email })
    const user = await createUser()

    await expect(acceptInvitation(db(), created.id, user.id)).resolves.toBe(true)

    const [row] = await db().select().from(invitations).where(eq(invitations.id, created.id))
    expect(row?.acceptedByUserId).toBe(user.id)
    expect(row?.acceptedAt).not.toBeNull()
  })

  it('reports false on a second acceptance instead of overwriting the first', async () => {
    const created = await createInvitation({ email: uniqueEmail('accept-twice') })
    const [first, second] = await Promise.all([createUser(), createUser()])

    await acceptInvitation(db(), created.id, first.id)
    await expect(acceptInvitation(db(), created.id, second.id)).resolves.toBe(false)

    const [row] = await db().select().from(invitations).where(eq(invitations.id, created.id))
    expect(row?.acceptedByUserId).toBe(first.id)
  })

  it('reports false for an invitation that does not exist', async () => {
    const user = await createUser()

    await expect(acceptInvitation(db(), crypto.randomUUID(), user.id)).resolves.toBe(false)
  })

  it('lets only one of two concurrent sign-ups consume it', async () => {
    const created = await createInvitation({ email: uniqueEmail('race') })
    const [first, second] = await Promise.all([createUser(), createUser()])

    const results = await Promise.all([
      acceptInvitation(db(), created.id, first.id),
      acceptInvitation(db(), created.id, second.id),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('toPublicInvitation', () => {
  it('derives pending for an untouched, unexpired invitation', () => {
    expect(toPublicInvitation(invitation()).status).toBe('pending')
  })

  it('derives accepted, expired and revoked in that order of precedence', () => {
    expect(toPublicInvitation(invitation({ acceptedAt: new Date() })).status).toBe('accepted')
    expect(toPublicInvitation(invitation({ expiresAt: new Date(Date.now() - 1) })).status).toBe('expired')
    expect(toPublicInvitation(invitation({ revokedAt: new Date() })).status).toBe('revoked')
    // Revocation wins over acceptance, and acceptance wins over expiry.
    expect(toPublicInvitation(invitation({ revokedAt: new Date(), acceptedAt: new Date() })).status).toBe('revoked')
    expect(
      toPublicInvitation(invitation({ acceptedAt: new Date(), expiresAt: new Date(Date.now() - 1) })).status,
    ).toBe('accepted')
  })

  it('renders the timestamps as ISO strings and keeps nulls null', () => {
    const published = toPublicInvitation(
      invitation({ expiresAt: new Date('2026-02-01T00:00:00.000Z'), acceptedAt: null, revokedAt: null }),
    )

    expect(published.expires_at).toBe('2026-02-01T00:00:00.000Z')
    expect(published.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(published.accepted_at).toBeNull()
    expect(published.revoked_at).toBeNull()
  })

  it('carries no token material, because an invitation is an allowlist entry rather than a secret', () => {
    expect(Object.keys(toPublicInvitation(invitation())).sort()).toEqual([
      'accepted_at',
      'accepted_by_user_id',
      'application_id',
      'created_at',
      'email',
      'expires_at',
      'id',
      'invited_by',
      'revoked_at',
      'role_id',
      'status',
    ])
  })
})
