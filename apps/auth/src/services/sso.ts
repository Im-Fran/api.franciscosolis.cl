import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Database } from '@/db/client'
import { ssoSessions } from '@/db/schema'
import type { AppEnv, Env } from '@/env'
import type { ProviderName } from '@/lib/config'
import { SSO_COOKIE_NAME, TTL } from '@/lib/config'
import { generateId, randomToken, sha256 } from '@/lib/crypto'
import { getRequestContext, getRequestLocation, recordAudit } from '@/services/audit'
import { findUserById } from '@/services/users'
import type { User } from '@/services/users'

type SsoSession = typeof ssoSessions.$inferSelect

/** A live SSO session together with the account behind it. */
type ResolvedSsoSession = {
  session: SsoSession
  user: User
}

/**
 * Where the cookie is scoped.
 *
 * This Worker is served under a path of the gateway's hostname (`https://api.franciscosolis.cl/auth`),
 * and `AUTH_PUBLIC_URL` is the only thing that knows which one — the incoming URL is internal behind
 * the service binding. Scoping the cookie to that subtree keeps it off every other module the
 * gateway fronts, which have no business seeing it. A value that does not parse falls back to `/`
 * rather than to a guess: a cookie on the wrong path is simply never sent back.
 */
const cookiePath = (env: Pick<Env, 'AUTH_PUBLIC_URL'>) => {
  try {
    const { pathname } = new URL(env.AUTH_PUBLIC_URL)
    const trimmed = pathname.replace(/\/+$/, '')
    return trimmed || '/'
  } catch {
    return '/'
  }
}

/**
 * `SameSite=Lax` is the whole point rather than a compromise: every request that has to carry this
 * cookie is a top-level navigation (`/oauth/authorize`, the provider callbacks, `…/continue`), and
 * `Lax` sends it on exactly those while keeping it off the cross-site `fetch`es and form posts a
 * hostile page could make. Nothing here reads it from a cross-origin `fetch`, which is also why
 * CORS on this Worker still never allows credentials.
 */
const cookieOptions = (env: Pick<Env, 'AUTH_PUBLIC_URL'>) =>
  ({
    path: cookiePath(env),
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }) as const

const setSsoCookie = (c: Context<AppEnv>, token: string) => {
  setCookie(c, SSO_COOKIE_NAME, token, { ...cookieOptions(c.env), maxAge: TTL.ssoSession })
}

const clearSsoCookie = (c: Context<AppEnv>) => {
  deleteCookie(c, SSO_COOKIE_NAME, cookieOptions(c.env))
}

/** Whether a row is still usable at all, regardless of who presented it. */
const isLive = (session: SsoSession) => !session.revokedAt && session.expiresAt.getTime() > Date.now()

/**
 * Resolves a raw cookie value into the session and account it names.
 *
 * Every reason to say no collapses to `null`: an unknown, revoked or expired session and a disabled
 * or deleted account are all "this browser has to sign in again", and the caller's answer to each
 * of them is the same. Nothing about which one it was reaches the browser.
 */
const resolveSsoSession = async (db: Database, token: string): Promise<ResolvedSsoSession | null> => {
  const [session] = await db.select().from(ssoSessions).where(eq(ssoSessions.tokenHash, await sha256(token))).limit(1)
  if (!session || !isLive(session)) {
    return null
  }

  const user = await findUserById(db, session.userId)
  if (!user || user.status !== 'active') {
    return null
  }

  return { session, user }
}

/** The same, starting from the request's cookie. */
const readSsoSession = async (c: Context<AppEnv>, db: Database): Promise<ResolvedSsoSession | null> => {
  const token = getCookie(c, SSO_COOKIE_NAME)
  return token ? resolveSsoSession(db, token) : null
}

