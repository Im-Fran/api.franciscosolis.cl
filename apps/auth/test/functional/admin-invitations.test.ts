import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { auditLogs, invitations } from '@/db/schema'
import { TTL } from '@/lib/config'
import { findPendingInvitation } from '@/services/invitations'
import { createApplication, createInvitation, createRole, createUser, db, SEED, signIn, uniqueEmail } from '../helpers/db'
import { captureEmails, linkFrom } from '../helpers/email'
import { RFC7636 } from '../helpers/pkce'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal/admin${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

const callerWith = async (granted: string[], user?: Awaited<ReturnType<typeof createUser>>) => {
  const role = await createRole({ slug: `caller-${crypto.randomUUID().slice(0, 8)}`, permissions: granted })
  return signIn({ roleIds: [role.id], user })
}

describe('GET /admin/invitations', () => {
  it('lists invitations with their derived status', async () => {
    const { token } = await callerWith(['invitations:read'])
    const pending = await createInvitation({ email: uniqueEmail('list-pending') })
    const expired = await createInvitation({ email: uniqueEmail('list-expired'), expiresAt: new Date(Date.now() - 1000) })
    const revoked = await createInvitation({ email: uniqueEmail('list-revoked'), revokedAt: new Date() })
    const accepted = await createInvitation({ email: uniqueEmail('list-accepted'), acceptedAt: new Date() })

    const body = await (await call('/invitations', token)).json<{ data: { id: string; status: string }[] }>()
    const statusOf = (id: string) => body.data.find((row) => row.id === id)?.status

    expect(statusOf(pending.id)).toBe('pending')
    expect(statusOf(expired.id)).toBe('expired')
    expect(statusOf(revoked.id)).toBe('revoked')
    expect(statusOf(accepted.id)).toBe('accepted')
  })

  it('refuses a caller without invitations:read', async () => {
    const { token } = await callerWith(['users:read'])

    const response = await call('/invitations', token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: invitations:read' })
  })
})

describe('POST /admin/invitations', () => {
  it('creates a global invitation that actually lets the address sign in', async () => {
    const caller = await callerWith(['invitations:write'])
    const email = uniqueEmail('invite-works')

    const response = await call('/invitations', caller.token, {
      method: 'POST',
      body: JSON.stringify({ email: ` ${email.toUpperCase()} `, send_email: false }),
    })

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({
      code: 201,
      data: { email, application_id: null, status: 'pending', invited_by: caller.user.id, emailed: false },
    })

    // The invitation is what makes an unknown address usable at all.
    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.not.toBeNull()
  })

  it('defaults the expiry to the configured invitation TTL', async () => {
    const { token } = await callerWith(['invitations:write'])

    const body = await (
      await call('/invitations', token, {
        method: 'POST',
        body: JSON.stringify({ email: uniqueEmail('invite-ttl'), send_email: false }),
      })
    ).json<{ data: { expires_at: string } }>()

    const seconds = (new Date(body.data.expires_at).getTime() - Date.now()) / 1000
    expect(seconds).toBeGreaterThan(TTL.invitation - 60)
    expect(seconds).toBeLessThanOrEqual(TTL.invitation)
  })

  it('honours an explicit expires_in_days and rejects one outside the bounds', async () => {
    const { token } = await callerWith(['invitations:write'])
    const create = (body: Record<string, unknown>) =>
      call('/invitations', token, { method: 'POST', body: JSON.stringify({ send_email: false, ...body }) })

    const response = await create({ email: uniqueEmail('invite-1day'), expires_in_days: 1 })
    const body = await response.json<{ data: { expires_at: string } }>()
    expect((new Date(body.data.expires_at).getTime() - Date.now()) / 86_400_000).toBeLessThanOrEqual(1)

    expect((await create({ email: uniqueEmail('invite-0'), expires_in_days: 0 })).status).toBe(400)
    expect((await create({ email: uniqueEmail('invite-91'), expires_in_days: 91 })).status).toBe(400)
  })

  it('scopes an invitation to one application when asked', async () => {
    const { token } = await callerWith(['invitations:write'])
    const email = uniqueEmail('invite-scoped')

    await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email, application_id: SEED.cmsAppId, send_email: false }),
    })

    await expect(findPendingInvitation(db(), email, SEED.cmsAppId)).resolves.not.toBeNull()
    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toBeNull()
  })

  it('attaches a role that is granted when the invitation is accepted', async () => {
    const { token } = await callerWith(['invitations:write'])
    const role = await createRole({ slug: 'invited-editor' })
    const email = uniqueEmail('invite-role')

    await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email, role_id: role.id, send_email: false }),
    })

    const [row] = await db().select().from(invitations).where(eq(invitations.email, email))
    expect(row?.roleId).toBe(role.id)
  })

  it('emails the invitation to the login URL it was given', async () => {
    const caller = await callerWith(['invitations:write'], await createUser({ name: 'Ada' }))
    const email = uniqueEmail('invite-email')

    const response = await call('/invitations', caller.token, {
      method: 'POST',
      body: JSON.stringify({ email, login_url: 'https://client.test/sign-in' }),
    })

    await expect(response.json()).resolves.toMatchObject({ data: { emailed: true } })
    expect(mailbox.last().to).toEqual([email])
    expect(linkFrom(mailbox.last()).toString()).toBe('https://client.test/sign-in')
    expect(mailbox.last().text).toContain('Ada invited you.')
  })

  it('falls back to the origin of the application\'s first redirect URI', async () => {
    const { token } = await callerWith(['invitations:write'])

    await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('invite-fallback'), application_id: SEED.webAppId }),
    })

    expect(linkFrom(mailbox.last()).origin).toBe('https://franciscosolis.cl')
    expect(mailbox.last().subject).toBe('You have been invited to franciscosolis.cl')
  })

  it('sends nothing when there is no login URL to point at', async () => {
    const { token } = await callerWith(['invitations:write'])

    const response = await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('invite-nourl') }),
    })

    await expect(response.json()).resolves.toMatchObject({ data: { emailed: false } })
    expect(mailbox.sent).toHaveLength(0)
  })

  it('refuses a second pending invitation for the same address', async () => {
    const { token } = await callerWith(['invitations:write'])
    const email = uniqueEmail('invite-dupe')
    await createInvitation({ email })

    const response = await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email, send_email: false }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      code: 409,
      error: 'A pending invitation already exists for this address',
    })
  })

  it('allows a fresh invitation once the previous one was revoked or accepted', async () => {
    const { token } = await callerWith(['invitations:write'])
    const revokedEmail = uniqueEmail('invite-after-revoke')
    const acceptedEmail = uniqueEmail('invite-after-accept')
    await createInvitation({ email: revokedEmail, revokedAt: new Date() })
    await createInvitation({ email: acceptedEmail, acceptedAt: new Date() })

    for (const email of [revokedEmail, acceptedEmail]) {
      const response = await call('/invitations', token, {
        method: 'POST',
        body: JSON.stringify({ email, send_email: false }),
      })
      expect(response.status).toBe(201)
    }
  })

  it('answers 404 for an unknown application or role', async () => {
    const { token } = await callerWith(['invitations:write'])

    const unknownApplication = await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('invite-badapp'), application_id: 'ghost', send_email: false }),
    })
    expect(unknownApplication.status).toBe(404)
    await expect(unknownApplication.json()).resolves.toMatchObject({ error: 'Application not found' })

    const unknownRole = await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('invite-badrole'), role_id: crypto.randomUUID(), send_email: false }),
    })
    expect(unknownRole.status).toBe(404)
    await expect(unknownRole.json()).resolves.toMatchObject({ error: 'Role not found' })
  })

  it('rejects a malformed address', async () => {
    const { token } = await callerWith(['invitations:write'])

    expect(
      (await call('/invitations', token, { method: 'POST', body: JSON.stringify({ email: 'not-an-address' }) })).status,
    ).toBe(400)
  })

  it('records invitation.created with the address and whether it was emailed', async () => {
    const caller = await callerWith(['invitations:write'])
    const email = uniqueEmail('invite-audit')

    await call('/invitations', caller.token, {
      method: 'POST',
      body: JSON.stringify({ email, application_id: SEED.cmsAppId, send_email: false }),
    })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, caller.user.id))
    const created = rows.filter((row) => row.event === 'invitation.created')
    expect(created.map((row) => JSON.parse(row.metadata ?? 'null'))).toContainEqual({ email, emailed: false })
    expect(created.every((row) => row.applicationId === SEED.cmsAppId)).toBe(true)
  })

  it('refuses a caller with only invitations:read', async () => {
    const { token } = await callerWith(['invitations:read'])

    const response = await call('/invitations', token, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('invite-denied') }),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: invitations:write' })
  })
})

