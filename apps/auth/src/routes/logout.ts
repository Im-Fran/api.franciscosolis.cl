import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { describeRoute, validator } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { sessions } from '@/db/schema'
import type { AppEnv } from '@/env'
import { RedirectValidationException } from '@/lib/errors'
import type { IdTokenClaims } from '@/lib/jwt'
import { verifySignedToken } from '@/lib/jwt'
import { getApplication, getPostLogoutRedirectUris } from '@/services/applications'
import { getRequestContext, recordAudit } from '@/services/audit'
import { clearSsoCookie, readSsoSession, revokeSsoSession } from '@/services/sso'
import { revokeSession } from '@/services/tokens'

const app = new Hono<AppEnv>()

const logoutSchema = v.object({
  /** The id_token the client received. Expired ones are accepted — see `verifySignedToken`. */
  id_token_hint: v.optional(v.string()),
  client_id: v.optional(v.string()),
  post_logout_redirect_uri: v.optional(v.string()),
  state: v.optional(v.string()),
})

/**
 * OpenID Connect RP-initiated logout (the `end_session_endpoint`).
 *
 * The session named by `id_token_hint` is revoked, which kills its refresh chain and stops its
 * access tokens from being accepted on the next request. `post_logout_redirect_uri` is matched
 * exactly against the list registered for the client, for the same reason `redirect_uri` is: an
 * unvalidated one is an open redirect, and this endpoint is reachable without any credential.
 *
 * The browser's own SSO session goes too, when the request carries its cookie: that is what stops
 * the next application from being authorized without a sign-in, and it is the difference between
 * signing out of one application and signing out of this server. It still does not sign the user out
 * of Google — that session is Google's, and ending it is not ours to do.
 */
const handleLogout = async (c: Context<AppEnv>, params: v.InferOutput<typeof logoutSchema>) => {
  const db = getDb(c.env)
  const context = getRequestContext(c)

  let claims: IdTokenClaims | null = null
  if (params.id_token_hint) {
    try {
      claims = await verifySignedToken<IdTokenClaims>(c.env, params.id_token_hint, { allowExpired: true })
    } catch {
      // A hint that does not verify is treated as absent: the user still gets signed out of
      // whatever this endpoint can identify, and told nothing about why the hint was rejected.
      claims = null
    }
  }

  const clientId = claims?.aud ?? params.client_id ?? null
  const application = clientId ? await getApplication(db, clientId) : null

  if (claims?.sid) {
    const [session] = await db.select().from(sessions).where(eq(sessions.id, claims.sid)).limit(1)
    if (session && !session.revokedAt) {
      await revokeSession(db, session.id, 'rp_initiated_logout')
      await recordAudit(db, {
        event: 'session.revoked',
        userId: session.userId,
        applicationId: session.applicationId,
        ...context,
        metadata: { session_id: session.id, reason: 'rp_initiated_logout' },
      })
    }
  }

  // The cookie only reaches this endpoint on a navigation; a cross-origin `fetch` from a front-end
  // sends none, and then there is simply nothing of this browser's to close here.
  const sso = await readSsoSession(c, db)
  if (sso) {
    await revokeSsoSession(db, sso.session.id, 'rp_initiated_logout')
    await recordAudit(db, {
      event: 'sso_session.revoked',
      userId: sso.user.id,
      applicationId: application?.id ?? null,
      ...context,
      metadata: { sso_session_id: sso.session.id, reason: 'rp_initiated_logout' },
    })
  }
  // Cleared even when no session was found, so a cookie naming an expired or already revoked one
  // stops being sent back.
  clearSsoCookie(c)

  if (!params.post_logout_redirect_uri) {
    return c.json({ code: 200, data: { message: 'Signed out.' } })
  }

  if (!application || !getPostLogoutRedirectUris(application).includes(params.post_logout_redirect_uri)) {
    throw new RedirectValidationException('post_logout_redirect_uri is not registered for this client')
  }

  const target = new URL(params.post_logout_redirect_uri)
  if (params.state) {
    target.searchParams.set('state', params.state)
  }
  return c.redirect(target.toString(), 302)
}

const description =
  'RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0). Revokes the session identified by `id_token_hint` — an expired hint is accepted, since the token usually has expired by the time a user signs out — and, when the browser navigates here with its cookie, the SSO session too, so the next application asks for a sign-in again. Optionally redirects to a `post_logout_redirect_uri` registered for the client. It does not sign the user out of the upstream provider they authenticated with.'

app.get(
  '/oauth/logout',
  describeRoute({
    description,
    tags: ['OAuth'],
    responses: {
      200: { description: 'The session was revoked and no redirect was requested' },
      302: { description: 'Redirect to the registered post-logout URI' },
      400: { description: 'post_logout_redirect_uri is not registered for this client' },
    },
  }),
  validator('query', logoutSchema),
  (c) => handleLogout(c, c.req.valid('query')),
)

app.post(
  '/oauth/logout',
  describeRoute({
    description,
    tags: ['OAuth'],
    responses: {
      200: { description: 'The session was revoked and no redirect was requested' },
      302: { description: 'Redirect to the registered post-logout URI' },
      400: { description: 'post_logout_redirect_uri is not registered for this client' },
    },
  }),
  validator('form', logoutSchema),
  (c) => handleLogout(c, c.req.valid('form')),
)

export default app
