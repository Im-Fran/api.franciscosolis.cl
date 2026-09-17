import { SELF, env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { auditLogs, authorizationRequests, ssoSessions } from '@/db/schema'
import { SSO_COOKIE_NAME } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import type { IdTokenClaims } from '@/lib/jwt'
import { verifySignedToken } from '@/lib/jwt'
import { cookieHeader, cookieValue } from '../helpers/context'
import { bearer, createSsoSession, createUser, db, SEED, signIn, uniqueEmail } from '../helpers/db'
import { captureEmails, magicLinkTokenFrom } from '../helpers/email'
import { RFC7636 } from '../helpers/pkce'

const mailbox = captureEmails()
afterEach(() => {
  mailbox.sent.length = 0
})
afterAll(() => mailbox.restore())

const navigate = (path: string, init: { headers?: Record<string, string> } = {}) =>
  SELF.fetch(`https://auth.internal${path}`, { redirect: 'manual', headers: init.headers })

const authorize = (params: Record<string, string> = {}, cookie?: string) =>
  navigate(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: SEED.webAppId,
      redirect_uri: SEED.webRedirectUri,
      code_challenge: RFC7636.challenge,
      ...params,
    })}`,
    { headers: cookie ? cookieHeader(SSO_COOKIE_NAME, cookie) : undefined },
  )

const location = (response: Response) => new URL(response.headers.get('Location') as string)

/** Starts a request and hands back the parked handle out of the sign-in redirect. */
const park = async (params: Record<string, string> = {}, cookie?: string) => {
  const response = await authorize(params, cookie)
  const handle = location(response).searchParams.get('request')
  if (!handle) {
    throw new Error(`the authorize response carries no handle: ${response.status} ${response.headers.get('Location')}`)
  }
  return handle
}

const describeRequest = async (handle: string) => {
  const response = await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}`)
  return (await response.json<{ data: { authenticated: null | Record<string, string> } }>()).data
}

