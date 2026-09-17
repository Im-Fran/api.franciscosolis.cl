import { SELF } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, sessions, userRoles, users } from '@/db/schema'
import { createIdentity, createRole, createSessionRow, createUser, db, grant, SEED, signIn } from '../helpers/db'

const call = (path: string, token?: string, init: RequestInit = {}) =>
  SELF.fetch(`https://auth.internal${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  })

describe('GET /me', () => {
  it('returns the profile with the roles and permissions held right now', async () => {
    const role = await createRole({ slug: 'me-reader', permissions: ['users:read'] })
    const { token, user, session } = await signIn({ roleIds: [role.id], claimedRoles: ['admin'] })

    const response = await call('/me', token)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 200,
      data: {
        user: {
          id: user.id,
          email: user.email,
          email_verified: true,
          name: null,
          given_name: null,
          family_name: null,
          picture: null,
          locale: null,
          status: 'active',
          last_login_at: null,
          created_at: user.createdAt.toISOString(),
          updated_at: user.updatedAt.toISOString(),
        },
        application_id: SEED.webAppId,
        session_id: session.id,
        // Read from the database, not from the `admin` the token claims.
        roles: ['me-reader'],
        permissions: ['users:read'],
      },
    })
  })

  it('needs a token', async () => {
    const response = await call('/me')

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ code: 401, error: 'A Bearer access token is required' })
  })

  it('reflects a role revoked after the token was issued', async () => {
    const role = await createRole({ slug: 'me-temp', permissions: ['audit:read'] })
    const { token, user } = await signIn({ roleIds: [role.id] })

    await expect((await call('/me', token)).json()).resolves.toMatchObject({
      data: { roles: ['me-temp'], permissions: ['audit:read'] },
    })

    await db().delete(userRoles).where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, role.id)))

    await expect((await call('/me', token)).json()).resolves.toMatchObject({ data: { roles: [], permissions: [] } })
  })
})

describe('PATCH /me', () => {
  it('updates the fields the user owns and persists them', async () => {
    const { token, user } = await signIn()

    const response = await call('/me', token, {
      method: 'PATCH',
      body: JSON.stringify({ name: '  Ada Lovelace  ', locale: 'en-GB' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { user: { name: 'Ada Lovelace', locale: 'en-GB' } },
    })

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row).toMatchObject({ name: 'Ada Lovelace', locale: 'en-GB' })
  })

  it('leaves an omitted field alone and clears one sent as null', async () => {
    const user = await createUser({ name: 'Original', locale: 'es' })
    const { token } = await signIn({ user })

    await call('/me', token, { method: 'PATCH', body: JSON.stringify({ locale: null }) })

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.name).toBe('Original')
    expect(row?.locale).toBeNull()
  })

  it('updates the given and family names, and clears them on an explicit null', async () => {
    const user = await createUser({ givenName: 'Given', familyName: 'Family', picture: 'https://p.test/old.png' })
    const { token } = await signIn({ user })

    await call('/me', token, {
      method: 'PATCH',
      body: JSON.stringify({ given_name: 'Ada', family_name: 'Lovelace' }),
    })
    let [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row).toMatchObject({ givenName: 'Ada', familyName: 'Lovelace', picture: 'https://p.test/old.png' })

    await call('/me', token, {
      method: 'PATCH',
      body: JSON.stringify({ given_name: null, family_name: null }),
    })
    ;[row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row).toMatchObject({ givenName: null, familyName: null })
  })

  it('refuses to set the picture, which only a reviewed upload may write', async () => {
    const user = await createUser({ picture: 'https://p.test/old.png' })
    const { token } = await signIn({ user })

    const response = await call('/me', token, {
      method: 'PATCH',
      body: JSON.stringify({ picture: 'https://evil.test/anything.png' }),
    })

    expect(response.status).toBe(400)
    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.picture).toBe('https://p.test/old.png')
  })

  it('refuses to change the email address, which is the identity key', async () => {
    const { token, user } = await signIn()

    await call('/me', token, { method: 'PATCH', body: JSON.stringify({ email: 'new@example.test' }) })

    const [row] = await db().select().from(users).where(eq(users.id, user.id))
    expect(row?.email).toBe(user.email)
  })

  it('rejects a picture that is not a URL and a name that is too long', async () => {
    const { token } = await signIn()

    expect((await call('/me', token, { method: 'PATCH', body: JSON.stringify({ picture: 'not-a-url' }) })).status).toBe(400)
    expect((await call('/me', token, { method: 'PATCH', body: JSON.stringify({ name: 'a'.repeat(121) }) })).status).toBe(400)
  })

  it('records which fields were touched', async () => {
    const { token, user } = await signIn()

    await call('/me', token, { method: 'PATCH', body: JSON.stringify({ name: 'Ada', given_name: 'Ada' }) })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, user.id))
    const updated = rows.find((row) => row.event === 'user.updated')
    expect(JSON.parse(updated?.metadata ?? 'null')).toEqual({ fields: ['name', 'given_name'] })
  })

  it('needs a token', async () => {
    expect((await call('/me', undefined, { method: 'PATCH', body: '{}' })).status).toBe(401)
  })
})

describe('GET /me/identities', () => {
  it('lists the providers linked to the account, and only those', async () => {
    const { token, user } = await signIn()
    const other = await createUser()
    await createIdentity({ userId: user.id, provider: 'google', providerAccountId: 'sub-me', email: user.email })
    await createIdentity({ userId: other.id, provider: 'google', providerAccountId: 'sub-other' })

    const response = await call('/me/identities', token)
    const body = await response.json<{ data: { provider: string; email: string | null }[] }>()

    expect(response.status).toBe(200)
    expect(body.data).toEqual([
      { id: expect.any(String), provider: 'google', email: user.email, last_used_at: expect.any(String), created_at: expect.any(String) },
    ])
  })

  it('answers an empty list for an account with no linked identity', async () => {
    const { token } = await signIn()

    await expect((await call('/me/identities', token)).json()).resolves.toEqual({ code: 200, data: [] })
  })

  it('reports a never-used identity with a null timestamp rather than omitting it', async () => {
    const { token, user } = await signIn()
    await createIdentity({ userId: user.id, provider: 'magic_link', providerAccountId: user.email, lastUsedAt: null })

    const body = await (await call('/me/identities', token)).json<{ data: { last_used_at: string | null }[] }>()

    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.last_used_at).toBeNull()
  })

  it('needs a token', async () => {
    expect((await call('/me/identities')).status).toBe(401)
  })
})

describe('GET /me/sessions', () => {
  it('lists the live sessions and flags the current one', async () => {
    const { token, user, session } = await signIn()
    const another = await createSessionRow({ userId: user.id, applicationId: SEED.cmsAppId, provider: 'google' })

    const body = await (await call('/me/sessions', token)).json<{ data: { id: string; current: boolean }[] }>()

    expect(body.data.map((row) => row.id).sort()).toEqual([session.id, another.id].sort())
    expect(body.data.find((row) => row.id === session.id)?.current).toBe(true)
    expect(body.data.find((row) => row.id === another.id)?.current).toBe(false)
  })

  it('orders the sessions by last activity, most recent first', async () => {
    const { token, user, session } = await signIn()
    const stale = await createSessionRow({ userId: user.id, lastSeenAt: new Date('2026-01-01T00:00:00.000Z') })
    const recent = await createSessionRow({ userId: user.id, lastSeenAt: new Date('2026-03-01T00:00:00.000Z') })
    await db()
      .update(sessions)
      .set({ lastSeenAt: new Date('2026-02-01T00:00:00.000Z') })
      .where(eq(sessions.id, session.id))

    const body = await (await call('/me/sessions', token)).json<{ data: { id: string }[] }>()

    // Compared in order, deliberately unsorted: the ordering is what this endpoint documents.
    expect(body.data.map((row) => row.id)).toEqual([recent.id, session.id, stale.id])
  })

  it('hides revoked sessions and other users\' sessions', async () => {
    const { token, user, session } = await signIn()
    await createSessionRow({ userId: user.id, revokedAt: new Date() })
    const stranger = await createUser()
    await createSessionRow({ userId: stranger.id })

    const body = await (await call('/me/sessions', token)).json<{ data: { id: string }[] }>()

    expect(body.data.map((row) => row.id)).toEqual([session.id])
  })

  it('needs a token', async () => {
    expect((await call('/me/sessions')).status).toBe(401)
  })
})

describe('DELETE /me/sessions/:id', () => {
  it('revokes one of the caller\'s own sessions', async () => {
    const { token, user } = await signIn()
    const other = await createSessionRow({ userId: user.id })

    const response = await call(`/me/sessions/${other.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(204)
    const [row] = await db().select().from(sessions).where(eq(sessions.id, other.id))
    expect(row?.revokedReason).toBe('user_revocation')
  })

  it('revoking the current session is the same as signing out', async () => {
    const { token, session } = await signIn()

    expect((await call(`/me/sessions/${session.id}`, token, { method: 'DELETE' })).status).toBe(204)
    expect((await call('/me', token)).status).toBe(401)
  })

  it('refuses to touch somebody else\'s session, and does not reveal that it exists', async () => {
    const { token } = await signIn()
    const stranger = await createUser()
    const strangerSession = await createSessionRow({ userId: stranger.id })

    const response = await call(`/me/sessions/${strangerSession.id}`, token, { method: 'DELETE' })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ code: 404, error: 'Session not found' })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, strangerSession.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('answers 404 for a session id that does not exist', async () => {
    const { token } = await signIn()

    expect((await call(`/me/sessions/${crypto.randomUUID()}`, token, { method: 'DELETE' })).status).toBe(404)
  })

  it('needs a token', async () => {
    expect((await call('/me/sessions/anything', undefined, { method: 'DELETE' })).status).toBe(401)
  })
})

