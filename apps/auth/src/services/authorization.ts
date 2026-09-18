import type { Context } from 'hono'
import type { Database } from '@/db/client'
import { oauthStates } from '@/db/schema'
import type { AppEnv, Env } from '@/env'
import { TTL } from '@/lib/config'
import type { ProviderName } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { createPkcePair } from '@/lib/pkce'
import { buildAuthorizationUrl } from '@/providers/google'
import { issueAuthorizationCode } from '@/services/tokens'
import { getRequestLocation, recordAudit } from '@/services/audit'
import { notifyAccountAccess } from '@/services/notifications'
import { startSsoSession, touchSsoSession } from '@/services/sso'
import type { SsoSession } from '@/services/sso'
import { assertUserActive, resolveUserForProfile } from '@/services/users'
import type { User } from '@/services/users'
import type { AuthorizationRequest, ProviderProfile } from '@/providers/types'

/** Where the browser goes next: the client's redirect URI, carrying the code and its own state. */
const codeRedirect = (request: AuthorizationRequest, code: string) => {
  const target = new URL(request.redirectUri)
  target.searchParams.set('code', code)
  if (request.state) {
    target.searchParams.set('state', request.state)
  }
  return target.toString()
}

/**
 * The tail end every provider funnels into, and the reason the provider layer is worth abstracting:
 * once a provider has proven who the user is, the remaining steps — resolve or create the account,
 * open the browser's SSO session, mint a single-use authorization code, and send the browser back to
 * the client — are identical.
 *
 * It takes the Hono context because opening the SSO session means setting a cookie, and that is
 * precisely the step no provider may be allowed to forget: a sign-in that does not leave one behind
 * is a sign-in the user will be asked to repeat for the next application.
 *
 * Returns the absolute URL the caller should redirect to.
 */
const completeAuthentication = async (
  c: Context<AppEnv>,
  db: Database,
  input: {
    request: AuthorizationRequest
    profile: ProviderProfile
    ip: string | null
    userAgent: string | null
  },
) => {
  const { request, profile } = input

  const { user, isNewUser } = await resolveUserForProfile(db, profile, request.application.id)

  const ssoSession = await startSsoSession(c, db, {
    user,
    provider: profile.provider,
    applicationId: request.application.id,
  })

  const code = await issueAuthorizationCode(db, {
    userId: user.id,
    applicationId: request.application.id,
    provider: profile.provider,
    redirectUri: request.redirectUri,
    nonce: request.nonce,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    scope: request.scope,
    authTime: ssoSession.authenticatedAt,
  })

  await recordAudit(db, {
    event: isNewUser ? 'user.created' : 'oauth.callback.succeeded',
    userId: user.id,
    applicationId: request.application.id,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { provider: profile.provider },
  })

  // The location is read off the session rather than the context again: it was stamped from this
  // very request a moment ago, and the notice has to describe the same access the user will later
  // see under `/me/sso-sessions`.
  await notifyAccountAccess(c.env, {
    event: 'sign_in',
    user,
    applicationName: request.application.name,
    provider: profile.provider,
    occurredAt: ssoSession.authenticatedAt,
    ip: input.ip,
    userAgent: input.userAgent,
    country: ssoSession.country,
    city: ssoSession.city,
  })

  return { redirectUrl: codeRedirect(request, code), user, isNewUser, ssoSession }
}

/**
 * The same tail, for a user who is already signed in: no provider is involved, the SSO session the
 * browser presented stands in for one.
 *
 * `authTime` comes off that session rather than from the clock, so authorizing a fifth application
 * a week after signing in reports the sign-in a week ago. That is what makes `max_age` and
 * `auth_time` mean anything at all — a relying party that cares how recently the user authenticated
 * gets the truth, and can ask for a fresh authentication with `prompt=login` if it is not enough.
 *
 * The caller is responsible for having proved that *this* browser holds the session: the cookie,
 * never the parked request's stamp on its own.
 *
 * It takes the Hono context for the same family of reasons `completeAuthentication` does: this is
 * the step that lets a new application into an account without anyone authenticating, so it is the
 * step that has to tell the account holder about it, and both the notice's location and the mail
 * binding come off the request.
 */
const authorizeFromSsoSession = async (
  c: Context<AppEnv>,
  db: Database,
  input: {
    request: AuthorizationRequest
    session: SsoSession
    user: User
    ip: string | null
    userAgent: string | null
  },
) => {
  const { request, session, user } = input
  assertUserActive(user)

  const code = await issueAuthorizationCode(db, {
    userId: user.id,
    applicationId: request.application.id,
    provider: session.provider as ProviderName,
    redirectUri: request.redirectUri,
    nonce: request.nonce,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    scope: request.scope,
    authTime: session.authenticatedAt,
  })

  await touchSsoSession(db, session.id)

  await recordAudit(db, {
    event: 'sso_session.reused',
    userId: user.id,
    applicationId: request.application.id,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { provider: session.provider, sso_session_id: session.id },
  })

  // `occurredAt` is now, not the session's `authenticated_at`: what the user is being told about is
  // the application being let in, which is happening as this runs. How long ago they authenticated
  // is a different fact, and the one the `auth_time` claim already carries.
  await notifyAccountAccess(c.env, {
    event: 'authorization',
    user,
    applicationName: request.application.name,
    provider: session.provider,
    occurredAt: new Date(),
    ip: input.ip,
    userAgent: input.userAgent,
    ...getRequestLocation(c),
  })

  return { redirectUrl: codeRedirect(request, code), user }
}

/**
 * The head end of the Google flow: stores the client's request alongside our own PKCE verifier and
 * nonce, and returns the URL the browser has to be sent to.
 *
 * Both entry points into Google — the standalone `/oauth/google/authorize` and the provider choice
 * made on a parked request at `/oauth/authorize` — go through this, so the two can never drift into
 * storing different things and resuming differently on the callback.
 */
const startGoogleFlow = async (
  db: Database,
  env: Env,
  input: {
    request: AuthorizationRequest
    loginHint: string | null
    ip: string | null
    userAgent: string | null
  },
) => {
  const { request } = input
  const state = randomToken(32)
  const providerPkce = await createPkcePair()
  const nonce = randomToken(16)

  await db.insert(oauthStates).values({
    id: generateId(),
    provider: 'google',
    stateHash: await sha256(state),
    applicationId: request.application.id,
    redirectUri: request.redirectUri,
    clientState: request.state,
    clientNonce: request.nonce,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    scope: request.scope,
    providerCodeVerifier: providerPkce.codeVerifier,
    nonce,
    expiresAt: new Date(Date.now() + TTL.oauthState * 1000),
    requestIp: input.ip,
    userAgent: input.userAgent,
  })

  await recordAudit(db, {
    event: 'oauth.authorize.started',
    applicationId: request.application.id,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { provider: 'google' },
  })

  return buildAuthorizationUrl(env, {
    state,
    codeChallenge: providerPkce.codeChallenge,
    nonce,
    loginHint: input.loginHint,
  })
}

export { authorizeFromSsoSession, codeRedirect, completeAuthentication, startGoogleFlow }
