import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { describe, expect, it } from 'vitest'
import { sessions, userRoles, users } from '@/db/schema'
import type { AppEnv } from '@/env'
import { getSigningKey, signAccessToken } from '@/lib/jwt'
import { requireAuth, requirePermission } from '@/middleware/auth'
import { createRole, createSessionRow, createUser, db, grant, SEED, signIn } from '../helpers/db'

/**
 * A minimal app carrying only the middleware under test, so a failure points at the middleware
 * rather than at whichever route happened to be behind it.
 */
const app = new Hono<AppEnv>()
app.get('/protected', requireAuth, (c) => {
  const actor = c.get('actor')
  return c.json({
    userId: actor.user.id,
    sessionId: actor.sessionId,
    applicationId: actor.applicationId,
    roles: actor.roles,
    permissions: actor.permissions,
    claimedRoles: actor.claims.roles,
  })
})
app.get('/gated', requireAuth, requirePermission('users:read'), (c) => c.text('allowed'))
app.get('/ungated', requirePermission('users:read'), (c) => c.text('allowed'))
app.onError((error, c) => {
  const status = 'status' in error ? (error as { status: number }).status : 500
  return c.json({ code: status, error: error.message }, status as 401)
})

const call = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }, env)

describe('requireAuth', () => {
  it('rejects a request with no Authorization header', async () => {
    const response = await call('/protected')

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ code: 401, error: 'A Bearer access token is required' })
  })

  it('rejects a scheme that is not Bearer', async () => {
    for (const header of ['Basic dXNlcjpwYXNz', 'Token abc', 'abc']) {
      const response = await call('/protected', { Authorization: header })
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({ error: 'A Bearer access token is required' })
    }
  })

  it('accepts the scheme case-insensitively, as RFC 7235 requires', async () => {
    const { token } = await signIn()

    expect((await call('/protected', { Authorization: `bearer ${token}` })).status).toBe(200)
    expect((await call('/protected', { Authorization: `BEARER ${token}` })).status).toBe(200)
  })

  it('rejects a Bearer header with no token after it', async () => {
    for (const header of ['Bearer', 'Bearer ', 'Bearer    ']) {
      expect((await call('/protected', { Authorization: header })).status).toBe(401)
    }
  })

  it('rejects a token that is not a JWT, and says the token was the problem', async () => {
    const response = await call('/protected', { Authorization: 'Bearer not-a-jwt' })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('Invalid access token:') })
  })

  it('rejects a well-formed token signed by somebody else', async () => {
    const { token } = await signIn()
    const [header, payload] = token.split('.')

    const response = await call('/protected', { Authorization: `Bearer ${header}.${payload}.AAAA` })
    expect(response.status).toBe(401)
  })

  it('rejects an expired token even though its signature is good', async () => {
    const user = await createUser()
    const session = await createSessionRow({ userId: user.id })
    const past = Math.floor(Date.now() / 1000) - 3600
    const token = await sign(
      {
        iss: env.AUTH_ISSUER,
        sub: user.id,
        aud: SEED.webAppId,
        sid: session.id,
        provider: 'magic_link',
        email: user.email,
        email_verified: true,
        name: null,
        picture: null,
        roles: [],
        permissions: [],
        iat: past,
        exp: past + 60,
        jti: crypto.randomUUID(),
      },
      getSigningKey(env),
      'EdDSA',
    )

    const response = await call('/protected', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('Invalid access token:') })
  })

  it('rejects a token whose account has been deleted', async () => {
    const { token, user } = await signIn()
    await db().delete(users).where(eq(users.id, user.id))

    const response = await call('/protected', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'The account behind this token no longer exists' })
  })

  it('rejects a token whose account has been disabled, with a 403 rather than a 401', async () => {
    const { token, user } = await signIn()
    await db().update(users).set({ status: 'disabled' }).where(eq(users.id, user.id))

    const response = await call('/protected', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'This account is disabled' })
  })

  it('rejects a token whose session has been revoked, so signing out is immediate', async () => {
    const { token, session } = await signIn()
    await db().update(sessions).set({ revokedAt: new Date(), revokedReason: 'logout' }).where(eq(sessions.id, session.id))

    const response = await call('/protected', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'This session has been revoked' })
  })

  it('rejects a token pointing at a session that never existed', async () => {
    const user = await createUser()
    const { token } = await signAccessToken(env, {
      sub: user.id,
      aud: SEED.webAppId,
      sid: crypto.randomUUID(),
      provider: 'magic_link',
      email: user.email,
      email_verified: true,
      name: null,
      picture: null,
      roles: [],
      permissions: [],
    })

    expect((await call('/protected', { Authorization: `Bearer ${token}` })).status).toBe(401)
  })

  it('puts the user, session and application on the context on the happy path', async () => {
    const { token, user, session } = await signIn({ applicationId: SEED.cmsAppId })

    const response = await call('/protected', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      userId: user.id,
      sessionId: session.id,
      applicationId: SEED.cmsAppId,
    })
  })

  it('reads roles from the database, not from the token body', async () => {
    const role = await createRole({ slug: 'live-role', permissions: ['users:read'] })
    const { token, user } = await signIn({ roleIds: [role.id], claimedRoles: ['admin'], claimedPermissions: ['users:write'] })

    const before = await call('/protected', { Authorization: `Bearer ${token}` })
    await expect(before.json()).resolves.toMatchObject({
      roles: ['live-role'],
      permissions: ['users:read'],
      // The token still claims otherwise; the middleware simply does not use it.
      claimedRoles: ['admin'],
    })

    await db().delete(userRoles).where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, role.id)))

    const after = await call('/protected', { Authorization: `Bearer ${token}` })
    await expect(after.json()).resolves.toMatchObject({ roles: [], permissions: [] })
  })

  it('picks up a role granted after the token was minted', async () => {
    const { token, user } = await signIn()
    await expect((await call('/protected', { Authorization: `Bearer ${token}` })).json()).resolves.toMatchObject({
      roles: [],
    })

    await grant(user.id, SEED.adminRoleId)

    await expect((await call('/protected', { Authorization: `Bearer ${token}` })).json()).resolves.toMatchObject({
      roles: ['admin'],
    })
  })

  it('resolves authorization for the audience of the token, not for every application', async () => {
    const user = await createUser()
    const scoped = await createRole({ slug: 'cms-scoped', applicationId: SEED.cmsAppId, permissions: ['users:read'] })
    await grant(user.id, scoped.id)

    const web = await signIn({ user, applicationId: SEED.webAppId })
    const cms = await signIn({ user, applicationId: SEED.cmsAppId })

    await expect((await call('/protected', { Authorization: `Bearer ${web.token}` })).json()).resolves.toMatchObject({
      roles: [],
    })
    await expect((await call('/protected', { Authorization: `Bearer ${cms.token}` })).json()).resolves.toMatchObject({
      roles: ['cms-scoped'],
    })
  })
})