describe('DELETE /admin/invitations/:id', () => {
  it('revokes a pending invitation, closing the door the address came through', async () => {
    const caller = await callerWith(['invitations:write'])
    const email = uniqueEmail('invite-revoke')
    const invitation = await createInvitation({ email })

    const response = await call(`/invitations/${invitation.id}`, caller.token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    await expect(findPendingInvitation(db(), email, SEED.webAppId)).resolves.toBeNull()

    // And the address can no longer complete a sign-in through the magic link provider.
    const magicLink = await SELF.fetch('https://auth.internal/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        client_id: SEED.webAppId,
        redirect_uri: SEED.webRedirectUri,
        code_challenge: RFC7636.challenge,
      }),
    })
    expect(magicLink.status).toBe(202)
    expect(mailbox.sent).toHaveLength(0)
  })

  it('answers 404 for an invitation that is already revoked or accepted', async () => {
    const { token } = await callerWith(['invitations:write'])
    const revoked = await createInvitation({ email: uniqueEmail('revoke-twice'), revokedAt: new Date() })
    const accepted = await createInvitation({ email: uniqueEmail('revoke-accepted'), acceptedAt: new Date() })

    for (const invitation of [revoked, accepted]) {
      const response = await call(`/invitations/${invitation.id}`, token, { method: 'DELETE' })
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toEqual({ code: 404, error: 'No pending invitation with that id' })
    }
  })

  it('answers 404 for an id that does not exist', async () => {
    const { token } = await callerWith(['invitations:write'])

    expect((await call(`/invitations/${crypto.randomUUID()}`, token, { method: 'DELETE' })).status).toBe(404)
  })

  it('records invitation.revoked with the address', async () => {
    const caller = await callerWith(['invitations:write'])
    const email = uniqueEmail('revoke-audit')
    const invitation = await createInvitation({ email })

    await call(`/invitations/${invitation.id}`, caller.token, { method: 'DELETE' })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, caller.user.id))
    const revoked = rows.find((row) => row.event === 'invitation.revoked')
    expect(JSON.parse(revoked?.metadata ?? 'null')).toEqual({ email })
  })

  it('refuses a caller with only invitations:read', async () => {
    const { token } = await callerWith(['invitations:read'])
    const invitation = await createInvitation({ email: uniqueEmail('revoke-denied') })

    expect((await call(`/invitations/${invitation.id}`, token, { method: 'DELETE' })).status).toBe(403)
  })
})