describe('POST /me/sessions/prune', () => {
  const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36'
  const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'

  /** Signs in and gives the current session a location, which `createSessionRow` leaves empty. */
  const signInFrom = async (where: { ip?: string; country?: string; userAgent?: string } = {}) => {
    const actor = await signIn()
    await db()
      .update(sessions)
      .set({
        ip: where.ip ?? '200.1.2.3',
        country: where.country ?? 'CL',
        city: 'Santiago',
        userAgent: where.userAgent ?? CHROME_MAC,
      })
      .where(eq(sessions.id, actor.session.id))
    return actor
  }

  const prune = (token: string, body: Record<string, unknown>) =>
    call('/me/sessions/prune', token, { method: 'POST', body: JSON.stringify(body) })

  it('closes the sessions matching a rule and leaves the rest alone', async () => {
    const { token, user, session } = await signInFrom()
    const abroad = await createSessionRow({ userId: user.id, country: 'DE', ip: '45.9.9.9' })
    const home = await createSessionRow({ userId: user.id, country: 'CL', ip: '200.1.2.77' })

    const response = await prune(token, { rules: { other_countries: true } })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { dry_run: false, match: 'any', matched: 1, revoked: 1, sessions: [{ id: abroad.id, country: 'DE' }] },
    })

    const rows = await db().select().from(sessions).where(eq(sessions.userId, user.id))
    expect(rows.find((row) => row.id === abroad.id)?.revokedReason).toBe('user_prune')
    expect(rows.find((row) => row.id === home.id)?.revokedAt).toBeNull()
    expect(rows.find((row) => row.id === session.id)?.revokedAt).toBeNull()
  })

  it('never closes the current session, even when every rule points at it', async () => {
    const { token, session } = await signInFrom()
    await db().update(sessions).set({ lastSeenAt: new Date(Date.now() - 400 * 86_400_000) })
      .where(eq(sessions.id, session.id))

    const response = await prune(token, { rules: { inactive_for_days: 1, older_than_days: 1 } })

    await expect(response.json()).resolves.toMatchObject({ data: { matched: 0, revoked: 0 } })
    expect((await call('/me', token)).status).toBe(200)
  })

  it('reports what it would close without touching anything on a dry run', async () => {
    const { token, user } = await signInFrom()
    const phone = await createSessionRow({ userId: user.id, userAgent: SAFARI_IOS })

    const response = await prune(token, { rules: { other_devices: true }, dry_run: true })

    await expect(response.json()).resolves.toMatchObject({
      data: { dry_run: true, matched: 1, revoked: 0, sessions: [{ id: phone.id }] },
    })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, phone.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('combines rules with `all` as well as with `any`', async () => {
    const { token, user } = await signInFrom()
    const stale = new Date(Date.now() - 90 * 86_400_000)
    const oldAbroad = await createSessionRow({ userId: user.id, country: 'DE', lastSeenAt: stale })
    const oldHere = await createSessionRow({ userId: user.id, country: 'CL', lastSeenAt: stale })

    const rules = { inactive_for_days: 30, other_countries: true }

    await expect((await prune(token, { rules, match: 'all', dry_run: true })).json()).resolves.toMatchObject({
      data: { matched: 1, sessions: [{ id: oldAbroad.id }] },
    })

    const anyRun = await (await prune(token, { rules, dry_run: true })).json<{ data: { sessions: { id: string }[] } }>()
    expect(anyRun.data.sessions.map((row) => row.id).sort()).toEqual([oldAbroad.id, oldHere.id].sort())
  })

  it('narrows to an application or a provider when asked to', async () => {
    const { token, user } = await signInFrom()
    const web = await createSessionRow({ userId: user.id, applicationId: SEED.webAppId, country: 'DE' })
    const cms = await createSessionRow({ userId: user.id, applicationId: SEED.cmsAppId, country: 'DE' })

    const response = await prune(token, {
      rules: { other_countries: true },
      scope: { applications: [SEED.cmsAppId] },
    })

    await expect(response.json()).resolves.toMatchObject({ data: { matched: 1, sessions: [{ id: cms.id }] } })
    const [row] = await db().select().from(sessions).where(eq(sessions.id, web.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('leaves a session the rule cannot judge alone', async () => {
    const { token, user } = await signInFrom()
    // Written before the location columns existed: no country, no address, no user agent.
    const placeless = await createSessionRow({ userId: user.id })

    await prune(token, { rules: { other_countries: true, other_networks: true, other_devices: true } })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, placeless.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('refuses a run that selected no rule rather than closing everything', async () => {
    const { token, user } = await signInFrom()
    const other = await createSessionRow({ userId: user.id, country: 'DE' })

    const response = await prune(token, { rules: {} })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ code: 400, error: 'Select at least one rule to prune by' })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, other.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('refuses a day count outside the range a person would pick', async () => {
    const { token } = await signInFrom()

    expect((await prune(token, { rules: { inactive_for_days: 0 } })).status).toBe(400)
    expect((await prune(token, { rules: { older_than_days: 4000 } })).status).toBe(400)
  })

  it('records session.pruned once for the run, not once per session', async () => {
    const { token, user } = await signInFrom()
    await createSessionRow({ userId: user.id, country: 'DE' })
    await createSessionRow({ userId: user.id, country: 'AR' })

    await prune(token, { rules: { other_countries: true } })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, user.id))
    const pruned = rows.filter((row) => row.event === 'session.pruned')
    expect(pruned).toHaveLength(1)
    expect(JSON.parse(pruned[0]?.metadata ?? 'null')).toMatchObject({ match: 'any', revoked: 2 })
  })

  it('records nothing when the run closed nothing', async () => {
    const { token, user } = await signInFrom()

    await prune(token, { rules: { other_countries: true } })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, user.id))
    expect(rows.filter((row) => row.event === 'session.pruned')).toHaveLength(0)
  })

  it('needs a token', async () => {
    const response = await call('/me/sessions/prune', undefined, {
      method: 'POST',
      body: JSON.stringify({ rules: { other_countries: true } }),
    })

    expect(response.status).toBe(401)
  })
})

describe('POST /logout', () => {
  it('revokes the current session and stops the token working immediately', async () => {
    const { token, session } = await signIn()

    const response = await call('/logout', token, { method: 'POST' })

    expect(response.status).toBe(204)
    await expect(response.text()).resolves.toBe('')

    const [row] = await db().select().from(sessions).where(eq(sessions.id, session.id))
    expect(row?.revokedReason).toBe('logout')

    // The access token itself cannot be un-issued, but it is refused from here on.
    expect((await call('/me', token)).status).toBe(401)
  })

  it('leaves the caller\'s other sessions alone', async () => {
    const { token, user } = await signIn()
    const other = await createSessionRow({ userId: user.id })

    await call('/logout', token, { method: 'POST' })

    const [row] = await db().select().from(sessions).where(eq(sessions.id, other.id))
    expect(row?.revokedAt).toBeNull()
  })

  it('records session.revoked with the logout reason', async () => {
    const { token, user, session } = await signIn()

    await call('/logout', token, { method: 'POST' })

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.userId, user.id))
    const revoked = rows.find((row) => row.event === 'session.revoked')
    expect(JSON.parse(revoked?.metadata ?? 'null')).toEqual({ session_id: session.id, reason: 'logout' })
  })

  it('needs a token', async () => {
    expect((await call('/logout', undefined, { method: 'POST' })).status).toBe(401)
  })

  it('cannot be replayed once the session is gone', async () => {
    const { token } = await signIn()
    await call('/logout', token, { method: 'POST' })

    expect((await call('/logout', token, { method: 'POST' })).status).toBe(401)
  })
})

describe('disabled accounts', () => {
  it('are refused on every /me route with a 403', async () => {
    const { token, user } = await signIn()
    await db().update(users).set({ status: 'disabled' }).where(eq(users.id, user.id))

    for (const path of ['/me', '/me/identities', '/me/sessions']) {
      const response = await call(path, token)
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: 'This account is disabled' })
    }
  })
})

describe('permissions on /me', () => {
  it('needs no permission at all, only a live session', async () => {
    const { token } = await signIn()

    const response = await call('/me', token)

    expect(response.status).toBe(200)
    // A caller holding nothing still gets their profile; only the admin API is permission-gated.
    await expect(response.json()).resolves.toMatchObject({ data: { roles: [], permissions: [] } })
  })

  it('reports the roles of the caller, never of another user who happens to be an admin', async () => {
    const plain = await signIn()
    const elevated = await signIn()
    await grant(elevated.user.id, SEED.adminRoleId)

    await expect((await call('/me', plain.token)).json()).resolves.toMatchObject({
      data: { user: { id: plain.user.id }, roles: [] },
    })
    await expect((await call('/me', elevated.token)).json()).resolves.toMatchObject({
      data: { user: { id: elevated.user.id }, roles: ['admin'] },
    })
  })
})