describe('requirePermission', () => {
  it('allows a caller who holds the permission', async () => {
    const role = await createRole({ slug: 'reader', permissions: ['users:read'] })
    const { token } = await signIn({ roleIds: [role.id] })

    const response = await call('/gated', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('allowed')
  })

  it('denies a caller who is authenticated but unprivileged, naming the permission', async () => {
    const { token } = await signIn({ roleIds: [SEED.userRoleId] })

    const response = await call('/gated', { Authorization: `Bearer ${token}` })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: users:read' })
  })

  it('is not satisfied by a permission the token claims but the database does not grant', async () => {
    const { token } = await signIn({ claimedPermissions: ['users:read'], claimedRoles: ['admin'] })

    expect((await call('/gated', { Authorization: `Bearer ${token}` })).status).toBe(403)
  })

  it('checks permissions rather than role names, so a redefined role takes effect at once', async () => {
    const role = await createRole({ slug: 'editor-role' })
    const { token } = await signIn({ roleIds: [role.id] })

    expect((await call('/gated', { Authorization: `Bearer ${token}` })).status).toBe(403)

    const promoted = await createRole({ slug: 'editor-role-2', permissions: ['users:read'] })
    const [{ userId }] = await db().select().from(userRoles).where(eq(userRoles.roleId, role.id))
    await grant(userId, promoted.id)

    expect((await call('/gated', { Authorization: `Bearer ${token}` })).status).toBe(200)
  })

  it('denies when no actor was ever set, instead of throwing', async () => {
    const response = await call('/ungated')

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'Missing required permission: users:read' })
  })
})