/** Reads one by id, for the parked request that stamped it. Same "no" for every reason, as above. */
const getSsoSessionById = async (db: Database, id: string): Promise<ResolvedSsoSession | null> => {
  const [session] = await db.select().from(ssoSessions).where(eq(ssoSessions.id, id)).limit(1)
  if (!session || !isLive(session)) {
    return null
  }

  const user = await findUserById(db, session.userId)
  if (!user || user.status !== 'active') {
    return null
  }

  return { session, user }
}

/** Records that the session was used. `authenticatedAt` is deliberately left alone — see the schema. */
const touchSsoSession = async (db: Database, id: string) => {
  await db.update(ssoSessions).set({ lastSeenAt: new Date() }).where(eq(ssoSessions.id, id))
}

const revokeSsoSession = async (db: Database, id: string, reason: string) => {
  await db
    .update(ssoSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(ssoSessions.id, id), isNull(ssoSessions.revokedAt)))
}

/**
 * Closes every SSO session an account holds. This is what stops a disabled account from still being
 * one "Authorize" click away from a token on the browser it last signed in from — `resolveSsoSession`
 * already refuses a disabled user, but a re-enabled account must not silently resurrect the sessions
 * it had before.
 */
const revokeUserSsoSessions = async (db: Database, userId: string, reason: string) => {
  await db
    .update(ssoSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(ssoSessions.userId, userId), isNull(ssoSessions.revokedAt)))
}

const listUserSsoSessions = async (db: Database, userId: string) =>
  db
    .select()
    .from(ssoSessions)
    .where(and(eq(ssoSessions.userId, userId), isNull(ssoSessions.revokedAt)))
    .orderBy(desc(ssoSessions.lastSeenAt))

/**
 * Opens the browser's session with this server, right after a provider proved who the user is, and
 * sets the cookie that names it.
 *
 * A session the browser already held is revoked rather than reused, even for the same account: this
 * runs only on a fresh authentication, so the cookie value is rotated for the same reason a refresh
 * token is, and a browser that signed in as somebody else must not keep the previous identity alive.
 */
const startSsoSession = async (
  c: Context<AppEnv>,
  db: Database,
  input: { user: User; provider: ProviderName; applicationId: string },
) => {
  const previous = await readSsoSession(c, db)
  if (previous) {
    await revokeSsoSession(db, previous.session.id, 'reauthenticated')
  }

  const token = randomToken(32)
  const now = new Date()
  const context = getRequestContext(c)
  const session: SsoSession = {
    id: generateId(),
    userId: input.user.id,
    tokenHash: await sha256(token),
    provider: input.provider,
    authenticatedAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + TTL.ssoSession * 1000),
    revokedAt: null,
    revokedReason: null,
    ...context,
    ...getRequestLocation(c),
    createdAt: now,
  }

  await db.insert(ssoSessions).values(session)
  setSsoCookie(c, token)

  await recordAudit(db, {
    event: 'sso_session.started',
    userId: input.user.id,
    applicationId: input.applicationId,
    ...context,
    metadata: { provider: input.provider, sso_session_id: session.id },
  })

  return session
}

/** Public shape of an SSO session, used by `/me/sso-sessions`. */
const toPublicSsoSession = (session: SsoSession, currentSessionId?: string) => ({
  id: session.id,
  provider: session.provider,
  ip: session.ip,
  user_agent: session.userAgent,
  country: session.country,
  city: session.city,
  current: session.id === currentSessionId,
  authenticated_at: session.authenticatedAt.toISOString(),
  last_seen_at: session.lastSeenAt.toISOString(),
  expires_at: session.expiresAt.toISOString(),
  created_at: session.createdAt.toISOString(),
})

export {
  clearSsoCookie,
  cookiePath,
  getSsoSessionById,
  listUserSsoSessions,
  readSsoSession,
  resolveSsoSession,
  revokeSsoSession,
  revokeUserSsoSessions,
  setSsoCookie,
  startSsoSession,
  toPublicSsoSession,
  touchSsoSession,
}
export type { ResolvedSsoSession, SsoSession }
