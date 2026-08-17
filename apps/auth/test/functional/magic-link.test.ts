import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applications as applicationsTable,
  auditLogs,
  invitations as invitationsTable,
  magicLinkTokens,
} from '@/db/schema'
import { MAGIC_LINK_RATE_LIMIT, TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { consumeAuthorizationCode } from '@/services/tokens'
import { createApplication, createInvitation, createUser, db, SEED, uniqueEmail } from '../helpers/db'
import { captureEmails, magicLinkTokenFrom } from '../helpers/email'
import { RFC7636 } from '../helpers/pkce'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})

const request = (body: Record<string, unknown>) =>
  SELF.fetch('https://auth.internal/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.12', 'User-Agent': 'probe/6.0' },
    body: JSON.stringify({
      client_id: SEED.webAppId,
      redirect_uri: SEED.webRedirectUri,
      code_challenge: RFC7636.challenge,
      ...body,
    }),
  })

const callback = (token: string) =>
  SELF.fetch(`https://auth.internal/magic-link/callback?token=${encodeURIComponent(token)}`, { redirect: 'manual' })

/** Runs the whole flow for one address and hands back the link the user would click. */
const requestLinkFor = async (email: string, body: Record<string, unknown> = {}) => {
  const response = await request({ email, ...body })
  expect(response.status).toBe(202)
  return magicLinkTokenFrom(mailbox.last())
}

