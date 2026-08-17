import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { authorizationCodes, refreshTokens, sessions } from '@/db/schema'
import { TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { verifyAccessToken } from '@/lib/jwt'
import {
  buildTokenResponse,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createSession,
  issueAuthorizationCode,
  issueRefreshToken,
  revokeSession,
  toPublicSession,
} from '@/services/tokens'
import { createRole, createSessionRow, createUser, db, grant, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

const issueCode = async (overrides: Partial<Parameters<typeof issueAuthorizationCode>[1]> = {}) => {
  const user = overrides.userId ? null : await createUser()
  const code = await issueAuthorizationCode(db(), {
    userId: overrides.userId ?? (user as { id: string }).id,
    applicationId: overrides.applicationId ?? SEED.webAppId,
    provider: overrides.provider ?? 'magic_link',
    redirectUri: overrides.redirectUri ?? SEED.webRedirectUri,
    nonce: overrides.nonce ?? null,
    codeChallenge: overrides.codeChallenge ?? RFC7636.challenge,
    codeChallengeMethod: overrides.codeChallengeMethod ?? 'S256',
    scope: overrides.scope === undefined ? 'openid profile email' : overrides.scope,
  })
  return { code, userId: overrides.userId ?? (user as { id: string }).id }
}

describe('issueAuthorizationCode', () => {
  it('returns a 256-bit opaque code and stores only its hash', async () => {
    const { code } = await issueCode()

    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const [row] = await db().select().from(authorizationCodes).where(eq(authorizationCodes.codeHash, await sha256(code)))
    expect(row).toBeDefined()
    // A database dump must not be enough to redeem a code.
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('records the request the code was issued for, so the token endpoint can re-check it', async () => {
    const { code, userId } = await issueCode({ provider: 'google', scope: 'openid' })
    const record = await consumeAuthorizationCode(db(), code)

    expect(record).toMatchObject({
      userId,
      applicationId: SEED.webAppId,
      provider: 'google',
      redirectUri: SEED.webRedirectUri,
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid',
    })
  })

  it('expires after the configured authorization-code TTL, neither sooner nor later', async () => {
    const { code } = await issueCode()
    const record = await consumeAuthorizationCode(db(), code)
    const lifetime = Math.round((record.expiresAt.getTime() - record.createdAt.getTime()) / 1000)

    // Both bounds are pinned: this is the shortest-lived credential the Worker issues, so a TTL
    // that silently grew is as much a defect as one that shrank. The slack is D1's second-precision.
    expect(lifetime).toBeGreaterThanOrEqual(TTL.authorizationCode - 1)
    expect(lifetime).toBeLessThanOrEqual(TTL.authorizationCode + 1)
  })

  it('never issues the same code twice', async () => {
    const codes = await Promise.all(Array.from({ length: 10 }, () => issueCode()))

    expect(new Set(codes.map((entry) => entry.code)).size).toBe(10)
  })
})

describe('consumeAuthorizationCode', () => {
  it('refuses a code that was never issued', async () => {
    await expect(consumeAuthorizationCode(db(), 'made-up-code')).rejects.toThrow(
      new OAuthException(400, 'invalid_grant', 'Unknown authorization code'),
    )
  })

  it('marks the code consumed and refuses the replay', async () => {
    const { code } = await issueCode()

    await expect(consumeAuthorizationCode(db(), code)).resolves.toBeDefined()

    const [row] = await db().select().from(authorizationCodes).where(eq(authorizationCodes.codeHash, await sha256(code)))
    expect(row?.consumedAt).not.toBeNull()

    await expect(consumeAuthorizationCode(db(), code)).rejects.toThrow('The authorization code has already been used')
  })

  it('lets exactly one of two concurrent exchanges win', async () => {
    const { code } = await issueCode()

    const outcomes = await Promise.allSettled([
      consumeAuthorizationCode(db(), code),
      consumeAuthorizationCode(db(), code),
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
  })

  it('refuses an expired code before spending it', async () => {
    const { code } = await issueCode()
    const codeHash = await sha256(code)
    await db()
      .update(authorizationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authorizationCodes.codeHash, codeHash))

    await expect(consumeAuthorizationCode(db(), code)).rejects.toThrow('The authorization code has expired')

    const [row] = await db().select().from(authorizationCodes).where(eq(authorizationCodes.codeHash, codeHash))
    expect(row?.consumedAt).toBeNull()
  })

  it('reports every failure as invalid_grant, never as a 500', async () => {
    const { code } = await issueCode()
    await consumeAuthorizationCode(db(), code)

    await expect(consumeAuthorizationCode(db(), code)).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
  })
})

describe('createSession', () => {
  it('records the sign-in and its client fingerprint', async () => {
    const user = await createUser()

    const session = await createSession(db(), {
      userId: user.id,
      applicationId: SEED.cmsAppId,
      provider: 'google',
      scope: 'openid email',
      ip: '203.0.113.7',
      userAgent: 'probe/1.0',
    })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row).toMatchObject({
      userId: user.id,
      applicationId: SEED.cmsAppId,
      provider: 'google',
      scope: 'openid email',
      ip: '203.0.113.7',
      userAgent: 'probe/1.0',
      revokedAt: null,
    })
  })
})

describe('issueRefreshToken', () => {
  it('stores only the hash and links the token to its parent', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })

    const first = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: user.id,
      applicationId: SEED.webAppId,
    })
    const [firstRow] = await db().select().from(refreshTokens).where(eq(refreshTokens.tokenHash, await sha256(first)))

    const second = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: user.id,
      applicationId: SEED.webAppId,
      parentId: firstRow?.id,
    })
    const [secondRow] = await db().select().from(refreshTokens).where(eq(refreshTokens.tokenHash, await sha256(second)))

    expect(firstRow?.parentId).toBeNull()
    expect(secondRow?.parentId).toBe(firstRow?.id)
    expect(JSON.stringify([firstRow, secondRow])).not.toContain(first)
  })

  it('expires after the configured refresh-token TTL', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const token = await issueRefreshToken(db(), { sessionId: session.id, userId: user.id, applicationId: SEED.webAppId })

    const [row] = await db().select().from(refreshTokens).where(eq(refreshTokens.tokenHash, await sha256(token)))
    const lifetime = (row?.expiresAt.getTime() ?? 0) - Date.now()

    expect(Math.round(lifetime / 1000)).toBeGreaterThan(TTL.refreshToken - 60)
    expect(Math.round(lifetime / 1000)).toBeLessThanOrEqual(TTL.refreshToken)
  })
})

