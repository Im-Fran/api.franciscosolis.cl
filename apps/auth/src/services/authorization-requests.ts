import { eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { authorizationRequests } from '@/db/schema'
import { TTL } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { RedirectValidationException } from '@/lib/errors'
import type { AuthorizationRequest } from '@/providers/types'
import { getApplication } from '@/services/applications'
import type { Application } from '@/services/applications'

type AuthorizationRequestRecord = typeof authorizationRequests.$inferSelect

type CreateInput = {
  application: Application
  redirectUri: string
  state: string | null
  nonce: string | null
  codeChallenge: string | null
  codeChallengeMethod: string | null
  scope: string
  prompt: string | null
  loginHint: string | null
  ip: string | null
  userAgent: string | null
}

/**
 * Parks a validated authorization request and returns the opaque handle that names it.
 *
 * Everything the relying party asked for is frozen here, at the one moment it was validated, so the
 * provider the user eventually picks cannot be talked into a different redirect URI, scope or PKCE
 * challenge than the one the request was approved with. Only the hash of the handle is stored, like
 * every other value in this Worker that travels through a browser.
 */
const createAuthorizationRequest = async (db: Database, input: CreateInput) => {
  const handle = randomToken(32)
  const record: AuthorizationRequestRecord = {
    id: generateId(),
    handleHash: await sha256(handle),
    applicationId: input.application.id,
    redirectUri: input.redirectUri,
    state: input.state,
    nonce: input.nonce,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    prompt: input.prompt,
    loginHint: input.loginHint,
    expiresAt: new Date(Date.now() + TTL.authorizationRequest * 1000),
    requestIp: input.ip,
    userAgent: input.userAgent,
    createdAt: new Date(),
  }
  await db.insert(authorizationRequests).values(record)
  return { handle, record }
}

/**
 * Resolves a handle back into the request and the client it belongs to.
 *
 * Failures here are `RedirectValidationException`, not OAuth redirects: an expired or unknown handle
 * says nothing about where the user should be sent, and guessing would be an open redirect. The
 * client is re-read rather than trusted from the row, so deactivating an application stops sign-ins
 * that were already in flight.
 */
const loadAuthorizationRequest = async (db: Database, handle: string) => {
  const [record] = await db
    .select()
    .from(authorizationRequests)
    .where(eq(authorizationRequests.handleHash, await sha256(handle)))
    .limit(1)

  if (!record) {
    throw new RedirectValidationException('Unknown sign-in request; please start again')
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new RedirectValidationException('This sign-in request expired; please start again')
  }

  const application = await getApplication(db, record.applicationId)
  if (!application) {
    throw new RedirectValidationException('The application this sign-in was started for is no longer available')
  }

  return { record, application }
}

/** The shape the provider layer consumes, rebuilt from a parked row. */
const toAuthorizationRequest = (
  record: AuthorizationRequestRecord,
  application: Application,
): AuthorizationRequest => ({
  application,
  redirectUri: record.redirectUri,
  state: record.state,
  nonce: record.nonce,
  codeChallenge: record.codeChallenge,
  codeChallengeMethod: record.codeChallengeMethod,
  scope: record.scope ?? '',
})

export { createAuthorizationRequest, loadAuthorizationRequest, toAuthorizationRequest }
export type { AuthorizationRequestRecord }