describe('an invitation end to end', () => {
  it('turns an unknown address into an account with the invited role', async () => {
    const caller = await callerWith(['invitations:write'])
    const application = await createApplication({ redirectUris: ['https://invited.test/cb'] })
    const role = await createRole({ slug: 'invited-role-e2e' })
    const email = uniqueEmail('e2e-invite')

    await call('/invitations', caller.token, {
      method: 'POST',
      body: JSON.stringify({ email, application_id: application.id, role_id: role.id, send_email: false }),
    })

    const magicLink = await SELF.fetch('https://auth.internal/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        client_id: application.id,
        redirect_uri: 'https://invited.test/cb',
        code_challenge: RFC7636.challenge,
      }),
    })
    expect(magicLink.status).toBe(202)

    const token = linkFrom(mailbox.last()).searchParams.get('token') as string
    const callback = await SELF.fetch(`https://auth.internal/magic-link/callback?token=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    })

    expect(callback.status).toBe(302)
    expect(new URL(callback.headers.get('Location') as string).searchParams.get('code')).toBeTruthy()

    const [invitation] = await db().select().from(invitations).where(eq(invitations.email, email))
    expect(invitation?.acceptedAt).not.toBeNull()
    expect(invitation?.acceptedByUserId).toBeTruthy()
  })
})