describe('revokeSession', () => {
  it('kills the session and every token in its chain', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const token = await issueRefreshToken(db(), { sessionId: session.id, userId: user.id, applicationId: SEED.webAppId })

    await revokeSession(db(), session.id, 'logout')

    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    const [tokenRow] = await db().select().from(refreshTokens).where(eq(refreshTokens.tokenHash, await sha256(token)))

    expect(sessionRow?.revokedAt).not.toBeNull()
    expect(sessionRow?.revokedReason).toBe('logout')
    expect(tokenRow?.revokedAt).not.toBeNull()
    expect(tokenRow?.revokedReason).toBe('logout')
  })

  it('keeps the original reason when a session is revoked twice', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })

    await revokeSession(db(), session.id, 'logout')
    await revokeSession(db(), session.id, 'admin_revocation')

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row?.revokedReason).toBe('logout')
  })

  it('leaves other sessions of the same user alone', async () => {
    const user = await createUser()
    const [revoked, kept] = await Promise.all([
      createSessionRow({ userId: user.id }),
      createSessionRow({ userId: user.id }),
    ])

    await revokeSession(db(), revoked.id, 'user_revocation')

    const [row] = await db().select().from(sessions).where(eq(sessions.id, kept.id))
    expect(row?.revokedAt).toBeNull()
  })
})

describe('consumeRefreshToken', () => {
  const chain = async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const token = await issueRefreshToken(db(), { sessionId: session.id, userId: user.id, applicationId: SEED.webAppId })
    return { user, session, token }
  }

  it('accepts a fresh token and marks it used', async () => {
    const { session, token } = await chain()

    const result = await consumeRefreshToken(db(), token)

    expect(result.session.id).toBe(session.id)
    expect(result.record.usedAt).toBeNull()

    const [row] = await db().select().from(refreshTokens).where(eq(refreshTokens.tokenHash, await sha256(token)))
    expect(row?.usedAt).not.toBeNull()
  })

  it('refuses a token that was never issued', async () => {
    await expect(consumeRefreshToken(db(), 'not-a-token')).rejects.toThrow('Unknown refresh token')
  })

  it('treats a replay as a leak and revokes the whole session', async () => {
    const { session, token } = await chain()
    const sibling = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: session.userId,
      applicationId: SEED.webAppId,
    })
    await consumeRefreshToken(db(), token)

    await expect(consumeRefreshToken(db(), token)).rejects.toThrow(
      'Refresh token reuse detected; the session has been revoked',
    )

    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(sessionRow?.revokedReason).toBe('refresh_token_reuse')

    // The legitimate holder of the newest token is logged out too; that is the intended trade-off.
    await expect(consumeRefreshToken(db(), sibling)).rejects.toThrow('This refresh token has been revoked')
  })

  it('revokes the session when two exchanges of the same token race', async () => {
    const { session, token } = await chain()

    const outcomes = await Promise.allSettled([consumeRefreshToken(db(), token), consumeRefreshToken(db(), token)])

    expect(outcomes.filter((outcome) => outcome.status === 'rejected').length).toBeGreaterThanOrEqual(1)
    const [sessionRow] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(sessionRow?.revokedAt).not.toBeNull()
  })

  it('refuses a revoked token', async () => {
    const { session, token } = await chain()
    await revokeSession(db(), session.id, 'logout')

    await expect(consumeRefreshToken(db(), token)).rejects.toThrow('This refresh token has been revoked')
  })

  it('refuses an expired token', async () => {
    const { token } = await chain()
    await db()
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.tokenHash, await sha256(token)))

    await expect(consumeRefreshToken(db(), token)).rejects.toThrow('The refresh token has expired')
  })

  it('refuses a live token whose session was revoked out from under it', async () => {
    const { session, token } = await chain()
    // Revoke the session without touching the token, which is what a direct row edit or a race leaves.
    await db().update(sessions).set({ revokedAt: new Date(), revokedReason: 'admin' }).where(eq(sessions.id, session.id))

    await expect(consumeRefreshToken(db(), token)).rejects.toThrow(
      'The session behind this refresh token is no longer active',
    )
  })

  it('checks reuse before expiry, so a leaked expired token still kills the session', async () => {
    const { session, token } = await chain()
    await consumeRefreshToken(db(), token)
    await db()
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokens.tokenHash, await sha256(token)))

    await expect(consumeRefreshToken(db(), token)).rejects.toThrow('Refresh token reuse detected')

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row?.revokedReason).toBe('refresh_token_reuse')
  })

  it('reports every failure as invalid_grant', async () => {
    await expect(consumeRefreshToken(db(), 'nope')).rejects.toMatchObject({ status: 400, code: 'invalid_grant' })
  })
})

