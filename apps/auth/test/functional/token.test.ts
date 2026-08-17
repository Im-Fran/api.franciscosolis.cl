import { SELF, env } from 'cloudflare:test'
import { desc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, authorizationCodes, refreshTokens, sessions, users } from '@/db/schema'
import { TTL } from '@/lib/config'
import type { ProviderName } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { verifyAccessToken } from '@/lib/jwt'
import { issueAuthorizationCode, issueRefreshToken } from '@/services/tokens'
import { createApplication, createRole, createSessionRow, createUser, db, grant, SEED } from '../helpers/db'
import { OTHER_PKCE, RFC7636 } from '../helpers/pkce'

type TokenBody = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string | null
  session_id: string
}

const form = (fields: Record<string, string>) =>
  SELF.fetch('https://auth.internal/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.11' },
    body: new URLSearchParams(fields).toString(),
  })

const revoke = (fields: Record<string, string>) =>
  SELF.fetch('https://auth.internal/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

const grantCode = async (
  overrides: {
    userId?: string
    applicationId?: string
    redirectUri?: string
    nonce?: string | null
    codeChallenge?: string | null
    scope?: string | null
    provider?: ProviderName
  } = {},
) => {
  const userId = overrides.userId ?? (await createUser()).id
  const code = await issueAuthorizationCode(db(), {
    userId,
    applicationId: overrides.applicationId ?? SEED.webAppId,
    provider: overrides.provider ?? 'magic_link',
    redirectUri: overrides.redirectUri ?? SEED.webRedirectUri,
    nonce: overrides.nonce ?? null,
    codeChallenge: overrides.codeChallenge === undefined ? RFC7636.challenge : overrides.codeChallenge,
    codeChallengeMethod: overrides.codeChallenge === null ? null : 'S256',
    scope: overrides.scope === undefined ? 'openid profile email' : overrides.scope,
  })
  return { code, userId }
}

const exchange = (code: string, overrides: Record<string, string> = {}) =>
  form({
    grant_type: 'authorization_code',
    client_id: SEED.webAppId,
    code,
    redirect_uri: SEED.webRedirectUri,
    code_verifier: RFC7636.verifier,
    ...overrides,
  })

describe('POST /oauth/token — authorization_code', () => {
  it('exchanges a code for a signed access token and a refresh token', async () => {
    const user = await createUser({ name: 'Ada' })
    const role = await createRole({ slug: 'token-reader', permissions: ['users:read'] })
    await grant(user.id, role.id)
    const { code } = await grantCode({ userId: user.id })

    const response = await exchange(code)
    const body = await response.json<TokenBody>()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      token_type: 'Bearer',
      expires_in: TTL.accessToken,
      scope: 'openid profile email',
    })
    expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/)

    const claims = await verifyAccessToken(env, body.access_token)
    expect(claims).toMatchObject({
      sub: user.id,
      aud: SEED.webAppId,
      sid: body.session_id,
      provider: 'magic_link',
      email: user.email,
      name: 'Ada',
      roles: ['token-reader'],
      permissions: ['users:read'],
    })
  })

  it('answers the flat OAuth shape, not this API\'s { code, data } envelope', async () => {
    const { code } = await grantCode()
    const body = await (await exchange(code)).json<Record<string, unknown>>()

    expect(body).not.toHaveProperty('data')
    expect(Object.keys(body).sort()).toEqual([
      'access_token',
      'expires_in',
      // Present because the granted scope contains `openid`, which makes this an OIDC exchange.
      'id_token',
      'refresh_token',
      'scope',
      'session_id',
      'token_type',
    ])
  })

  it('creates the session with the client fingerprint and records token.issued', async () => {
    const { code, userId } = await grantCode()
    const body = await (await exchange(code)).json<TokenBody>()

    const [session] = await db().select().from(sessions).where(eq(sessions.id, body.session_id))
    expect(session).toMatchObject({
      userId,
      applicationId: SEED.webAppId,
      provider: 'magic_link',
      scope: 'openid profile email',
      ip: '203.0.113.11',
      revokedAt: null,
    })

    const [audit] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, userId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)
    expect(audit?.event).toBe('token.issued')
  })

  it('marks the code spent, so a replay fails', async () => {
    const { code } = await grantCode()
    await exchange(code)

    const replay = await exchange(code)

    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toEqual({
      error: 'invalid_grant',
      error_description: 'The authorization code has already been used',
    })
  })

  it('refuses a code that was never issued', async () => {
    const response = await exchange('made-up')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant', error_description: 'Unknown authorization code' })
  })

  it('refuses an expired code', async () => {
    const { code } = await grantCode()
    await db()
      .update(authorizationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authorizationCodes.codeHash, await sha256(code)))

    const response = await exchange(code)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'The authorization code has expired' })
  })

  it('refuses a redirect_uri that differs from the authorization request, and burns the code', async () => {
    const { code } = await grantCode()

    const response = await exchange(code, { redirect_uri: SEED.webLocalRedirectUri })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_grant',
      error_description: 'redirect_uri does not match the authorization request',
    })
    // The code is spent before the check, so the client has to start over; that is deliberate.
    await expect((await exchange(code)).json()).resolves.toMatchObject({
      error_description: 'The authorization code has already been used',
    })
  })

  it('refuses a verifier that does not derive the recorded challenge', async () => {
    const { code } = await grantCode()

    const response = await exchange(code, { code_verifier: OTHER_PKCE.verifier })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_grant',
      error_description: 'code_verifier does not match the code_challenge',
    })
  })

  it('refuses a code issued to a different client', async () => {
    const other = await createApplication({ redirectUris: [SEED.webRedirectUri] })
    const { code } = await grantCode({ applicationId: other.id })

    const response = await exchange(code)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'This authorization code was issued to another client',
    })
  })

  it('requires code and redirect_uri together', async () => {
    const { code } = await grantCode()

    for (const missing of ['code', 'redirect_uri'] as const) {
      const fields: Record<string, string> = {
        grant_type: 'authorization_code',
        client_id: SEED.webAppId,
        code,
        redirect_uri: SEED.webRedirectUri,
        code_verifier: RFC7636.verifier,
      }
      delete fields[missing]

      const response = await form(fields)
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_request',
        error_description: 'code and redirect_uri are required for the authorization_code grant',
      })
    }
  })

  it('requires the verifier when the code was minted with a challenge', async () => {
    const { code } = await grantCode()

    const response = await form({
      grant_type: 'authorization_code',
      client_id: SEED.webAppId,
      code,
      redirect_uri: SEED.webRedirectUri,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'code_verifier is required for this authorization code',
    })
  })

  it('refuses a malformed verifier before spending the code', async () => {
    const { code } = await grantCode()

    const response = await exchange(code, { code_verifier: 'a'.repeat(42) })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'code_verifier must be 43-128 unreserved characters',
    })
    // Rejecting a malformed request must not cost the user their code.
    expect((await exchange(code)).status).toBe(200)
  })

  it('refuses a verifier containing characters outside the unreserved set', async () => {
    const { code } = await grantCode()

    const response = await exchange(code, { code_verifier: `${'a'.repeat(42)}+` })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' })
  })

  it('refuses an unknown or deactivated client with invalid_client', async () => {
    const { code } = await grantCode()
    const inactive = await createApplication({ isActive: false })

    for (const clientId of ['ghost-client', inactive.id]) {
      const response = await exchange(code, { client_id: clientId })
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        error: 'invalid_client',
        error_description: 'Unknown or inactive client_id',
      })
    }
  })

  it('refuses a client_secret from a public client', async () => {
    const { code } = await grantCode()

    const response = await exchange(code, { client_secret: 'not-mine' })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'This client is public and must not send a client_secret',
    })
  })

  it('accepts a confidential client that presents the right secret and rejects a wrong one', async () => {
    const confidential = await createApplication({
      redirectUris: ['https://confidential.test/cb'],
      clientSecret: 'the-secret',
    })
    const first = await grantCode({ applicationId: confidential.id, redirectUri: 'https://confidential.test/cb' })
    const second = await grantCode({ applicationId: confidential.id, redirectUri: 'https://confidential.test/cb' })

    const accepted = await exchange(first.code, {
      client_id: confidential.id,
      client_secret: 'the-secret',
      redirect_uri: 'https://confidential.test/cb',
    })
    expect(accepted.status).toBe(200)

    const rejected = await exchange(second.code, {
      client_id: confidential.id,
      client_secret: 'wrong',
      redirect_uri: 'https://confidential.test/cb',
    })
    expect(rejected.status).toBe(401)
    await expect(rejected.json()).resolves.toMatchObject({ error_description: 'Invalid client credentials' })
  })

  it('refuses a disabled account with access_denied', async () => {
    const user = await createUser({ status: 'disabled' })
    const { code } = await grantCode({ userId: user.id })

    const response = await exchange(code)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'access_denied', error_description: 'This account is disabled' })
  })

  it('refuses a code whose account has been deleted', async () => {
    const user = await createUser()
    const { code } = await grantCode({ userId: user.id })
    await db().delete(users).where(eq(users.id, user.id))

    const response = await exchange(code)

    // Deleting the account cascades the code away, so the exchange never reaches the user lookup.
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_grant',
      error_description: 'Unknown authorization code',
    })
  })

  it('carries a narrowed scope onto the session rather than widening it back', async () => {
    const { code } = await grantCode({ scope: 'openid' })

    const body = await (await exchange(code)).json<TokenBody>()

    expect(body.scope).toBe('openid')
    const [session] = await db().select().from(sessions).where(eq(sessions.id, body.session_id))
    expect(session?.scope).toBe('openid')
  })

  it('never caches a token response', async () => {
    const { code } = await grantCode()

    expect((await exchange(code)).headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('POST /oauth/token — refresh_token', () => {
  const signedIn = async (applicationId = SEED.webAppId) => {
    const { code, userId } = await grantCode({ applicationId, redirectUri: SEED.webRedirectUri })
    const body = await (
      await form({
        grant_type: 'authorization_code',
        client_id: applicationId,
        code,
        redirect_uri: SEED.webRedirectUri,
        code_verifier: RFC7636.verifier,
      })
    ).json<TokenBody>()
    return { ...body, userId }
  }

  it('rotates the refresh token and keeps the session', async () => {
    const first = await signedIn()

    const response = await form({
      grant_type: 'refresh_token',
      client_id: SEED.webAppId,
      refresh_token: first.refresh_token,
    })
    const second = await response.json<TokenBody>()

    expect(response.status).toBe(200)
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(second.session_id).toBe(first.session_id)
    await expect(verifyAccessToken(env, second.access_token)).resolves.toMatchObject({ sid: first.session_id })

    const [old] = await db()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await sha256(first.refresh_token)))
    expect(old?.usedAt).not.toBeNull()
  })

  it('re-issues the scope granted at sign-in, not a wider one', async () => {
    const { code } = await grantCode({ scope: 'openid' })
    const first = await (await exchange(code)).json<TokenBody>()

    const second = await (
      await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: first.refresh_token })
    ).json<TokenBody>()

    expect(second.scope).toBe('openid')
  })

  it('reflects a role granted between two refreshes', async () => {
    const first = await signedIn()
    await grant(first.userId, SEED.adminRoleId)

    const second = await (
      await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: first.refresh_token })
    ).json<TokenBody>()

    await expect(verifyAccessToken(env, second.access_token)).resolves.toMatchObject({ roles: ['admin'] })
  })

  it('records token.refreshed alongside the original token.issued', async () => {
    const first = await signedIn()
    await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: first.refresh_token })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, first.userId))

    expect(rows.map((row) => row.event).sort()).toEqual(['token.issued', 'token.refreshed'])
    const refreshed = rows.find((row) => row.event === 'token.refreshed')
    expect(JSON.parse(refreshed?.metadata ?? 'null')).toEqual({ session_id: first.session_id })
  })

  it('requires the refresh_token field', async () => {
    const response = await form({ grant_type: 'refresh_token', client_id: SEED.webAppId })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'refresh_token is required for the refresh_token grant',
    })
  })

  it('refuses a refresh token that was never issued', async () => {
    const response = await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: 'invented' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'Unknown refresh token' })
  })

  it('treats a replayed refresh token as a leak and kills the whole session', async () => {
    const first = await signedIn()
    const second = await (
      await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: first.refresh_token })
    ).json<TokenBody>()

    const replay = await form({
      grant_type: 'refresh_token',
      client_id: SEED.webAppId,
      refresh_token: first.refresh_token,
    })

    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({
      error_description: 'Refresh token reuse detected; the session has been revoked',
    })

    // The honest client's newest token dies too, which is the point.
    const afterwards = await form({
      grant_type: 'refresh_token',
      client_id: SEED.webAppId,
      refresh_token: second.refresh_token,
    })
    expect(afterwards.status).toBe(400)

    const [session] = await db().select().from(sessions).where(eq(sessions.id, first.session_id))
    expect(session?.revokedReason).toBe('refresh_token_reuse')
  })

  it('refuses a refresh token presented by another client', async () => {
    const first = await signedIn()
    const other = await createApplication()

    const response = await form({
      grant_type: 'refresh_token',
      client_id: other.id,
      refresh_token: first.refresh_token,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'This refresh token was issued to another client',
    })
  })

  it('has already spent the token by the time the wrong client is rejected, so the session dies', async () => {
    const first = await signedIn()
    const other = await createApplication()

    await form({ grant_type: 'refresh_token', client_id: other.id, refresh_token: first.refresh_token })

    // The rejected attempt stamped `used_at`, so the rightful client's next legitimate refresh now
    // looks like a replay. Pinned as the behaviour it is: the cross-client refusal is not free.
    const retry = await form({
      grant_type: 'refresh_token',
      client_id: SEED.webAppId,
      refresh_token: first.refresh_token,
    })

    expect(retry.status).toBe(400)
    await expect(retry.json()).resolves.toMatchObject({
      error_description: 'Refresh token reuse detected; the session has been revoked',
    })

    const [session] = await db().select().from(sessions).where(eq(sessions.id, first.session_id))
    expect(session?.revokedReason).toBe('refresh_token_reuse')
  })

  it('re-issues the provider the session was created with, not a hardcoded one', async () => {
    const { code } = await grantCode({ provider: 'google' })
    const first = await (await exchange(code)).json<TokenBody>()
    await expect(verifyAccessToken(env, first.access_token)).resolves.toMatchObject({ provider: 'google' })

    const second = await (
      await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: first.refresh_token })
    ).json<TokenBody>()

    await expect(verifyAccessToken(env, second.access_token)).resolves.toMatchObject({ provider: 'google' })
  })

  it('refuses to refresh once the account is disabled', async () => {
    const first = await signedIn()
    await db().update(users).set({ status: 'disabled' }).where(eq(users.id, first.userId))

    const response = await form({
      grant_type: 'refresh_token',
      client_id: SEED.webAppId,
      refresh_token: first.refresh_token,
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' })
  })

  it('refuses an expired refresh token', async () => {
    const first = await signedIn()
    await db()
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.tokenHash, await sha256(first.refresh_token)))

    const response = await form({
      grant_type: 'refresh_token',
      client_id: SEED.webAppId,
      refresh_token: first.refresh_token,
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'The refresh token has expired' })
  })
})