describe('POST /magic-link', () => {
  it('accepts the request, emails the link and records the pending token', async () => {
    const user = await createUser({ email: uniqueEmail('mlflow') })

    const response = await request({ email: user.email, state: 'st-9' })

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      code: 202,
      data: { message: 'If this address can sign in, a link is on its way.', expires_in: TTL.magicLink },
    })

    const token = magicLinkTokenFrom(mailbox.last())
    const [row] = await db().select().from(magicLinkTokens).where(eq(magicLinkTokens.tokenHash, await sha256(token)))
    expect(row).toMatchObject({
      email: user.email,
      applicationId: SEED.webAppId,
      redirectUri: SEED.webRedirectUri,
      state: 'st-9',
      requestIp: '203.0.113.12',
      userAgent: 'probe/6.0',
    })
  })

  it('answers the same 202 for an address that may not sign in, and sends nothing', async () => {
    const email = uniqueEmail('stranger')

    const response = await request({ email })

    expect(response.status).toBe(202)
    // Identical body to the success case: the endpoint must not be an account-enumeration oracle.
    await expect(response.json()).resolves.toMatchObject({ code: 202 })
    expect(mailbox.sent).toHaveLength(0)
    expect(await db().select().from(magicLinkTokens).where(eq(magicLinkTokens.email, email))).toHaveLength(0)
  })

  it('lets an invited address through', async () => {
    const email = uniqueEmail('invited')
    await createInvitation({ email })

    await request({ email })

    expect(mailbox.sent).toHaveLength(1)
  })

  it('records the outcome in the audit trail without putting it in the response', async () => {
    const invited = uniqueEmail('audited-yes')
    await createInvitation({ email: invited })
    await request({ email: invited })

    const stranger = uniqueEmail('audited-no')
    await request({ email: stranger })

    const rows = await db().select().from(auditLogs)
    const events = rows.map((row) => ({ event: row.event, metadata: JSON.parse(row.metadata ?? 'null') }))

    expect(events).toContainEqual({ event: 'magic_link.requested', metadata: { email: invited, sent: true } })
    expect(events).toContainEqual({ event: 'signup.rejected', metadata: { email: stranger, sent: false } })
  })

  it('stops emailing after the per-address limit and records why', async () => {
    const user = await createUser({ email: uniqueEmail('rate-limited') })

    for (let attempt = 0; attempt < MAGIC_LINK_RATE_LIMIT.max; attempt++) {
      expect((await request({ email: user.email })).status).toBe(202)
    }

    const limited = await request({ email: user.email })

    expect(limited.status).toBe(202)
    expect(mailbox.sent).toHaveLength(MAGIC_LINK_RATE_LIMIT.max)

    const rateLimited = (await db().select().from(auditLogs).where(eq(auditLogs.event, 'magic_link.rate_limited'))).map(
      (row) => JSON.parse(row.metadata ?? 'null'),
    )
    expect(rateLimited).toContainEqual({ email: user.email, sent: false })
  })

  it('rate-limits per address rather than across the whole endpoint', async () => {
    const [first, second] = await Promise.all([
      createUser({ email: uniqueEmail('limit-a') }),
      createUser({ email: uniqueEmail('limit-b') }),
    ])

    for (let attempt = 0; attempt < MAGIC_LINK_RATE_LIMIT.max; attempt++) {
      await request({ email: first.email })
    }
    mailbox.sent.length = 0

    await request({ email: second.email })

    expect(mailbox.sent).toHaveLength(1)
  })

  it('refuses an unknown client with the { code, error } shape', async () => {
    const response = await request({ email: uniqueEmail('bad-client'), client_id: 'ghost' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ code: 400, error: 'Unknown or inactive client_id' })
  })

  it('refuses a redirect URI the client has not registered', async () => {
    const response = await request({ email: uniqueEmail('bad-redirect'), redirect_uri: 'https://evil.test/callback' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 400,
      error: 'redirect_uri is not registered for this client',
    })
  })

  it('refuses a code_challenge that is not a base64url SHA-256 digest', async () => {
    const response = await request({ email: uniqueEmail('bad-pkce'), code_challenge: 'too-short' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'code_challenge must be a base64url-encoded SHA-256 digest',
    })
  })

  it('refuses code_challenge_method plain at the schema, before any work happens', async () => {
    const response = await request({ email: uniqueEmail('plain'), code_challenge_method: 'plain' })

    expect(response.status).toBe(400)
    expect(mailbox.sent).toHaveLength(0)
  })

  it('refuses an unsupported scope', async () => {
    const response = await request({ email: uniqueEmail('bad-scope'), scope: 'openid drive.readonly' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_scope',
      error_description: 'Unsupported scope: drive.readonly',
    })
  })

  it('refuses a malformed email address and a relative redirect URI', async () => {
    expect((await request({ email: 'not-an-address' })).status).toBe(400)
    expect((await request({ email: uniqueEmail('rel'), redirect_uri: '/callback' })).status).toBe(400)
    expect(mailbox.sent).toHaveLength(0)
  })

  it('never caches the acknowledgement', async () => {
    const user = await createUser({ email: uniqueEmail('nocache') })

    expect((await request({ email: user.email })).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('GET /magic-link/callback', () => {
  it('redirects back to the client with a code and the state from the stored request', async () => {
    const user = await createUser({ email: uniqueEmail('cb-happy') })
    const token = await requestLinkFor(user.email, { state: 'st-cb' })

    const response = await callback(token)

    expect(response.status).toBe(302)
    // The Location header carries a single-use code, so no shared cache may keep this response.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const target = new URL(response.headers.get('Location') as string)
    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('state')).toBe('st-cb')

    const code = target.searchParams.get('code') as string
    await expect(consumeAuthorizationCode(db(), code)).resolves.toMatchObject({
      userId: user.id,
      applicationId: SEED.webAppId,
      provider: 'magic_link',
      redirectUri: SEED.webRedirectUri,
      codeChallenge: RFC7636.challenge,
    })
  })

  it('takes the redirect target from the stored request, not from the link that was clicked', async () => {
    const user = await createUser({ email: uniqueEmail('cb-fixed') })
    const token = await requestLinkFor(user.email, { redirect_uri: SEED.webLocalRedirectUri })

    const response = await SELF.fetch(
      `https://auth.internal/magic-link/callback?token=${encodeURIComponent(token)}&redirect_uri=https%3A%2F%2Fevil.test`,
      { redirect: 'manual' },
    )

    expect(new URL(response.headers.get('Location') as string).origin).toBe('http://localhost:5173')
  })

  it('records magic_link.consumed', async () => {
    const user = await createUser({ email: uniqueEmail('cb-audit') })
    const token = await requestLinkFor(user.email)

    await callback(token)

    const consumed = await db().select().from(auditLogs).where(eq(auditLogs.event, 'magic_link.consumed'))
    expect(consumed.map((row) => JSON.parse(row.metadata ?? 'null'))).toContainEqual({ email: user.email })
  })

  it('works exactly once', async () => {
    const user = await createUser({ email: uniqueEmail('cb-once') })
    const token = await requestLinkFor(user.email)

    expect((await callback(token)).status).toBe(302)

    const replay = await callback(token)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toEqual({
      error: 'invalid_grant',
      error_description: 'This sign-in link has already been used',
    })
  })

  it('refuses a token that was never issued', async () => {
    const response = await callback('invented-token')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'This sign-in link is not valid' })
  })

  it('refuses an expired link', async () => {
    const user = await createUser({ email: uniqueEmail('cb-expired') })
    const token = await requestLinkFor(user.email)
    await db()
      .update(magicLinkTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(magicLinkTokens.tokenHash, await sha256(token)))

    const response = await callback(token)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'This sign-in link has expired' })
  })

  it('requires the token query parameter', async () => {
    expect((await SELF.fetch('https://auth.internal/magic-link/callback')).status).toBe(400)
    expect((await SELF.fetch('https://auth.internal/magic-link/callback?token=')).status).toBe(400)
  })

  it('hands a late authorization failure back to the client as an error redirect', async () => {
    // The address is invited when the link is issued and struck off before it is clicked, which is
    // the only way `completeAuthentication` can fail once the redirect URI is already trusted.
    const email = uniqueEmail('cb-revoked')
    const invitation = await createInvitation({ email })
    const token = await requestLinkFor(email, { state: 'st-err' })
    await db().update(invitationsTable).set({ revokedAt: new Date() }).where(eq(invitationsTable.id, invitation.id))

    const response = await callback(token)

    expect(response.status).toBe(302)
    const target = new URL(response.headers.get('Location') as string)
    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('error')).toBe('access_denied')
    expect(target.searchParams.get('error_description')).toBe('This email address has not been invited')
    expect(target.searchParams.get('state')).toBe('st-err')

    const rejected = await db().select().from(auditLogs).where(eq(auditLogs.event, 'magic_link.rejected'))
    expect(rejected.map((row) => JSON.parse(row.metadata ?? 'null'))).toContainEqual({
      email,
      reason: 'access_denied',
    })
  })

  it('refuses to complete when the client application has been deactivated meanwhile', async () => {
    const application = await createApplication({ redirectUris: ['https://temp.test/cb'] })
    const user = await createUser({ email: uniqueEmail('cb-dead-app') })
    const token = await requestLinkFor(user.email, {
      client_id: application.id,
      redirect_uri: 'https://temp.test/cb',
    })
    await db().update(applicationsTable).set({ isActive: false }).where(eq(applicationsTable.id, application.id))

    const response = await callback(token)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 400,
      error: 'The application this link was issued for is no longer available',
    })
  })
})

