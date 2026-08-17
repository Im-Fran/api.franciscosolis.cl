import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { refreshTokens } from '@/db/schema'
import type { AppEnv } from '@/env'
import type { GrantType, ProviderName } from '@/lib/config'
import { GRANT_TYPES } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { verifyAccessToken } from '@/lib/jwt'
import { isValidCodeVerifier, verifyPkce } from '@/lib/pkce'
import {
  assertGrantAllowed,
  authenticateClient,
  getApplication,
  isConfidential,
  normalizeScope,
  readClientCredentials,
} from '@/services/applications'
import type { Application } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import {
  buildClientTokenResponse,
  buildTokenResponse,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createSession,
  revokeSession,
} from '@/services/tokens'
import { findUserById } from '@/services/users'

const app = new Hono<AppEnv>()

/**
 * One schema for every grant: RFC 6749 sends the token request as a flat form body, so the fields a
 * grant does not use are simply absent. Which combination is required is enforced per grant below.
 * `client_id` is optional here because a client authenticating with HTTP Basic carries it in the
 * header instead — `readClientCredentials` is what reconciles the two.
 */
const tokenRequestSchema = v.object({
  grant_type: v.pipe(v.string(), v.minLength(1)),
  client_id: v.optional(v.string()),
  client_secret: v.optional(v.string()),
  code: v.optional(v.string()),
  redirect_uri: v.optional(v.string()),
  code_verifier: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
})

const tokenResponseSchema = v.object({
  access_token: v.string(),
  token_type: v.literal('Bearer'),
  expires_in: v.number(),
  refresh_token: v.optional(v.string()),
  id_token: v.optional(v.string()),
  scope: v.nullable(v.string()),
  session_id: v.optional(v.string()),
})

/**
 * Resolves and authenticates the client of a token-endpoint request.
 *
 * A failed authentication is audited before it is thrown: a run of these against one client is the
 * signature of a leaked-and-rotated secret still being used, or of someone guessing.
 */
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
        metadata: { method: credentials.method, reason: error.code },
      })
    }
    throw error
  }

  return application
}

app.post(
  '/oauth/token',
  describeRoute({
    description:
      "The token endpoint (RFC 6749 §3.2). Exchanges an authorization code for tokens, rotates a refresh token, or issues a token to a client acting for itself. Takes an `application/x-www-form-urlencoded` body and answers with the flat OAuth 2.0 token response — not this API's usual `{ code, data }` envelope — so standard OAuth clients work unchanged. A confidential client authenticates with the method it registered, either HTTP Basic or the body. When the granted scope contains `openid` the response also carries an `id_token`. Refresh tokens are single-use: every exchange returns a new one and invalidates the old.",
    tags: ['OAuth'],
    responses: {
      200: {
        description: 'Access token, refresh token and metadata',
        content: { 'application/json': { schema: resolver(tokenResponseSchema) } },
      },
      400: { description: 'invalid_request / invalid_grant / unsupported_grant_type / unauthorized_client' },
      401: { description: 'invalid_client' },
    },
  }),
  validator('form', tokenRequestSchema),
  async (c) => {
    const body = c.req.valid('form')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    if (!GRANT_TYPES.includes(body.grant_type as GrantType)) {
      throw new OAuthException(400, 'unsupported_grant_type', `Unsupported grant_type: ${body.grant_type}`)
    }
    const grantType = body.grant_type as GrantType

    const application = await authenticateRequest(c, body)
    assertGrantAllowed(application, grantType)

    if (grantType === 'client_credentials') {
      // Nothing but the secret stands between a caller and this grant, so a client that holds no
      // secret can never use it, however it is registered.
      if (!isConfidential(application)) {
        throw new OAuthException(400, 'unauthorized_client', 'The client_credentials grant requires a confidential client')
      }

      const scope = normalizeScope(body.scope, application)
      const response = await buildClientTokenResponse(c.env, { applicationId: application.id, scope })

      await recordAudit(db, {
        event: 'token.issued',
        applicationId: application.id,
        ...context,
        metadata: { grant_type: grantType, scope },
      })

      return c.json(response)
    }

    if (grantType === 'authorization_code') {
      if (!body.code || !body.redirect_uri) {
        throw new OAuthException(
          400,
          'invalid_request',
          'code and redirect_uri are required for the authorization_code grant',
        )
      }
      if (body.code_verifier && !isValidCodeVerifier(body.code_verifier)) {
        throw new OAuthException(400, 'invalid_request', 'code_verifier must be 43-128 unreserved characters')
      }

      const record = await consumeAuthorizationCode(db, body.code)

      // The code is already spent at this point; every check below fails closed and the client has
      // to start a new sign-in, which is exactly what should happen if any of them does not match.
      if (record.applicationId !== application.id) {
        throw new OAuthException(400, 'invalid_grant', 'This authorization code was issued to another client')
      }
      if (record.redirectUri !== body.redirect_uri) {
        throw new OAuthException(400, 'invalid_grant', 'redirect_uri does not match the authorization request')
      }

      // A code minted with a challenge always has to be answered with a verifier, whatever the
      // client's current configuration says: turning `require_pkce` off must not retroactively
      // unbind a code that was issued under it.
      if (record.codeChallenge) {
        if (!body.code_verifier) {
          throw new OAuthException(400, 'invalid_request', 'code_verifier is required for this authorization code')
        }
        if (!(await verifyPkce(body.code_verifier, record.codeChallenge, record.codeChallengeMethod ?? ''))) {
          throw new OAuthException(400, 'invalid_grant', 'code_verifier does not match the code_challenge')
        }
      } else if (body.code_verifier) {
        throw new OAuthException(400, 'invalid_grant', 'This authorization code was issued without a code_challenge')
      }

      const user = await findUserById(db, record.userId)
      if (!user) {
        throw new OAuthException(400, 'invalid_grant', 'The account behind this code no longer exists')
      }
      if (user.status !== 'active') {
        throw new OAuthException(403, 'access_denied', 'This account is disabled')
      }

      const session = await createSession(db, {
        userId: user.id,
        applicationId: application.id,
        provider: record.provider as ProviderName,
        scope: record.scope,
        ...context,
      })

      const response = await buildTokenResponse(db, c.env, {
        user,
        applicationId: application.id,
        session,
        provider: record.provider as ProviderName,
        scope: record.scope,
        nonce: record.nonce,
      })

      await recordAudit(db, {
        event: 'token.issued',
        userId: user.id,
        applicationId: application.id,
        ...context,
        metadata: { provider: record.provider, session_id: session.id },
      })

      return c.json(response)
    }

    if (!body.refresh_token) {
      throw new OAuthException(400, 'invalid_request', 'refresh_token is required for the refresh_token grant')
    }

    const { record, session } = await consumeRefreshToken(db, body.refresh_token)

    if (record.applicationId !== application.id) {
      throw new OAuthException(400, 'invalid_grant', 'This refresh token was issued to another client')
    }

    const user = await findUserById(db, record.userId)
    if (!user) {
      throw new OAuthException(400, 'invalid_grant', 'The account behind this token no longer exists')
    }
    if (user.status !== 'active') {
      throw new OAuthException(403, 'access_denied', 'This account is disabled')
    }

    const response = await buildTokenResponse(db, c.env, {
      user,
      applicationId: application.id,
      session,
      provider: session.provider as ProviderName,
      // Carried over from the session: refreshing re-issues the granted scope, never a wider one.
      scope: session.scope,
      parentRefreshTokenId: record.id,
    })

    await recordAudit(db, {
      event: 'token.refreshed',
      userId: user.id,
      applicationId: application.id,
      ...context,
      metadata: { session_id: session.id },
    })

    return c.json(response)
  },
)

const revokeRequestSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1)),
  token_type_hint: v.optional(v.string()),
  client_id: v.optional(v.string()),
  client_secret: v.optional(v.string()),
})

app.post(
  '/oauth/revoke',
  describeRoute({
    description:
      'Revokes a token and the session behind it (RFC 7009). Both refresh tokens and access tokens are accepted; either way the whole session dies, which is what a client asking to revoke actually wants. Always answers 200, including for tokens that do not exist, so it cannot be used to probe which tokens are valid.',
    tags: ['OAuth'],
    responses: {
      200: { description: 'The token is no longer valid' },
      401: { description: 'invalid_client' },
    },
  }),
  validator('form', revokeRequestSchema),
  async (c) => {
    const body = c.req.valid('form')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    const application = await authenticateRequest(c, body)
    const revoked = await resolveRevocationTarget(c, application, body.token)

    if (revoked) {
      await revokeSession(db, revoked.sessionId, 'client_revocation')
      await recordAudit(db, {
        event: 'token.revoked',
        userId: revoked.userId,
        applicationId: application.id,
        ...context,
        metadata: { session_id: revoked.sessionId },
      })
    }

    return c.body(null, 200)
  },
)

/**
 * Finds the session a revocation request is aimed at, from either kind of token.
 *
 * A token belonging to a different client is treated as not found: RFC 7009 requires that case to
 * be silent, and answering anything else would tell one client whether another's token exists.
 */
const resolveRevocationTarget = async (
  c: Context<AppEnv>,
  application: Application,
  token: string,
): Promise<{ sessionId: string; userId: string } | null> => {
  const db = getDb(c.env)

  const [refresh] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, await sha256(token)))
    .limit(1)

  if (refresh) {
    return refresh.applicationId === application.id ? { sessionId: refresh.sessionId, userId: refresh.userId } : null
  }

  try {
    const claims = await verifyAccessToken(c.env, token)
    if (claims.aud !== application.id || !claims.sid) {
      return null
    }
    return { sessionId: claims.sid, userId: claims.sub }
  } catch {
    // Not a token this server issued, or one that has expired. Nothing to revoke either way.
    return null
  }
}

export default app
