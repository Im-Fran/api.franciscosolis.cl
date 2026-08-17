import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { applications, auditLogs, identities, oauthStates } from '@/db/schema'
import { TTL } from '@/lib/config'
import { sha256 } from '@/lib/crypto'
import { deriveChallenge } from '@/lib/pkce'
import { consumeAuthorizationCode } from '@/services/tokens'
import { createApplication, createInvitation, createUser, db, SEED, uniqueEmail } from '../helpers/db'
import { withWorkerEnv } from '../helpers/env'
import { GOOGLE_CLIENT_ID, GOOGLE_JWKS_URI, GOOGLE_TOKEN_ENDPOINT, googleIdToken, googleJwks } from '../helpers/google'
import { restoreFetch, stubFetch } from '../helpers/http'
import { RFC7636 } from '../helpers/pkce'

afterEach(restoreFetch)

const authorize = (params: Record<string, string> = {}) =>
  SELF.fetch(
    `https://auth.internal/oauth/google/authorize?${new URLSearchParams({
      client_id: SEED.webAppId,
      redirect_uri: SEED.webRedirectUri,
      code_challenge: RFC7636.challenge,
      ...params,
    })}`,
    { redirect: 'manual' },
  )

const callback = (params: Record<string, string>) =>
  SELF.fetch(`https://auth.internal/oauth/google/callback?${new URLSearchParams(params)}`, { redirect: 'manual' })

/** Starts a real authorize leg and recovers the opaque state Google would echo back. */
const startFlow = async (params: Record<string, string> = {}) => {
  const response = await authorize(params)
  const target = new URL(response.headers.get('Location') as string)
  const state = target.searchParams.get('state') as string
  const [row] = await db().select().from(oauthStates).where(eq(oauthStates.stateHash, await sha256(state)))
  return { state, nonce: row?.nonce as string, row, target }
}

/** Serves both upstream Google endpoints for one sign-in. */
const stubGoogle = async (idToken: string) => {
  const jwks = await googleJwks()
  return stubFetch({
    [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ id_token: idToken, token_type: 'Bearer' }),
    [GOOGLE_JWKS_URI]: () => Response.json(jwks),
  })
}

