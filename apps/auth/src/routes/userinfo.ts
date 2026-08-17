import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { sessions } from '@/db/schema'
import type { AppEnv } from '@/env'
import { OAuthException } from '@/lib/errors'
import { verifyAccessToken } from '@/lib/jwt'
import type { AccessTokenClaims } from '@/lib/jwt'
import { hasScope } from '@/services/applications'
import { roleClaims, userClaims } from '@/services/tokens'
import { findUserById, getUserAuthorization } from '@/services/users'

const app = new Hono<AppEnv>()

const userinfoResponseSchema = v.object({
  sub: v.string(),
  email: v.optional(v.string()),
  email_verified: v.optional(v.boolean()),
  name: v.optional(v.nullable(v.string())),
  given_name: v.optional(v.nullable(v.string())),
  family_name: v.optional(v.nullable(v.string())),
  picture: v.optional(v.nullable(v.string())),
  locale: v.optional(v.nullable(v.string())),
  roles: v.optional(v.array(v.string())),
  groups: v.optional(v.array(v.string())),
  permissions: v.optional(v.array(v.string())),
})

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
 * OIDC UserInfo (Core §5.3).
 *
 * Two things distinguish it from `/me`: it answers with the flat OIDC claim set instead of this
 * API's envelope, and the claims it returns are the ones the token's own `scope` entitles it to —
 * so a token granted `openid` alone learns nothing but the subject identifier. Like every other
 * authenticated route here it re-reads the user and the session, which is what makes a revoked
 * session stop working before its access token expires.
 */
const resolveClaims = async (c: Context<AppEnv>) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new OAuthException(401, 'invalid_request', 'A Bearer access token is required')
  }

  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token)
  } catch (error) {
    throw new OAuthException(401, 'invalid_grant', `Invalid access token: ${(error as Error).message}`)
  }

  if (!claims.sid) {
    throw new OAuthException(403, 'access_denied', 'This endpoint needs a token issued for a user, not for a client')
  }

  const db = getDb(c.env)
  const user = await findUserById(db, claims.sub)
  if (!user || user.status !== 'active') {
    throw new OAuthException(401, 'invalid_grant', 'The account behind this token is no longer active')
  }

  const [session] = await db.select().from(sessions).where(eq(sessions.id, claims.sid)).limit(1)
  if (!session || session.revokedAt) {
    throw new OAuthException(401, 'invalid_grant', 'This session has been revoked')
  }

  const scope = claims.scope ?? ''
  if (!hasScope(scope, 'openid')) {
    throw new OAuthException(403, 'access_denied', 'This token was not granted the openid scope')
  }

  const authorization = await getUserAuthorization(db, user.id, claims.aud)

  return {
    sub: user.id,
    ...userClaims(user, scope),
    ...roleClaims(authorization, scope),
  }
}

const route = describeRoute({
  description:
    "The OpenID Connect UserInfo endpoint (Core §5.3). Returns the claims about the authenticated user that the access token's own scope entitles the caller to, in the flat OIDC shape rather than this API's `{ code, data }` envelope. Accepts GET and POST, as the specification requires.",
  tags: ['OAuth'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Claims about the subject of the access token',
      content: { 'application/json': { schema: resolver(userinfoResponseSchema) } },
    },
    401: { description: 'Missing, invalid or revoked access token' },
    403: { description: 'The token was not granted the openid scope, or belongs to a client rather than a user' },
  },
})

app.get('/oauth/userinfo', route, async (c) => c.json(await resolveClaims(c)))
app.post('/oauth/userinfo', route, async (c) => c.json(await resolveClaims(c)))

export default app
