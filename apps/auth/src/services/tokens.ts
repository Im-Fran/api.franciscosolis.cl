import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { authorizationCodes, refreshTokens, sessions } from '@/db/schema'
import type { Env } from '@/env'
import { TTL } from '@/lib/config'
import type { ProviderName } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { signAccessToken } from '@/lib/jwt'
import { getUserAuthorization } from '@/services/users'
import type { User } from '@/services/users'

type Session = typeof sessions.$inferSelect
type RefreshToken = typeof refreshTokens.$inferSelect
type AuthorizationCode = typeof authorizationCodes.$inferSelect

const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000)

type IssueCodeInput = {
  userId: string
  applicationId: string
  provider: ProviderName
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope: string | null
}

/** Mints the one-time code handed to the client in the redirect. Only its hash is stored. */
const issueAuthorizationCode = async (db: Database, input: IssueCodeInput) => {
  const code = randomToken(32)
  await db.insert(authorizationCodes).values({
    id: generateId(),
    codeHash: await sha256(code),
    userId: input.userId,
    applicationId: input.applicationId,
    provider: input.provider,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    expiresAt: expiresIn(TTL.authorizationCode),
  })
  return code
}

/**
 * Consumes an authorization code, atomically. The `consumed_at IS NULL` guard in the UPDATE is what
 * makes the code single-use: two concurrent exchanges race on the same row and exactly one of them
 * gets a result back, so a replayed code can never mint a second session.
 */
const consumeAuthorizationCode = async (db: Database, code: string): Promise<AuthorizationCode> => {
  const codeHash = await sha256(code)
  const [record] = await db.select().from(authorizationCodes).where(eq(authorizationCodes.codeHash, codeHash)).limit(1)

  if (!record) {
    throw new OAuthException(400, 'invalid_grant', 'Unknown authorization code')
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new OAuthException(400, 'invalid_grant', 'The authorization code has expired')
  }

  const consumed = await db
    .update(authorizationCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(authorizationCodes.id, record.id), isNull(authorizationCodes.consumedAt)))
    .returning({ id: authorizationCodes.id })

  if (consumed.length === 0) {
    throw new OAuthException(400, 'invalid_grant', 'The authorization code has already been used')
  }

  return record
}

type CreateSessionInput = {
  userId: string
  applicationId: string
  provider: ProviderName
  scope: string | null
  ip: string | null
  userAgent: string | null
}

const createSession = async (db: Database, input: CreateSessionInput): Promise<Session> => {
  const now = new Date()
  const session: Session = {
    id: generateId(),
    userId: input.userId,
    applicationId: input.applicationId,
    provider: input.provider,
    scope: input.scope,
    lastSeenAt: now,
    revokedAt: null,
    revokedReason: null,
    ip: input.ip,
    userAgent: input.userAgent,
    createdAt: now,
  }
  await db.insert(sessions).values(session)
  return session
}

const issueRefreshToken = async (
  db: Database,
  input: { sessionId: string; userId: string; applicationId: string; parentId?: string | null },
) => {
  const token = randomToken(32)
  await db.insert(refreshTokens).values({
    id: generateId(),
    sessionId: input.sessionId,
    userId: input.userId,
    applicationId: input.applicationId,
    tokenHash: await sha256(token),
    parentId: input.parentId ?? null,
    expiresAt: expiresIn(TTL.refreshToken),
  })
  return token
}

/** Kills a session and every refresh token in its rotation chain. */
const revokeSession = async (db: Database, sessionId: string, reason: string) => {
  const now = new Date()
  await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
  await db
    .update(refreshTokens)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)))
}

/**
 * Consumes a refresh token as part of a rotation.
 *
 * A token that was already used is the signature of a leak: the legitimate client would have been
 * handed a fresh token and never replay the old one. Rather than refuse just that request, the whole
 * session is revoked, which logs out both the attacker and the victim — the only outcome that does
 * not leave a thief holding a valid chain.
 */
const consumeRefreshToken = async (db: Database, token: string) => {
  const tokenHash = await sha256(token)
  const [record] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1)

  if (!record) {
    throw new OAuthException(400, 'invalid_grant', 'Unknown refresh token')
  }

  if (record.usedAt) {
    await revokeSession(db, record.sessionId, 'refresh_token_reuse')
    throw new OAuthException(400, 'invalid_grant', 'Refresh token reuse detected; the session has been revoked')
  }
  if (record.revokedAt) {
    throw new OAuthException(400, 'invalid_grant', 'This refresh token has been revoked')
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new OAuthException(400, 'invalid_grant', 'The refresh token has expired')
  }

  const [session] = await db.select().from(sessions).where(eq(sessions.id, record.sessionId)).limit(1)
  if (!session || session.revokedAt) {
    throw new OAuthException(400, 'invalid_grant', 'The session behind this refresh token is no longer active')
  }

  const used = await db
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(refreshTokens.id, record.id), isNull(refreshTokens.usedAt)))
    .returning({ id: refreshTokens.id })

  if (used.length === 0) {
    // Lost the race against a concurrent exchange of the same token: same conclusion as above.
    await revokeSession(db, record.sessionId, 'refresh_token_reuse')
    throw new OAuthException(400, 'invalid_grant', 'Refresh token reuse detected; the session has been revoked')
  }

  return { record, session }
}

type TokenResponse = {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string | null
  session_id: string
}

/**
 * Builds the token endpoint's response: a freshly signed access token carrying the user's roles and
 * permissions, plus the next refresh token in the chain.
 */
const buildTokenResponse = async (
  db: Database,
  env: Env,
  input: {
    user: User
    applicationId: string
    session: Session
    provider: ProviderName
    scope: string | null
    parentRefreshTokenId?: string | null
  },
): Promise<TokenResponse> => {
  const authorization = await getUserAuthorization(db, input.user.id, input.applicationId)

  const { token: accessToken, expiresIn: accessTokenTtl } = await signAccessToken(env, {
    sub: input.user.id,
    aud: input.applicationId,
    sid: input.session.id,
    provider: input.provider,
    email: input.user.email,
    email_verified: input.user.emailVerifiedAt !== null,
    name: input.user.name,
    picture: input.user.picture,
    roles: authorization.roles,
    permissions: authorization.permissions,
  })

  const refreshToken = await issueRefreshToken(db, {
    sessionId: input.session.id,
    userId: input.user.id,
    applicationId: input.applicationId,
    parentId: input.parentRefreshTokenId ?? null,
  })

  await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, input.session.id))

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTokenTtl,
    refresh_token: refreshToken,
    scope: input.scope,
    session_id: input.session.id,
  }
}

/** Public shape of a session, used by `/me/sessions` and the admin API. */
const toPublicSession = (session: Session, currentSessionId?: string) => ({
  id: session.id,
  application_id: session.applicationId,
  provider: session.provider,
  ip: session.ip,
  user_agent: session.userAgent,
  current: session.id === currentSessionId,
  revoked_at: session.revokedAt?.toISOString() ?? null,
  last_seen_at: session.lastSeenAt.toISOString(),
  created_at: session.createdAt.toISOString(),
})

export {
  buildTokenResponse,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createSession,
  issueAuthorizationCode,
  issueRefreshToken,
  revokeSession,
  toPublicSession,
}
export type { AuthorizationCode, RefreshToken, Session, TokenResponse }