describe('buildTokenResponse', () => {
  it('signs an access token carrying the roles the database holds right now', async () => {
    const user = await createUser({ name: 'Ada', picture: 'https://p.test/a.png' })
    const role = await createRole({ slug: 'token-role', permissions: ['users:read', 'audit:read'] })
    await grant(user.id, role.id)
    const session = await createSessionRow({ userId: user.id, provider: 'google' })

    const response = await buildTokenResponse(db(), env, {
      user,
      applicationId: SEED.webAppId,
      session,
      provider: 'google',
      scope: 'openid email',
    })

    expect(response).toMatchObject({
      token_type: 'Bearer',
      expires_in: TTL.accessToken,
      scope: 'openid email',
      session_id: session.id,
    })

    const claims = await verifyAccessToken(env, response.access_token)
    expect(claims).toMatchObject({
      sub: user.id,
      aud: SEED.webAppId,
      sid: session.id,
      provider: 'google',
      email: user.email,
      email_verified: true,
      name: 'Ada',
      picture: 'https://p.test/a.png',
      roles: ['token-role'],
      permissions: ['audit:read', 'users:read'],
    })
  })

  it('issues a usable refresh token linked to the session and to its parent', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const parent = await issueRefreshToken(db(), {
      sessionId: session.id,
      userId: user.id,
      applicationId: SEED.webAppId,
    })
    const [parentRow] = await db().select().from(refreshTokens).where(eq(refreshTokens.tokenHash, await sha256(parent)))

    const response = await buildTokenResponse(db(), env, {
      user,
      applicationId: SEED.webAppId,
      session,
      provider: 'magic_link',
      scope: null,
      parentRefreshTokenId: parentRow?.id,
    })

    const [child] = await db()
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await sha256(response.refresh_token as string)))

    expect(child?.parentId).toBe(parentRow?.id)
    expect(child?.sessionId).toBe(session.id)
    expect(response.scope).toBeNull()
  })

  it('touches the session so idle time is measured from the last token, not the first', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    await db()
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.id, session.id))

    await buildTokenResponse(db(), env, {
      user,
      applicationId: SEED.webAppId,
      session,
      provider: 'magic_link',
      scope: null,
    })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect((row?.lastSeenAt.getTime() ?? 0)).toBeGreaterThan(Date.now() - 10_000)
  })

  it('scopes the claims to the application the token is for', async () => {
    const user = await createUser()
    const scoped = await createRole({ slug: 'cms-only', applicationId: SEED.cmsAppId, permissions: ['users:read'] })
    await grant(user.id, scoped.id)
    const session = await createSessionRow({ userId: user.id, applicationId: SEED.webAppId })

    const response = await buildTokenResponse(db(), env, {
      user,
      applicationId: SEED.webAppId,
      session,
      provider: 'magic_link',
      scope: null,
    })

    const claims = await verifyAccessToken(env, response.access_token)
    expect(claims.roles).toEqual([])
    expect(claims.permissions).toEqual([])
  })
})

describe('toPublicSession', () => {
  it('flags the session the current access token belongs to', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id, provider: 'google' })

    expect(toPublicSession(session, session.id).current).toBe(true)
    expect(toPublicSession(session, 'another-session').current).toBe(false)
    expect(toPublicSession(session).current).toBe(false)
  })

  it('exposes the session metadata without leaking the user or scope', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })

    const published = toPublicSession(session)

    expect(Object.keys(published).sort()).toEqual([
      'application_id',
      'created_at',
      'current',
      'id',
      'ip',
      'last_seen_at',
      'provider',
      'revoked_at',
      'user_agent',
    ])
    expect(JSON.stringify(published)).not.toContain(user.id)
  })

  it('renders a revoked session with its revocation timestamp', async () => {
    const user = await createUser()
    const revokedAt = new Date('2026-03-04T05:06:07.000Z')
    const session = await createSessionRow({ userId: user.id, revokedAt })

    expect(toPublicSession(session).revoked_at).toBe('2026-03-04T05:06:07.000Z')
  })
})