/**
 * The invitation `scripts/bootstrap-admin.mjs` writes is the only way the first `admin` ever comes
 * to exist, so it is driven end to end through the Worker rather than only against the service that
 * implements it.
 */
describe('bootstrap admin invitation through the whole flow', () => {
  const exchange = (code: string) =>
    SELF.fetch('https://auth.internal/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: SEED.webAppId,
        code,
        redirect_uri: SEED.webRedirectUri,
        code_verifier: RFC7636.verifier,
      }).toString(),
    })

  it('signs the invited address up and lands it holding the admin role', async () => {
    const email = uniqueEmail('bootstrap-e2e')
    // Exactly what the script inserts: a global, pending invitation carrying the admin role.
    await createInvitation({ email, roleId: SEED.adminRoleId })

    const token = await requestLinkFor(email)
    const redirect = await callback(token)
    expect(redirect.status).toBe(302)

    const code = new URL(redirect.headers.get('Location') as string).searchParams.get('code') as string
    const exchanged = await exchange(code)
    expect(exchanged.status).toBe(200)
    const accessToken = (await exchanged.json<{ access_token: string }>()).access_token

    const me = await SELF.fetch('https://auth.internal/me', { headers: { Authorization: `Bearer ${accessToken}` } })
    const body = await me.json<{ data: { user: { email: string }; roles: string[]; permissions: string[] } }>()

    expect(me.status).toBe(200)
    expect(body.data.user.email).toBe(email)
    // The global default role plus the admin role the invitation grants.
    expect(body.data.roles).toEqual(['admin', 'user'])
    expect(body.data.permissions).toContain('users:write')
  })
})
