import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ssoSessions } from '@/db/schema'
import { SSO_COOKIE_NAME, TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import {
  cookiePath,
  getSsoSessionById,
  listUserSsoSessions,
  readSsoSession,
  resolveSsoSession,
  revokeSsoSession,
  revokeUserSsoSessions,
  startSsoSession,
  toPublicSsoSession,
  touchSsoSession,
} from '@/services/sso'
import { cookieHeader, cookieValue, testContext } from '../helpers/context'
import { createSsoSession, createUser, db, SEED, uniqueEmail } from '../helpers/db'

/** Truncated to whole seconds, which is all D1 stores: a fixture has to survive the round trip. */
const minutesAgo = (minutes: number) =>
  new Date(Math.floor((Date.now() - minutes * 60 * 1000) / 1000) * 1000)

describe('cookiePath', () => {
  it('scopes the cookie to the subtree this Worker is served under', () => {
    expect(cookiePath({ AUTH_PUBLIC_URL: 'https://api.franciscosolis.cl/auth' })).toBe('/auth')
    expect(cookiePath({ AUTH_PUBLIC_URL: 'https://api.franciscosolis.cl/auth/' })).toBe('/auth')
  })

  it('falls back to the root for a public URL that is a bare origin, or not a URL at all', () => {
    expect(cookiePath({ AUTH_PUBLIC_URL: 'https://auth.internal' })).toBe('/')
    expect(cookiePath({ AUTH_PUBLIC_URL: 'nonsense' })).toBe('/')
  })
})

describe('startSsoSession', () => {
  it('sets an HttpOnly, Secure, Lax cookie holding a value that is never stored', async () => {
    const user = await createUser({ email: uniqueEmail('sso-start') })
    const c = await testContext()

    const session = await startSsoSession(c, db(), { user, provider: 'magic_link', applicationId: SEED.webAppId })
    const token = cookieValue(c, SSO_COOKIE_NAME)
    const header = c.res.headers.getSetCookie()[0] ?? ''

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    expect(session.tokenHash).toBe(await sha256(token as string))
    expect(session.tokenHash).not.toBe(token)
  })

  it('dates the session from the authentication and expires it absolutely', async () => {
    const user = await createUser({ email: uniqueEmail('sso-life') })
    const session = await startSsoSession(await testContext(), db(), {
      user,
      provider: 'google',
      applicationId: SEED.webAppId,
    })

    const lifetime = session.expiresAt.getTime() - session.authenticatedAt.getTime()
    expect(lifetime).toBeCloseTo(TTL.ssoSession * 1000, -3)
    expect(session.provider).toBe('google')
  })

  it('revokes the session the browser already held rather than leaving two alive', async () => {
    const user = await createUser({ email: uniqueEmail('sso-rotate') })
    const { session: previous, token } = await createSsoSession({ userId: user.id })

    const c = await testContext({ headers: cookieHeader(SSO_COOKIE_NAME, token) })
    const next = await startSsoSession(c, db(), { user, provider: 'magic_link', applicationId: SEED.webAppId })

    const [stale] = await db().select().from(ssoSessions).where(eq(ssoSessions.id, previous.id))
    expect(stale?.revokedAt).not.toBeNull()
    expect(stale?.revokedReason).toBe('reauthenticated')
    expect(await resolveSsoSession(db(), token)).toBeNull()
    expect(next.id).not.toBe(previous.id)
  })
})

describe('resolveSsoSession', () => {
  it('resolves a live session to the account behind it', async () => {
    const user = await createUser({ email: uniqueEmail('sso-live') })
    const { token } = await createSsoSession({ userId: user.id })

    const resolved = await resolveSsoSession(db(), token)

    expect(resolved?.user.id).toBe(user.id)
  })

  it('refuses an unknown, expired or revoked session, and a disabled account, all the same way', async () => {
    const user = await createUser({ email: uniqueEmail('sso-refused') })
    const expired = await createSsoSession({ userId: user.id, expiresAt: minutesAgo(1) })
    const revoked = await createSsoSession({ userId: user.id, revokedAt: minutesAgo(1) })
    const disabled = await createUser({ email: uniqueEmail('sso-disabled'), status: 'disabled' })
    const disabledSession = await createSsoSession({ userId: disabled.id })

    expect(await resolveSsoSession(db(), 'never-issued')).toBeNull()
    expect(await resolveSsoSession(db(), expired.token)).toBeNull()
    expect(await resolveSsoSession(db(), revoked.token)).toBeNull()
    expect(await resolveSsoSession(db(), disabledSession.token)).toBeNull()
  })

  it('reads the cookie off the request, and answers null when there is none', async () => {
    const user = await createUser({ email: uniqueEmail('sso-cookie') })
    const { token } = await createSsoSession({ userId: user.id })

    const withCookie = await readSsoSession(await testContext({ headers: cookieHeader(SSO_COOKIE_NAME, token) }), db())
    const without = await readSsoSession(await testContext(), db())

    expect(withCookie?.user.id).toBe(user.id)
    expect(without).toBeNull()
  })
})

describe('getSsoSessionById', () => {
  it('answers only for a session that is still live', async () => {
    const user = await createUser({ email: uniqueEmail('sso-by-id') })
    const live = await createSsoSession({ userId: user.id })
    const dead = await createSsoSession({ userId: user.id, revokedAt: minutesAgo(1) })

    expect((await getSsoSessionById(db(), live.session.id))?.user.id).toBe(user.id)
    expect(await getSsoSessionById(db(), dead.session.id)).toBeNull()
    expect(await getSsoSessionById(db(), 'no-such-session')).toBeNull()
  })
})

describe('touchSsoSession', () => {
  it('moves last_seen_at and leaves the authentication where it was', async () => {
    const user = await createUser({ email: uniqueEmail('sso-touch') })
    const { session } = await createSsoSession({ userId: user.id, authenticatedAt: minutesAgo(90) })

    await touchSsoSession(db(), session.id)
    const [row] = await db().select().from(ssoSessions).where(eq(ssoSessions.id, session.id))

    expect(row?.authenticatedAt.getTime()).toBe(session.authenticatedAt.getTime())
    expect(row?.lastSeenAt.getTime()).toBeGreaterThan(session.authenticatedAt.getTime())
    expect(row?.expiresAt.getTime()).toBe(session.expiresAt.getTime())
  })
})

describe('revoking', () => {
  it('closes one session, and every session an account holds', async () => {
    const user = await createUser({ email: uniqueEmail('sso-revoke') })
    const first = await createSsoSession({ userId: user.id })
    const second = await createSsoSession({ userId: user.id })
    const third = await createSsoSession({ userId: user.id })

    await revokeSsoSession(db(), first.session.id, 'user_revocation')
    expect(await listUserSsoSessions(db(), user.id)).toHaveLength(2)

    await revokeUserSsoSessions(db(), user.id, 'user_disabled')
    expect(await listUserSsoSessions(db(), user.id)).toHaveLength(0)
    expect(await resolveSsoSession(db(), second.token)).toBeNull()
    expect(await resolveSsoSession(db(), third.token)).toBeNull()
  })
})

describe('toPublicSsoSession', () => {
  it('publishes the session without the hash that would let it be replayed', async () => {
    const user = await createUser({ email: uniqueEmail('sso-public') })
    const { session } = await createSsoSession({ userId: user.id })

    const published = toPublicSsoSession(session, session.id)

    expect(published.current).toBe(true)
    expect(Object.keys(published).sort()).toEqual([
      'authenticated_at',
      'city',
      'country',
      'created_at',
      'current',
      'expires_at',
      'id',
      'ip',
      'last_seen_at',
      'provider',
      'user_agent',
    ])
    expect(JSON.stringify(published)).not.toContain(session.tokenHash)
  })
})

describe('the cookie name', () => {
  it('is the one the Worker publishes, so a front-end never has to guess it', () => {
    expect(SSO_COOKIE_NAME).toBe('__Secure-auth-session')
    expect(env.AUTH_PUBLIC_URL).toBeTruthy()
  })
})
