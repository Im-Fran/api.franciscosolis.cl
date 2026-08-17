import type { Database } from '@/db/client'
import { oauthStates } from '@/db/schema'
import type { Env } from '@/env'
import { TTL } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { createPkcePair } from '@/lib/pkce'
import { buildAuthorizationUrl } from '@/providers/google'
import { issueAuthorizationCode } from '@/services/tokens'
import { recordAudit } from '@/services/audit'
import { resolveUserForProfile } from '@/services/users'
import type { AuthorizationRequest, ProviderProfile } from '@/providers/types'

/**
 * The tail end every provider funnels into, and the reason the provider layer is worth abstracting:
 * once a provider has proven who the user is, the remaining steps — resolve or create the account,
 * mint a single-use authorization code, and send the browser back to the client — are identical.
 *
 * Returns the absolute URL the caller should redirect to.
 */
const completeAuthentication = async (
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

  const code = await issueAuthorizationCode(db, {
    userId: user.id,
    applicationId: request.application.id,
    provider: profile.provider,
    redirectUri: request.redirectUri,
    nonce: request.nonce,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    scope: request.scope,
  })

  await recordAudit(db, {
    event: isNewUser ? 'user.created' : 'oauth.callback.succeeded',
    userId: user.id,
    applicationId: request.application.id,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { provider: profile.provider },
  })

  const target = new URL(request.redirectUri)
  target.searchParams.set('code', code)
  if (request.state) {
    target.searchParams.set('state', request.state)
  }

  return { redirectUrl: target.toString(), user, isNewUser }
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

export { completeAuthentication, startGoogleFlow }