describe('POST /oauth/token — request validation', () => {
  it('rejects a grant type the endpoint does not implement', async () => {
    const response = await form({ grant_type: 'password', client_id: SEED.webAppId })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'unsupported_grant_type',
      error_description: 'Unsupported grant_type: password',
    })
  })

  it('rejects a body with no grant_type or no client_id', async () => {
    expect((await form({ client_id: SEED.webAppId })).status).toBe(400)
    expect((await form({ grant_type: 'refresh_token' })).status).toBe(400)
    expect((await form({ grant_type: 'refresh_token', client_id: '' })).status).toBe(400)
  })

  it('rejects a JSON body, since RFC 6749 specifies a form-encoded one', async () => {
    const response = await SELF.fetch('https://auth.internal/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: 'x' }),
    })

    expect(response.status).toBe(400)
  })

  it('is not reachable with GET', async () => {
    expect((await SELF.fetch('https://auth.internal/oauth/token')).status).toBe(404)
  })
})

describe('POST /oauth/revoke', () => {
  it('revokes the session behind a refresh token and answers an empty 200', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const token = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: user.id,
      applicationId: SEED.webAppId,
    })

    const response = await revoke({ token, client_id: SEED.webAppId })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('')

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row?.revokedReason).toBe('client_revocation')
  })

  it('answers 200 for a token that does not exist, so it cannot be used to probe', async () => {
    const response = await revoke({ token: 'never-issued', client_id: SEED.webAppId })

    expect(response.status).toBe(200)
  })

  it('ignores a token that belongs to another client', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const token = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: user.id,
      applicationId: SEED.webAppId,
    })
    const other = await createApplication()

    const response = await revoke({ token, client_id: other.id })

    expect(response.status).toBe(200)
    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('still refuses an unknown client', async () => {
    const response = await revoke({ token: 'x', client_id: 'ghost' })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client' })
  })

  it('records token.revoked against the user who owned the session', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const token = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: user.id,
      applicationId: SEED.webAppId,
    })

    await revoke({ token, client_id: SEED.webAppId })

    const [audit] = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.userId, user.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)
    expect(audit?.event).toBe('token.revoked')
  })

  it('requires a token and a client_id', async () => {
    expect((await revoke({ client_id: SEED.webAppId })).status).toBe(400)
    expect((await revoke({ token: 'x' })).status).toBe(400)
  })
})