describe('GET /oauth/google/authorize', () => {
  it('redirects to Google with our own PKCE pair, state and nonce', async () => {
    const response = await authorize({ state: 'client-state', login_hint: 'ada@example.test' })

    expect(response.status).toBe(302)
    const target = new URL(response.headers.get('Location') as string)
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(target.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID)
    expect(target.searchParams.get('redirect_uri')).toBe(`${env.AUTH_PUBLIC_URL}/oauth/google/callback`)
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
    expect(target.searchParams.get('login_hint')).toBe('ada@example.test')
    expect(target.searchParams.get('response_type')).toBe('code')
  })

  it('stores the client request server-side, keyed by the hash of the state', async () => {
    const { state, row, target } = await startFlow({ state: 'client-state', scope: 'openid email' })

    expect(row).toMatchObject({
      provider: 'google',
      applicationId: SEED.webAppId,
      redirectUri: SEED.webRedirectUri,
      clientState: 'client-state',
      codeChallenge: RFC7636.challenge,
      codeChallengeMethod: 'S256',
      scope: 'openid email',
      consumedAt: null,
    })
    // Only the hash is stored, and the challenge Google sees is ours, not the client's.
    expect(JSON.stringify(row)).not.toContain(state)
    expect(target.searchParams.get('code_challenge')).toBe(await deriveChallenge(row?.providerCodeVerifier as string))
    expect(target.searchParams.get('nonce')).toBe(row?.nonce)
  })

  it('gives the redirect a short lifetime and records the client fingerprint', async () => {
    const response = await SELF.fetch(
      `https://auth.internal/oauth/google/authorize?${new URLSearchParams({
        client_id: SEED.webAppId,
        redirect_uri: SEED.webRedirectUri,
        code_challenge: RFC7636.challenge,
      })}`,
      { redirect: 'manual', headers: { 'CF-Connecting-IP': '203.0.113.13', 'User-Agent': 'probe/7.0' } },
    )
    const state = new URL(response.headers.get('Location') as string).searchParams.get('state') as string
    const [row] = await db().select().from(oauthStates).where(eq(oauthStates.stateHash, await sha256(state)))

    expect(row).toMatchObject({ requestIp: '203.0.113.13', userAgent: 'probe/7.0' })
    const lifetime = ((row?.expiresAt.getTime() ?? 0) - Date.now()) / 1000
    expect(lifetime).toBeGreaterThan(TTL.oauthState - 30)
    expect(lifetime).toBeLessThanOrEqual(TTL.oauthState)
  })

  it('records oauth.authorize.started', async () => {
    await authorize()

    const rows = await db().select().from(auditLogs).where(eq(auditLogs.event, 'oauth.authorize.started'))
    expect(rows.map((row) => JSON.parse(row.metadata ?? 'null'))).toContainEqual({ provider: 'google' })
  })

  it('renders a 400 for an unknown client or an unregistered redirect URI, never a redirect', async () => {
    const unknown = await authorize({ client_id: 'ghost' })
    expect(unknown.status).toBe(400)
    await expect(unknown.json()).resolves.toEqual({ code: 400, error: 'Unknown or inactive client_id' })

    const unregistered = await authorize({ redirect_uri: 'https://evil.test/cb' })
    expect(unregistered.status).toBe(400)
    await expect(unregistered.json()).resolves.toMatchObject({
      error: 'redirect_uri is not registered for this client',
    })
  })

  it('reports a bad PKCE challenge back to the client, because the redirect URI is trusted by then', async () => {
    const response = await authorize({ code_challenge: 'nope', state: 'client-state' })

    expect(response.status).toBe(302)
    const target = new URL(response.headers.get('Location') as string)
    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('error')).toBe('invalid_request')
    expect(target.searchParams.get('state')).toBe('client-state')
  })

  it('reports an unsupported scope back to the client in the same way', async () => {
    const response = await authorize({ scope: 'openid drive.readonly' })
    const target = new URL(response.headers.get('Location') as string)

    expect(target.searchParams.get('error')).toBe('invalid_scope')
    expect(target.searchParams.get('error_description')).toBe('Unsupported scope: drive.readonly')
  })

  it('answers 503 when Google is not configured on this deployment', async () => {
    const response = await withWorkerEnv({ GOOGLE_CLIENT_SECRET: '' }, () => authorize())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Google sign-in is not configured',
    })
  })

  it('requires a client_id, a redirect_uri and a code_challenge', async () => {
    const response = await SELF.fetch('https://auth.internal/oauth/google/authorize', { redirect: 'manual' })

    expect(response.status).toBe(400)
  })
})

