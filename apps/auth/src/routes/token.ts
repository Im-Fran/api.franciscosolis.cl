import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv } from '@/env'
import type { ProviderName } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { isValidCodeVerifier, verifyPkce } from '@/lib/pkce'
import { authenticateClient, getApplication } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import {
  buildTokenResponse,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createSession,
  revokeSession,
} from '@/services/tokens'
import { findUserById } from '@/services/users'
import { eq } from 'drizzle-orm'
import { refreshTokens } from '@/db/schema'

const app = new Hono<AppEnv>()

/**
 * One schema for both grants: RFC 6749 sends the token request as a flat form body, so the fields
 * a grant does not use are simply absent. Which combination is required is enforced per grant below.
 */
const tokenRequestSchema = v.object({
  grant_type: v.picklist(['authorization_code', 'refresh_token']),
  client_id: v.pipe(v.string(), v.minLength(1)),
  client_secret: v.optional(v.string()),
  code: v.optional(v.string()),
  redirect_uri: v.optional(v.string()),
  code_verifier: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
})

const tokenResponseSchema = v.object({
  access_token: v.string(),
  token_type: v.literal('Bearer'),
  expires_in: v.number(),
  refresh_token: v.string(),
  scope: v.nullable(v.string()),
  session_id: v.string(),
})

app.post(
  '/oauth/token',
  describeRoute({
    description:
      'Exchanges an authorization code for tokens, or rotates a refresh token. Takes an `application/x-www-form-urlencoded` body and answers with the flat OAuth 2.0 token response (not this API\'s usual `{ code, data }` envelope), so standard OAuth clients work unchanged. Refresh tokens are single-use: every exchange returns a new one and invalidates the old.',
    tags: ['OAuth'],
    responses: {
      200: {
        description: 'Access token, refresh token and metadata',
        content: { 'application/json': { schema: resolver(tokenResponseSchema) } },
      },
      400: { description: 'invalid_request / invalid_grant / unsupported_grant_type' },
      401: { description: 'invalid_client' },
    },
  }),
  validator('form', tokenRequestSchema),
  async (c) => {
    const body = c.req.valid('form')
    const db = getDb(c.env)
    const context = getRequestContext(c)

    const application = await getApplication(db, body.client_id)
    if (!application) {
      throw new OAuthException(401, 'invalid_client', 'Unknown or inactive client_id')
    }
    await authenticateClient(application, body.client_secret)

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri || !body.code_verifier) {
        throw new OAuthException(
          400,
          'invalid_request',
          'code, redirect_uri and code_verifier are required for the authorization_code grant',
        )
      }
      if (!isValidCodeVerifier(body.code_verifier)) {
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
      if (!(await verifyPkce(body.code_verifier, record.codeChallenge, record.codeChallengeMethod))) {
        throw new OAuthException(400, 'invalid_grant', 'code_verifier does not match the code_challenge')
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
  client_id: v.pipe(v.string(), v.minLength(1)),
  client_secret: v.optional(v.string()),
})

app.post(
  '/oauth/revoke',
  describeRoute({
    description:
      'Revokes a refresh token and the session behind it (RFC 7009). Always answers 200, including for tokens that do not exist, so it cannot be used to probe which tokens are valid.',
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

    const application = await getApplication(db, body.client_id)
    if (!application) {
      throw new OAuthException(401, 'invalid_client', 'Unknown or inactive client_id')
    }
    await authenticateClient(application, body.client_secret)

    const [record] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, await sha256(body.token)))
      .limit(1)

    if (record && record.applicationId === application.id) {
      await revokeSession(db, record.sessionId, 'client_revocation')
      await recordAudit(db, {
        event: 'token.revoked',
        userId: record.userId,
        applicationId: application.id,
        ...context,
        metadata: { session_id: record.sessionId },
      })
    }

    return c.body(null, 200)
  },
)

export default app
