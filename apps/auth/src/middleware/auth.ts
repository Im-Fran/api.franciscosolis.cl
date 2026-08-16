import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { getDb } from '@/db/client'
import { sessions } from '@/db/schema'
import type { AppEnv } from '@/env'
import type { AccessTokenClaims } from '@/lib/jwt'
import { verifyAccessToken } from '@/lib/jwt'
import { findUserById, getUserAuthorization } from '@/services/users'
import type { User } from '@/services/users'

/** Everything a protected handler needs to know about the caller. */
type AuthenticatedActor = {
  user: User
  claims: AccessTokenClaims
  sessionId: string
  applicationId: string
  /** Re-read from the database on every request, not taken from the token — see `requireAuth`. */
  roles: string[]
  permissions: string[]
}

const bearerToken = (header: string | undefined) => {
  if (!header) {
    return null
  }
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return null
  }
  return rest.join(' ').trim() || null
}

/**
 * Authenticates a Bearer access token.
 *
 * The token's signature and claims are verified locally, but the roles and permissions attached to
 * the request are re-read from D1 rather than trusted from the token body. An access token lives
 * 15 minutes; without this, revoking a role would leave a window where a stale token still carried
 * it. The session is checked for the same reason: signing out must take effect immediately, and the
 * token itself cannot be un-issued.
 */
const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new HTTPException(401, { message: 'A Bearer access token is required' })
  }

  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token)
  } catch (error) {
    throw new HTTPException(401, { message: `Invalid access token: ${(error as Error).message}` })
  }

  const db = getDb(c.env)

  const user = await findUserById(db, claims.sub)
  if (!user) {
    throw new HTTPException(401, { message: 'The account behind this token no longer exists' })
  }
  if (user.status !== 'active') {
    throw new HTTPException(403, { message: 'This account is disabled' })
  }

  const [session] = await db.select().from(sessions).where(eq(sessions.id, claims.sid)).limit(1)
  if (!session || session.revokedAt) {
    throw new HTTPException(401, { message: 'This session has been revoked' })
  }

  const authorization = await getUserAuthorization(db, user.id, claims.aud)

  c.set('actor', {
    user,
    claims,
    sessionId: session.id,
    applicationId: claims.aud,
    roles: authorization.roles,
    permissions: authorization.permissions,
  })

  await next()
})

/** Gate for admin routes. Checks a permission slug, never a role name, so roles stay re-definable. */
const requirePermission = (permission: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const actor = c.get('actor')
    if (!actor?.permissions.includes(permission)) {
      throw new HTTPException(403, { message: `Missing required permission: ${permission}` })
    }
    await next()
  })

export { requireAuth, requirePermission }
export type { AuthenticatedActor }