describe('GET /oauth/google/callback', () => {
  it('completes the sign-in and redirects with a code and the client state', async () => {
    const email = uniqueEmail('google-new')
    await createInvitation({ email })
    const { state, nonce } = await startFlow({ state: 'client-state' })
    await stubGoogle(await googleIdToken({ sub: 'sub-google-new', email, nonce, name: 'Ada' }))

    const response = await callback({ state, code: 'google-auth-code' })

    expect(response.status).toBe(302)
    // The Location header carries a single-use code, so no shared cache may keep this response.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const target = new URL(response.headers.get('Location') as string)
    expect(target.origin + target.pathname).toBe(SEED.webRedirectUri)
    expect(target.searchParams.get('state')).toBe('client-state')

    const code = target.searchParams.get('code') as string
    const record = await consumeAuthorizationCode(db(), code)
    expect(record).toMatchObject({ applicationId: SEED.webAppId, provider: 'google', codeChallenge: RFC7636.challenge })

    const [identity] = await db().select().from(identities).where(eq(identities.providerAccountId, 'sub-google-new'))
    expect(identity).toMatchObject({ provider: 'google', userId: record.userId, email })
  })

  it('sends Google the stored verifier, not one taken from the callback URL', async () => {
    const user = await createUser({ email: uniqueEmail('google-verifier') })
    const { state, nonce, row } = await startFlow()
    const { calls } = await stubGoogle(await googleIdToken({ sub: 'sub-verifier', email: user.email, nonce }))

    await callback({ state, code: 'google-auth-code', code_verifier: 'attacker-supplied' })

    const body = new URLSearchParams(calls.find((call) => call.url.startsWith(GOOGLE_TOKEN_ENDPOINT))?.body ?? '')
    expect(body.get('code_verifier')).toBe(row?.providerCodeVerifier)
    expect(body.get('code')).toBe('google-auth-code')
  })

  it('links Google to an account that already exists under the same address', async () => {
    const user = await createUser({ email: uniqueEmail('google-link') })
    const { state, nonce } = await startFlow()
    await stubGoogle(await googleIdToken({ sub: 'sub-link', email: user.email.toUpperCase(), nonce }))

    const response = await callback({ state, code: 'c' })
    const code = new URL(response.headers.get('Location') as string).searchParams.get('code') as string

    await expect(consumeAuthorizationCode(db(), code)).resolves.toMatchObject({ userId: user.id })
  })

  it('consumes the state, so the callback cannot be replayed', async () => {
    const user = await createUser({ email: uniqueEmail('google-replay') })
    const { state, nonce } = await startFlow()
    await stubGoogle(await googleIdToken({ sub: 'sub-replay', email: user.email, nonce }))

    expect((await callback({ state, code: 'c' })).status).toBe(302)

    const replay = await callback({ state, code: 'c' })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toEqual({
      code: 400,
      error: 'This sign-in attempt was already completed; please start again',
    })
  })

  it('refuses to complete when the client application was deactivated meanwhile', async () => {
    const application = await createApplication({ redirectUris: ['https://short-lived.test/cb'] })
    const { state } = await startFlow({ client_id: application.id, redirect_uri: 'https://short-lived.test/cb' })
    await db().update(applications).set({ isActive: false }).where(eq(applications.id, application.id))

    const response = await callback({ state, code: 'c' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      code: 400,
      error: 'The application this sign-in was started for is no longer available',
    })
  })

  it('refuses an unknown state', async () => {
    const response = await callback({ state: 'never-issued', code: 'c' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'Unknown sign-in state; please start again' })
  })

  it('refuses an expired state', async () => {
    const { state } = await startFlow()
    await db()
      .update(oauthStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthStates.stateHash, await sha256(state)))

    const response = await callback({ state, code: 'c' })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'This sign-in attempt expired; please start again',
    })
  })

  it('passes an error from Google back to the client as access_denied', async () => {
    const { state } = await startFlow({ state: 'client-state' })

    const response = await callback({ state, error: 'access_denied', error_description: 'The user said no' })

    expect(response.status).toBe(302)
    const target = new URL(response.headers.get('Location') as string)
    expect(target.searchParams.get('error')).toBe('access_denied')
    expect(target.searchParams.get('error_description')).toBe('The user said no')
    expect(target.searchParams.get('state')).toBe('client-state')
  })

  it('falls back to the bare error code when Google sends no description', async () => {
    const { state } = await startFlow()

    const response = await callback({ state, error: 'server_error' })

    expect(new URL(response.headers.get('Location') as string).searchParams.get('error_description')).toBe('server_error')
  })

  it('reports a callback with neither code nor error as invalid_request', async () => {
    const { state } = await startFlow()

    const response = await callback({ state })

    const target = new URL(response.headers.get('Location') as string)
    expect(target.searchParams.get('error')).toBe('invalid_request')
    expect(target.searchParams.get('error_description')).toBe('Google did not return an authorization code')
  })

  it('reports a rejected code exchange as server_error, without a stack trace', async () => {
    const { state } = await startFlow()
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () =>
        Response.json({ error: 'invalid_grant', error_description: 'Malformed auth code.' }, { status: 400 }),
    })

    const response = await callback({ state, code: 'stale' })

    const target = new URL(response.headers.get('Location') as string)
    expect(target.searchParams.get('error')).toBe('server_error')
    expect(target.searchParams.get('error_description')).toContain('Malformed auth code.')
  })

  it('surfaces a transport failure as a 500 instead of laundering it into an error redirect', async () => {
    const { state } = await startFlow({ state: 'client-state' })
    // Only the JWKS route is declared, so the call to Google's token endpoint rejects with a
    // transport error rather than an OAuthException — the branch that re-raises instead of
    // redirecting. An infrastructure outage must not reach the client dressed as `server_error`.
    const jwks = await googleJwks()
    stubFetch({ [GOOGLE_JWKS_URI]: () => Response.json(jwks) })

    const response = await callback({ state, code: 'c' })
    const body = await response.json<Record<string, unknown>>()

    expect(response.status).toBe(500)
    expect(response.headers.get('Location')).toBeNull()
    expect(Object.keys(body).sort()).toEqual(['code', 'error'])
    expect(body.code).toBe(500)
  })

  it('rejects an ID token whose nonce belongs to another attempt', async () => {
    const user = await createUser({ email: uniqueEmail('google-nonce') })
    const { state } = await startFlow()
    await stubGoogle(await googleIdToken({ sub: 'sub-nonce', email: user.email, nonce: 'someone-elses-nonce' }))

    const response = await callback({ state, code: 'c' })

    const target = new URL(response.headers.get('Location') as string)
    expect(target.searchParams.get('error')).toBe('access_denied')
    expect(target.searchParams.get('error_description')).toContain('nonce does not match')
  })

  it('rejects an ID token signed by a key Google does not publish', async () => {
    const user = await createUser({ email: uniqueEmail('google-key') })
    const { state, nonce } = await startFlow()
    const jwks = await googleJwks(['google-test-key'])
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: async () =>
        Response.json({ id_token: await googleIdToken({ sub: 's', email: user.email, nonce }, 'rogue-key') }),
      [GOOGLE_JWKS_URI]: () => Response.json(jwks),
    })

    const response = await callback({ state, code: 'c' })

    expect(new URL(response.headers.get('Location') as string).searchParams.get('error')).toBe('access_denied')
  })

  it('refuses an account Google has not verified the address for', async () => {
    const email = uniqueEmail('google-unverified')
    await createInvitation({ email })
    const { state, nonce } = await startFlow()
    await stubGoogle(await googleIdToken({ sub: 'sub-unverified', email, email_verified: false, nonce }))

    const response = await callback({ state, code: 'c' })

    const target = new URL(response.headers.get('Location') as string)
    expect(target.searchParams.get('error')).toBe('access_denied')
    expect(target.searchParams.get('error_description')).toBe('The provider did not verify this email address')
  })

  it('refuses an uninvited address and records the rejection', async () => {
    const email = uniqueEmail('google-uninvited')
    const { state, nonce } = await startFlow()
    await stubGoogle(await googleIdToken({ sub: 'sub-uninvited', email, nonce }))

    const response = await callback({ state, code: 'c' })

    expect(new URL(response.headers.get('Location') as string).searchParams.get('error_description')).toBe(
      'This email address has not been invited',
    )

    const rejected = await db().select().from(auditLogs).where(eq(auditLogs.event, 'oauth.callback.rejected'))
    expect(rejected.map((row) => JSON.parse(row.metadata ?? 'null'))).toContainEqual({
      provider: 'google',
      reason: 'access_denied',
    })
  })

  it('requires a state parameter', async () => {
    expect((await SELF.fetch('https://auth.internal/oauth/google/callback')).status).toBe(400)
    expect((await callback({ state: '' })).status).toBe(400)
  })
})