/** A real magic link sign-in, end to end, returning the cookie the callback handed the browser. */
const signInThroughMagicLink = async (email: string) => {
  const handle = await park()
  await SELF.fetch(`https://auth.internal/oauth/authorize/${handle}/magic-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const token = magicLinkTokenFrom(mailbox.last())
  const callback = await navigate(`/magic-link/callback?token=${encodeURIComponent(token)}`)

  return { callback, cookie: cookieValue(callback, SSO_COOKIE_NAME) as string }
}

describe('signing in', () => {
  it('leaves the browser holding an SSO session it can authorize with', async () => {
    const user = await createUser({ email: uniqueEmail('sso-flow') })
    const { callback, cookie } = await signInThroughMagicLink(user.email)

    expect(callback.status).toBe(302)
    expect(location(callback).searchParams.get('code')).toBeTruthy()
    expect(cookie).toBeTruthy()

    const [session] = await db().select().from(ssoSessions).where(eq(ssoSessions.tokenHash, await sha256(cookie)))
    expect(session).toMatchObject({ userId: user.id, provider: 'magic_link', revokedAt: null })
  })

  it('records the sign-in as an event of its own', async () => {
    const user = await createUser({ email: uniqueEmail('sso-audit') })
    await signInThroughMagicLink(user.email)

    const [row] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.event, 'sso_session.started'), eq(auditLogs.userId, user.id)))
      .limit(1)

    expect(row).toBeTruthy()
  })
})

describe('a second application', () => {
  it('is offered as an authorization rather than a sign-in', async () => {
    const user = await createUser({ email: uniqueEmail('sso-second'), name: 'Ada' })
    const { session, token } = await createSsoSession({ userId: user.id })

    const handle = await park({}, token)
    const parked = await describeRequest(handle)

    const [row] = await db()
      .select()
      .from(authorizationRequests)
      .where(eq(authorizationRequests.handleHash, await sha256(handle)))

    expect(row?.ssoSessionId).toBe(session.id)
    expect(parked.authenticated).toMatchObject({ sub: user.id, email: user.email, name: 'Ada' })
    expect(parked.authenticated?.continue_url).toBe(
      `${env.AUTH_PUBLIC_URL}/oauth/authorize/${handle}/continue`,
    )
  })

  it('reports nobody when the browser carries no session', async () => {
    const parked = await describeRequest(await park())

    expect(parked.authenticated).toBeNull()
  })

  it('goes back to the client with a code when the browser presses Authorize', async () => {
    const user = await createUser({ email: uniqueEmail('sso-continue') })
    const { token } = await createSsoSession({ userId: user.id })
    const handle = await park({ state: 'client-state' }, token)

    const response = await navigate(
      `/oauth/authorize/${handle}/continue`,
      { headers: cookieHeader(SSO_COOKIE_NAME, token) },
    )
    const target = location(response)

    expect(response.status).toBe(302)
    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(target.searchParams.get('state')).toBe('client-state')
  })

  it('sends the browser to sign in when it holds no session, rather than minting anything', async () => {
    const user = await createUser({ email: uniqueEmail('sso-nocookie') })
    const { token } = await createSsoSession({ userId: user.id })
    const handle = await park({}, token)

    const response = await navigate(`/oauth/authorize/${handle}/continue`)
    const target = location(response)

    expect(target.origin + target.pathname).toBe('https://franciscosolis.cl/apps/auth')
    expect(target.searchParams.get('request')).toBe(handle)
  })

  it('refuses a handle presented by a browser other than the one that parked it', async () => {
    const owner = await createUser({ email: uniqueEmail('sso-owner') })
    const stranger = await createUser({ email: uniqueEmail('sso-stranger') })
    const parked = await createSsoSession({ userId: owner.id })
    const other = await createSsoSession({ userId: stranger.id })
    const handle = await park({}, parked.token)

    const response = await navigate(
      `/oauth/authorize/${handle}/continue`,
      { headers: cookieHeader(SSO_COOKIE_NAME, other.token) },
    )

    expect(location(response).origin + location(response).pathname).toBe('https://franciscosolis.cl/apps/auth')
  })

  it('records the reuse without pretending anybody authenticated', async () => {
    const user = await createUser({ email: uniqueEmail('sso-reuse-audit') })
    const { session, token } = await createSsoSession({ userId: user.id })
    const handle = await park({}, token)

    await navigate(`/oauth/authorize/${handle}/continue`, { headers: cookieHeader(SSO_COOKIE_NAME, token) })

    const [row] = await db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.event, 'sso_session.reused'), eq(auditLogs.userId, user.id)))
      .limit(1)

    expect(row?.userId).toBe(user.id)
    expect(JSON.parse(row?.metadata ?? 'null')).toMatchObject({ sso_session_id: session.id })
  })
})

describe('prompt and max_age', () => {
  it('answers prompt=none with a code for a browser that is already signed in', async () => {
    const user = await createUser({ email: uniqueEmail('sso-none') })
    const { token } = await createSsoSession({ userId: user.id })

    const response = await authorize({ prompt: 'none', state: 'quiet' }, token)
    const target = location(response)

    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('code')).toBeTruthy()
    expect(target.searchParams.get('state')).toBe('quiet')
  })

  it('still answers login_required when there is no session to satisfy it', async () => {
    const target = location(await authorize({ prompt: 'none' }))

    expect(target.searchParams.get('error')).toBe('login_required')
  })

  it('refuses prompt=none combined with another value, which has no reading', async () => {
    const target = location(await authorize({ prompt: 'none login' }))

    expect(target.searchParams.get('error')).toBe('invalid_request')
  })

  it('refuses a prompt value it does not implement', async () => {
    const target = location(await authorize({ prompt: 'create' }))

    expect(target.searchParams.get('error')).toBe('invalid_request')
  })

  it('ignores the session for prompt=login and prompt=select_account', async () => {
    const user = await createUser({ email: uniqueEmail('sso-prompt-login') })
    const { token } = await createSsoSession({ userId: user.id })

    for (const prompt of ['login', 'select_account']) {
      const parked = await describeRequest(await park({ prompt }, token))
      expect(parked.authenticated).toBeNull()
    }
  })

  it('ignores a session older than max_age, and keeps one inside it', async () => {
    const user = await createUser({ email: uniqueEmail('sso-max-age') })
    const hourOld = new Date(Math.floor((Date.now() - 60 * 60 * 1000) / 1000) * 1000)
    const { token } = await createSsoSession({ userId: user.id, authenticatedAt: hourOld })

    const stale = await describeRequest(await park({ max_age: '60' }, token))
    const fresh = await describeRequest(await park({ max_age: '7200' }, token))

    expect(stale.authenticated).toBeNull()
    expect(fresh.authenticated).not.toBeNull()
    expect(location(await authorize({ prompt: 'none', max_age: '60' }, token)).searchParams.get('error')).toBe(
      'login_required',
    )
  })

  it('refuses a max_age that is not a number of seconds', async () => {
    expect(location(await authorize({ max_age: 'soon' })).searchParams.get('error')).toBe('invalid_request')
  })
})

describe('the id_token of an authorization that skipped the sign-in', () => {
  it('reports when the user actually authenticated, not when the code was minted', async () => {
    const user = await createUser({ email: uniqueEmail('sso-auth-time') })
    const dayOld = new Date(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000) * 1000)
    const { token } = await createSsoSession({ userId: user.id, authenticatedAt: dayOld })

    const handle = await park({ scope: 'openid' }, token)
    const response = await navigate(
      `/oauth/authorize/${handle}/continue`,
      { headers: cookieHeader(SSO_COOKIE_NAME, token) },
    )
    const code = location(response).searchParams.get('code') as string

    const tokens = await SELF.fetch('https://auth.internal/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: SEED.webAppId,
        code,
        redirect_uri: SEED.webRedirectUri,
        code_verifier: RFC7636.verifier,
      }).toString(),
    })
    const body = await tokens.json<{ id_token: string }>()
    const claims = await verifySignedToken<IdTokenClaims>(env, body.id_token)

    expect(claims.auth_time).toBe(Math.floor(dayOld.getTime() / 1000))
  })
})

describe('signing out', () => {
  it('ends the browser session and clears the cookie, so the next request has to sign in', async () => {
    const user = await createUser({ email: uniqueEmail('sso-logout') })
    const { session, token } = await createSsoSession({ userId: user.id })

    const response = await navigate('/oauth/logout', { headers: cookieHeader(SSO_COOKIE_NAME, token) })

    const [row] = await db().select().from(ssoSessions).where(eq(ssoSessions.id, session.id))
    expect(row?.revokedAt).not.toBeNull()
    expect(row?.revokedReason).toBe('rp_initiated_logout')
    expect(response.headers.getSetCookie().some((line) => line.startsWith(`${SSO_COOKIE_NAME}=`))).toBe(true)

    expect((await describeRequest(await park({}, token))).authenticated).toBeNull()
    expect(location(await authorize({ prompt: 'none' }, token)).searchParams.get('error')).toBe('login_required')
  })
})

describe('a disabled account', () => {
  it('cannot authorize from the session it was holding', async () => {
    const user = await createUser({ email: uniqueEmail('sso-disabled-flow'), status: 'disabled' })
    const { token } = await createSsoSession({ userId: user.id })

    expect((await describeRequest(await park({}, token))).authenticated).toBeNull()
    expect(location(await authorize({ prompt: 'none' }, token)).searchParams.get('error')).toBe('login_required')
  })
})

describe('GET /me/sso-sessions', () => {
  it('lists the browsers the user is signed in from, and closes one on request', async () => {
    const user = await createUser({ email: uniqueEmail('sso-me') })
    const { token } = await signIn({ user })
    const kept = await createSsoSession({ userId: user.id })
    const doomed = await createSsoSession({ userId: user.id, provider: 'google' })

    const listed = await SELF.fetch('https://auth.internal/me/sso-sessions', { headers: bearer(token) })
    const before = await listed.json<{ data: { id: string; provider: string }[] }>()

    expect(before.data.map((row) => row.id).sort()).toEqual([kept.session.id, doomed.session.id].sort())

    const deleted = await SELF.fetch(`https://auth.internal/me/sso-sessions/${doomed.session.id}`, {
      method: 'DELETE',
      headers: bearer(token),
    })
    expect(deleted.status).toBe(204)

    const after = await SELF.fetch('https://auth.internal/me/sso-sessions', { headers: bearer(token) })
    expect((await after.json<{ data: { id: string }[] }>()).data.map((row) => row.id)).toEqual([kept.session.id])

    // The closed browser can no longer stand in for a sign-in, and the one kept still can.
    expect((await describeRequest(await park({}, doomed.token))).authenticated).toBeNull()
    expect((await describeRequest(await park({}, kept.token))).authenticated).not.toBeNull()
  })

  it('refuses to close somebody else\'s SSO session', async () => {
    const owner = await createUser({ email: uniqueEmail('sso-me-owner') })
    const other = await createUser({ email: uniqueEmail('sso-me-other') })
    const { token } = await signIn({ user: other })
    const { session } = await createSsoSession({ userId: owner.id })

    const response = await SELF.fetch(`https://auth.internal/me/sso-sessions/${session.id}`, {
      method: 'DELETE',
      headers: bearer(token),
    })

    expect(response.status).toBe(404)
  })
})
