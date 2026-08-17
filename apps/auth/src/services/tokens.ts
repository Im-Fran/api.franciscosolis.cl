import { and, eq, isNull } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { authorizationCodes, refreshTokens, sessions } from '@/db/schema'
import type { Env } from '@/env'
import { TTL } from '@/lib/config'
import type { ProviderName } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { accessTokenHash, signAccessToken, signIdToken } from '@/lib/jwt'
import { hasScope } from '@/services/applications'
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
  nonce: string | null
  codeChallenge: string | null
  codeChallengeMethod: string | null
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
    nonce: input.nonce,
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
  refresh_token?: string
  /** Present when the granted scope contains `openid`, i.e. when this is an OIDC flow. */
  id_token?: string
  scope: string | null
  session_id?: string
}

/**
 * Builds the token endpoint's response: a freshly signed access token carrying the user's roles and
 * permissions, the next refresh token in the chain, and — for an OIDC request — an id_token.
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
    /** Only set on the authorization code exchange; a refresh never re-plays the original nonce. */
    nonce?: string | null
  },
): Promise<TokenResponse> => {
  const authorization = await getUserAuthorization(db, input.user.id, input.applicationId)
  const scope = input.scope

  const { token: accessToken, expiresIn: accessTokenTtl } = await signAccessToken(env, {
    sub: input.user.id,
    aud: input.applicationId,
    client_id: input.applicationId,
    scope: scope ?? '',
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

  const response: TokenResponse = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTokenTtl,
    refresh_token: refreshToken,
    scope,
    session_id: input.session.id,
  }

  if (hasScope(scope, 'openid')) {
    const { token: idToken } = await signIdToken(env, {
      sub: input.user.id,
      aud: input.applicationId,
      sid: input.session.id,
      // The sign-in, not this exchange: a refresh must not make an old authentication look fresh.
      auth_time: Math.floor(input.session.createdAt.getTime() / 1000),
      nonce: input.nonce ?? undefined,
      at_hash: await accessTokenHash(accessToken),
      provider: input.provider,
      ...userClaims(input.user, scope),
      ...roleClaims(authorization, scope),
    })
    response.id_token = idToken
  }

  return response
}

/**
 * The profile claims a scope entitles the holder to, shared by the id_token and `/oauth/userinfo`
 * so the two can never describe the same user differently.
 */
const userClaims = (user: User, scope: string | null) => ({
  ...(hasScope(scope, 'email')
    ? { email: user.email, email_verified: user.emailVerifiedAt !== null }
    : {}),
  ...(hasScope(scope, 'profile')
    ? {
        name: user.name,
        given_name: user.givenName,
        family_name: user.familyName,
        picture: user.picture,
        locale: user.locale,
      }
    : {}),
})

/**
 * Role claims, under both names: `roles` is this API's own vocabulary, `groups` is what relying
 * parties doing group-based access control read. Permissions ride along with `roles` because a
 * consumer that asked for one invariably wants the other.
 */
const roleClaims = (authorization: { roles: string[]; permissions: string[] }, scope: string | null) => ({
  ...(hasScope(scope, 'roles') ? { roles: authorization.roles, permissions: authorization.permissions } : {}),
  ...(hasScope(scope, 'groups') ? { groups: authorization.roles } : {}),
})

/**
 * The client credentials grant (RFC 6749 §4.4): the application authenticates as itself, with no
 * user behind it. There is no session, no refresh token and no id_token — nobody was authenticated,
 * so there is nothing to make a statement about. `sub` is the client id, which is what a resource
 * server needs to tell a machine caller from a person.
 */
const buildClientTokenResponse = async (
  env: Env,
  input: { applicationId: string; scope: string | null },
): Promise<TokenResponse> => {
  const { token: accessToken, expiresIn: accessTokenTtl } = await signAccessToken(env, {
    sub: input.applicationId,
    aud: input.applicationId,
    client_id: input.applicationId,
    scope: input.scope ?? '',
    roles: [],
    permissions: [],
  })

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: accessTokenTtl,
    scope: input.scope,
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
  buildClientTokenResponse,
  buildTokenResponse,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createSession,
  issueAuthorizationCode,
  issueRefreshToken,
  revokeSession,
  roleClaims,
  toPublicSession,
  userClaims,
}
export type { AuthorizationCode, RefreshToken, Session, TokenResponse }
