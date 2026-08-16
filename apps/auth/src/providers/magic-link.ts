import { and, count, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { magicLinkTokens } from '@/db/schema'
import type { Env } from '@/env'
import { MAGIC_LINK_RATE_LIMIT, TTL } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { OAuthException } from '@/lib/errors'
import { magicLinkTemplate, sendEmail } from '@/services/email'
import { findPendingInvitation } from '@/services/invitations'
import { findUserByEmail, normalizeEmail } from '@/services/users'
import type { AuthorizationRequest, ProviderDescriptor, ProviderProfile } from '@/providers/types'

const magicLinkProvider: ProviderDescriptor = {
  name: 'magic_link',
  displayName: 'Magic Link',
  initiation: 'email',
  startPath: '/magic-link',
  // The Email Sending binding is always present in wrangler.jsonc, so this provider needs no
  // secret and is available in every environment.
  isConfigured: () => true,
}

/** Counts requests for an address inside the rate-limit window. */
const countRecentRequests = async (db: Database, email: string) => {
  const since = new Date(Date.now() - MAGIC_LINK_RATE_LIMIT.windowSeconds * 1000)
  const [row] = await db
    .select({ total: count() })
    .from(magicLinkTokens)
    .where(and(eq(magicLinkTokens.email, email), gt(magicLinkTokens.createdAt, since)))
  return row?.total ?? 0
}

/**
 * Decides whether an address is allowed to receive a link. Sign-up is invitation-only, so an
 * address that matches no user and no pending invitation gets nothing — but the caller still
 * answers 202, so this never becomes an account-enumeration oracle.
 */
const canReceiveMagicLink = async (db: Database, email: string, applicationId: string) => {
  const user = await findUserByEmail(db, email)
  if (user) {
    return { allowed: user.status === 'active', userId: user.id, reason: user.status === 'active' ? null : 'disabled' }
  }
  const invitation = await findPendingInvitation(db, email, applicationId)
  return { allowed: invitation !== null, userId: null, reason: invitation ? null : 'not_invited' }
}

type RequestMagicLinkInput = {
  email: string
  request: AuthorizationRequest
  ip: string | null
  userAgent: string | null
}

type RequestMagicLinkResult =
  | { sent: true }
  | { sent: false; reason: 'rate_limited' | 'not_allowed' }

/**
 * Records a pending magic link and emails it.
 *
 * The whole authorization request is persisted next to the token, so the emailed URL only carries an
 * opaque value: a mail client that rewrites, prefetches or truncates the link cannot change which
 * application the user ends up signed in to, nor where they are redirected.
 */
const requestMagicLink = async (
  db: Database,
  env: Env,
  input: RequestMagicLinkInput,
): Promise<RequestMagicLinkResult> => {
  const email = normalizeEmail(input.email)

  if ((await countRecentRequests(db, email)) >= MAGIC_LINK_RATE_LIMIT.max) {
    return { sent: false, reason: 'rate_limited' }
  }

  const eligibility = await canReceiveMagicLink(db, email, input.request.application.id)
  if (!eligibility.allowed) {
    return { sent: false, reason: 'not_allowed' }
  }

  const token = randomToken(32)
  await db.insert(magicLinkTokens).values({
    id: generateId(),
    email,
    userId: eligibility.userId,
    applicationId: input.request.application.id,
    tokenHash: await sha256(token),
    redirectUri: input.request.redirectUri,
    state: input.request.state,
    codeChallenge: input.request.codeChallenge,
    codeChallengeMethod: input.request.codeChallengeMethod,
    scope: input.request.scope,
    expiresAt: new Date(Date.now() + TTL.magicLink * 1000),
    requestIp: input.ip,
    userAgent: input.userAgent,
  })

  const url = new URL(`${env.AUTH_PUBLIC_URL}/magic-link/callback`)
  url.searchParams.set('token', token)

  await sendEmail(
    env,
    email,
    magicLinkTemplate({
      url: url.toString(),
      applicationName: input.request.application.name,
      expiresInMinutes: Math.round(TTL.magicLink / 60),
    }),
  )

  return { sent: true }
}

/**
 * Consumes a magic link token and returns both the profile it proves and the authorization request
 * it was created for. Consumption is guarded on `consumed_at IS NULL`, so the link works exactly
 * once even if a mail scanner opens it first and the user clicks a second later.
 */
const consumeMagicLinkToken = async (db: Database, token: string) => {
  const tokenHash = await sha256(token)
  const [record] = await db.select().from(magicLinkTokens).where(eq(magicLinkTokens.tokenHash, tokenHash)).limit(1)

  if (!record) {
    throw new OAuthException(400, 'invalid_grant', 'This sign-in link is not valid')
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new OAuthException(400, 'invalid_grant', 'This sign-in link has expired')
  }

  const consumed = await db
    .update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(magicLinkTokens.id, record.id), isNull(magicLinkTokens.consumedAt)))
    .returning({ id: magicLinkTokens.id })

  if (consumed.length === 0) {
    throw new OAuthException(400, 'invalid_grant', 'This sign-in link has already been used')
  }

  const profile: ProviderProfile = {
    provider: 'magic_link',
    providerAccountId: record.email,
    email: record.email,
    // Receiving the link at that address is the proof of ownership.
    emailVerified: true,
    raw: { requested_at: record.createdAt.toISOString() },
  }

  return { record, profile }
}

export { canReceiveMagicLink, consumeMagicLinkToken, magicLinkProvider, requestMagicLink }
