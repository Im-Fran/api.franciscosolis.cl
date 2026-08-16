import type { Database } from '@/db/client'
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

export { completeAuthentication }
