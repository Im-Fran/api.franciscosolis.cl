import { and, eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { applications } from '@/db/schema'
import { CODE_CHALLENGE_METHOD } from '@/lib/config'
import { sha256, timingSafeEqual } from '@/lib/crypto'
import { OAuthException, RedirectValidationException } from '@/lib/errors'

type Application = typeof applications.$inferSelect

/** Scopes this Worker understands. Anything else is rejected rather than silently dropped. */
const SUPPORTED_SCOPES = ['openid', 'profile', 'email'] as const
const DEFAULT_SCOPE = SUPPORTED_SCOPES.join(' ')

const getApplication = async (db: Database, clientId: string): Promise<Application | null> => {
  const [application] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, clientId), eq(applications.isActive, true)))
    .limit(1)
  return application ?? null
}

const getRedirectUris = (application: Application): string[] => {
  try {
    const parsed = JSON.parse(application.redirectUris)
    return Array.isArray(parsed) ? parsed.filter((uri): uri is string => typeof uri === 'string') : []
  } catch {
    return []
  }
}

/**
 * Resolves the client and its redirect URI together, because until BOTH are known good there is
 * nowhere safe to send an error: redirecting to an unverified URI is an open redirect, and it is
 * also how an attacker would exfiltrate an authorization code. Failures here are rendered to the
 * user instead.
 */
const resolveClient = async (db: Database, clientId: string, redirectUri: string) => {
  const application = await getApplication(db, clientId)
  if (!application) {
    throw new RedirectValidationException('Unknown or inactive client_id')
  }

  // Exact string match, per OAuth 2.0 Security BCP: no prefix or wildcard matching, which would
  // let an open redirect or a path traversal on the client's own domain capture the code.
  if (!getRedirectUris(application).includes(redirectUri)) {
    throw new RedirectValidationException('redirect_uri is not registered for this client')
  }

  return { application, redirectUri }
}

/**
 * Validates the PKCE parameters of an authorization request. Mandatory for every client, including
 * confidential ones: the challenge is what ties the code returned in the redirect to the process
 * that asked for it.
 */
const validatePkceParameters = (codeChallenge: string, codeChallengeMethod: string | undefined) => {
  const method = codeChallengeMethod ?? CODE_CHALLENGE_METHOD
  if (method !== CODE_CHALLENGE_METHOD) {
    throw new OAuthException(400, 'invalid_request', `code_challenge_method must be ${CODE_CHALLENGE_METHOD}`)
  }
  // A base64url-encoded SHA-256 digest is always 43 characters with padding stripped.
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    throw new OAuthException(400, 'invalid_request', 'code_challenge must be a base64url-encoded SHA-256 digest')
  }
  return { codeChallenge, codeChallengeMethod: method }
}

const normalizeScope = (scope: string | undefined | null): string => {
  if (!scope) {
    return DEFAULT_SCOPE
  }
  const requested = scope.split(/\s+/).filter(Boolean)
  const unsupported = requested.filter((entry) => !SUPPORTED_SCOPES.includes(entry as (typeof SUPPORTED_SCOPES)[number]))
  if (unsupported.length > 0) {
    throw new OAuthException(400, 'invalid_scope', `Unsupported scope: ${unsupported.join(', ')}`)
  }
  return requested.join(' ')
}

/**
 * Authenticates the client at the token endpoint. Public clients (no stored secret) authenticate
 * with PKCE alone; confidential clients must additionally present their secret.
 */
const authenticateClient = async (application: Application, clientSecret: string | undefined) => {
  if (!application.clientSecretHash) {
    if (clientSecret) {
      throw new OAuthException(401, 'invalid_client', 'This client is public and must not send a client_secret')
    }
    return
  }

  if (!clientSecret) {
    throw new OAuthException(401, 'invalid_client', 'client_secret is required for this client')
  }
  if (!timingSafeEqual(await sha256(clientSecret), application.clientSecretHash)) {
    throw new OAuthException(401, 'invalid_client', 'Invalid client credentials')
  }
}

export {
  authenticateClient,
  DEFAULT_SCOPE,
  getApplication,
  getRedirectUris,
  normalizeScope,
  resolveClient,
  SUPPORTED_SCOPES,
  validatePkceParameters,
}
export type { Application }
