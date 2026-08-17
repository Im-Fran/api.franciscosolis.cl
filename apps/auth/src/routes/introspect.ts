import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { refreshTokens, sessions } from '@/db/schema'
import type { AppEnv } from '@/env'
import { sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { verifyAccessToken } from '@/lib/jwt'
import { authenticateClient, getApplication, readClientCredentials } from '@/services/applications'
import type { Application } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import { findUserById } from '@/services/users'

const app = new Hono<AppEnv>()

const introspectRequestSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
  token_type_hint: v.optional(v.string()),
  client_id: v.optional(v.string()),
  client_secret: v.optional(v.string()),
})

const introspectResponseSchema = v.object({
  active: v.boolean(),
  scope: v.optional(v.nullable(v.string())),
  client_id: v.optional(v.string()),
  username: v.optional(v.string()),
  token_type: v.optional(v.string()),
  exp: v.optional(v.number()),
  iat: v.optional(v.number()),
  sub: v.optional(v.string()),
  aud: v.optional(v.string()),
  iss: v.optional(v.string()),
  jti: v.optional(v.string()),
  sid: v.optional(v.string()),
})

/** RFC 7662 §2.2: a token that is unknown, expired, revoked or someone else's is just `inactive`. */
const INACTIVE = { active: false } as const

const authenticateRequest = async (
  c: Context<AppEnv>,
  body: { client_id?: string; client_secret?: string },
): Promise<Application> => {
  const db = getDb(c.env)
  const credentials = readClientCredentials(c.req.header('Authorization'), body)

  const application = await getApplication(db, credentials.clientId)
  if (!application) {
    throw new OAuthException(401, 'invalid_client', 'Unknown or inactive client_id')
  }

  try {
    await authenticateClient(db, application, credentials)
  } catch (error) {
    if (error instanceof OAuthException) {
      await recordAudit(db, {
        event: 'client.authentication_failed',
        applicationId: application.id,
        ...getRequestContext(c),
        metadata: { method: credentials.method, reason: error.code, endpoint: 'introspect' },
      })
    }
    throw error
  }

  return application
}

app.post(
  '/oauth/introspect',
  describeRoute({
    description:
      'Token introspection (RFC 7662). Tells the calling client whether one of *its own* tokens is still usable, and what it stands for. Both access tokens and refresh tokens are accepted. A token issued to a different client is reported as inactive rather than refused, so this cannot be used to enumerate another application\'s tokens. Note that an access token this server issued can also be validated offline against the JWKS — introspection additionally reflects revocation, which an offline check cannot see.',
    tags: ['OAuth'],
    responses: {
      200: {
        description: 'The state of the token',
        content: { 'application/json': { schema: resolver(introspectResponseSchema) } },
      },
      401: { description: 'invalid_client' },
    },
  }),
  validator('form', introspectRequestSchema),
  async (c) => {
    const body = c.req.valid('form')
    const db = getDb(c.env)
    const application = await authenticateRequest(c, body)

    // The hint is advisory (RFC 7662 §2.1): both lookups run regardless, in the order the hint
    // suggests, because a client that guesses wrong must still get the right answer.
    const refreshFirst = body.token_type_hint !== 'access_token'
    const lookups = refreshFirst
      ? [introspectRefreshToken, introspectAccessToken]
      : [introspectAccessToken, introspectRefreshToken]

    for (const lookup of lookups) {
      const result = await lookup(c, application, body.token)
      if (result) {
        return c.json(result)
      }
    }

    return c.json(INACTIVE)
  },
)

/** Resolves a refresh token. Returns null when this is not a refresh token at all. */
const introspectRefreshToken = async (c: Context<AppEnv>, application: Application, token: string) => {
  const db = getDb(c.env)
  const [record] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, await sha256(token)))
    .limit(1)

  if (!record) {
    return null
  }
  if (record.applicationId !== application.id) {
    return INACTIVE
  }

  const [session] = await db.select().from(sessions).where(eq(sessions.id, record.sessionId)).limit(1)
  const live =
    !record.usedAt &&
    !record.revokedAt &&
    record.expiresAt.getTime() > Date.now() &&
    Boolean(session) &&
    !session?.revokedAt

  if (!live) {
    return INACTIVE
  }

  const user = await findUserById(db, record.userId)
  return {
    active: user?.status === 'active',
    ...(user?.status === 'active'
      ? {
          scope: session?.scope ?? null,
          client_id: record.applicationId,
          username: user.email,
          token_type: 'refresh_token',
          exp: Math.floor(record.expiresAt.getTime() / 1000),
          iat: Math.floor(record.createdAt.getTime() / 1000),
          sub: record.userId,
          aud: record.applicationId,
          iss: c.env.AUTH_ISSUER,
          jti: record.id,
          sid: record.sessionId,
        }
      : {}),
  }
}

/** Resolves an access token. Returns null when the value is not a JWT this server issued. */
const introspectAccessToken = async (c: Context<AppEnv>, application: Application, token: string) => {
  const db = getDb(c.env)

  let claims
  try {
    claims = await verifyAccessToken(c.env, token)
  } catch {
    return null
  }

  if (claims.aud !== application.id) {
    return INACTIVE
  }

  // A client credentials token has no session and no user behind it: the signature and the expiry
  // are the whole of its validity.
  if (!claims.sid) {
    return {
      active: true,
      scope: claims.scope || null,
      client_id: claims.client_id,
      token_type: 'access_token',
      exp: claims.exp,
      iat: claims.iat,
      sub: claims.sub,
      aud: claims.aud,
      iss: claims.iss,
      jti: claims.jti,
    }
  }

  const [session] = await db.select().from(sessions).where(eq(sessions.id, claims.sid)).limit(1)
  if (!session || session.revokedAt) {
    return INACTIVE
  }

  const user = await findUserById(db, claims.sub)
  if (!user || user.status !== 'active') {
    return INACTIVE
  }

  return {
    active: true,
    scope: claims.scope || null,
    client_id: claims.client_id,
    username: user.email,
    token_type: 'access_token',
    exp: claims.exp,
    iat: claims.iat,
    sub: claims.sub,
    aud: claims.aud,
    iss: claims.iss,
    jti: claims.jti,
    sid: claims.sid,
  }
}

export default app
