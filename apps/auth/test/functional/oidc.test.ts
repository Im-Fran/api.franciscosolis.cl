import { SELF, env } from 'cloudflare:test'
import { decode } from 'hono/jwt'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { sessions } from '@/db/schema'
import { TTL } from '@/lib/config'
import { accessTokenHash, verifySignedToken } from '@/lib/jwt'
import type { IdTokenClaims } from '@/lib/jwt'
import { issueAuthorizationCode } from '@/services/tokens'
import { createApplication, createRole, createUser, db, grant, SEED } from '../helpers/db'
import { RFC7636 } from '../helpers/pkce'

type TokenBody = {
  access_token: string
  refresh_token: string
  id_token?: string
  session_id: string
  scope: string | null
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  SELF.fetch('https://auth.internal/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  })

/** Runs a full authorization code exchange and hands back the tokens it produced. */
const signIn = async (
  overrides: { scope?: string | null; nonce?: string | null; userId?: string } = {},
): Promise<TokenBody & { userId: string }> => {
  const userId = overrides.userId ?? (await createUser({ name: 'Ada', givenName: 'Ada', familyName: 'Lovelace' })).id
  const code = await issueAuthorizationCode(db(), {
    userId,
    applicationId: SEED.webAppId,
    provider: 'magic_link',
    redirectUri: SEED.webRedirectUri,
    nonce: overrides.nonce ?? null,
    codeChallenge: RFC7636.challenge,
    codeChallengeMethod: 'S256',
    scope: overrides.scope === undefined ? 'openid profile email' : overrides.scope,
  })

  const response = await form({
    grant_type: 'authorization_code',
    client_id: SEED.webAppId,
    code,
    redirect_uri: SEED.webRedirectUri,
    code_verifier: RFC7636.verifier,
  })

  return { ...(await response.json<TokenBody>()), userId }
}

const idClaims = (token: string) => verifySignedToken<IdTokenClaims>(env, token)

describe('id_token', () => {
  it('comes with the token response whenever the granted scope contains openid', async () => {
    const withOpenid = await signIn()
    const without = await signIn({ scope: 'profile email' })

    expect(withOpenid.id_token).toBeTruthy()
    expect(without.id_token).toBeUndefined()
  })

  it('is signed by the same key the JWKS publishes, and names this issuer', async () => {
    const { id_token: idToken } = await signIn()

    await expect(idClaims(idToken as string)).resolves.toMatchObject({ iss: env.AUTH_ISSUER })
    expect(decode(idToken as string).header).toMatchObject({ alg: 'EdDSA', kid: expect.any(String) })
  })

  it('is audience-restricted to the client, with azp saying the same thing', async () => {
    const claims = await idClaims((await signIn()).id_token as string)

    expect(claims.aud).toBe(SEED.webAppId)
    expect(claims.azp).toBe(SEED.webAppId)
  })

  it('echoes the nonce the client sent, and omits it when there was none', async () => {
    expect((await idClaims((await signIn({ nonce: 'n-once' })).id_token as string)).nonce).toBe('n-once')
    expect((await idClaims((await signIn()).id_token as string)).nonce).toBeUndefined()
  })

  it('binds itself to the access token it came with, through at_hash', async () => {
    const tokens = await signIn()
    const claims = await idClaims(tokens.id_token as string)

    expect(claims.at_hash).toBe(await accessTokenHash(tokens.access_token))
    expect(claims.at_hash).not.toBe(await accessTokenHash(`${tokens.access_token}x`))
  })

  it('carries the session id, so RP-initiated logout knows what to revoke', async () => {
    const tokens = await signIn()

    expect((await idClaims(tokens.id_token as string)).sid).toBe(tokens.session_id)
  })

  it('states when the user authenticated, and expires on its own schedule', async () => {
    const claims = await idClaims((await signIn()).id_token as string)

    expect(claims.auth_time).toBeLessThanOrEqual(claims.iat)
    expect(claims.exp - claims.iat).toBe(TTL.idToken)
  })

  it('carries the profile and email claims the scope entitles the client to', async () => {
    const full = await idClaims((await signIn()).id_token as string)
    const minimal = await idClaims((await signIn({ scope: 'openid' })).id_token as string)

    expect(full).toMatchObject({ email: expect.any(String), email_verified: true, name: 'Ada', given_name: 'Ada' })
    expect(minimal.email).toBeUndefined()
    expect(minimal.name).toBeUndefined()
  })

  it('publishes roles under `groups` too, which is what group-based relying parties read', async () => {
    const user = await createUser()
    const role = await createRole({ slug: 'editors' })
    await grant(user.id, role.id)

    const claims = await idClaims(
      (await signIn({ userId: user.id, scope: 'openid roles groups' })).id_token as string,
    )

    expect(claims.roles).toContain('editors')
    expect(claims.groups).toEqual(claims.roles)
  })

  it('leaves the role claims out when the scope did not ask for them', async () => {
    const claims = await idClaims((await signIn()).id_token as string)

    expect(claims.roles).toBeUndefined()
    expect(claims.groups).toBeUndefined()
  })

  it('does not replay the original nonce on a refresh, which is a different authentication event', async () => {
    const first = await signIn({ nonce: 'n-once' })

    const refreshed = await (
      await form({ grant_type: 'refresh_token', client_id: SEED.webAppId, refresh_token: first.refresh_token })
    ).json<TokenBody>()
    const claims = await idClaims(refreshed.id_token as string)

    expect(claims.nonce).toBeUndefined()
    // The authentication itself did not happen again, so auth_time must not move.
    expect(claims.auth_time).toBe((await idClaims(first.id_token as string)).auth_time)
  })
})

describe('GET /oauth/userinfo', () => {
  const userinfo = (token: string, method = 'GET') =>
    SELF.fetch('https://auth.internal/oauth/userinfo', { method, headers: { Authorization: `Bearer ${token}` } })

  it('returns the flat OIDC claim set, not this API\'s envelope', async () => {
    const tokens = await signIn()

    const body = await (await userinfo(tokens.access_token)).json<Record<string, unknown>>()

    expect(body).not.toHaveProperty('data')
    expect(body.sub).toBe(tokens.userId)
    expect(body.email_verified).toBe(true)
  })

  it('answers POST as well, as the specification requires', async () => {
    const tokens = await signIn()

    expect((await userinfo(tokens.access_token, 'POST')).status).toBe(200)
  })

  it('returns only what the token\'s own scope entitles the caller to', async () => {
    const narrow = await signIn({ scope: 'openid' })
    const wide = await signIn({ scope: 'openid email' })

    const narrowBody = await (await userinfo(narrow.access_token)).json<Record<string, unknown>>()
    const wideBody = await (await userinfo(wide.access_token)).json<Record<string, unknown>>()

    expect(Object.keys(narrowBody)).toEqual(['sub'])
    expect(wideBody.email).toEqual(expect.any(String))
  })

  it('refuses a token that was never granted the openid scope', async () => {
    const tokens = await signIn({ scope: 'profile' })

    const response = await userinfo(tokens.access_token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'access_denied' })
  })

  it('requires a Bearer token', async () => {
    const response = await SELF.fetch('https://auth.internal/oauth/userinfo')

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' })
  })

  it('refuses a token whose session has been revoked, before it expires', async () => {
    const tokens = await signIn()
    await db().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, tokens.session_id))

    const response = await userinfo(tokens.access_token)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error_description: 'This session has been revoked' })
  })

  it('refuses a garbage token', async () => {
    expect((await userinfo('not.a.jwt')).status).toBe(401)
  })

  it('reads roles live, so a role granted after the token was issued still shows up', async () => {
    const user = await createUser()
    const tokens = await signIn({ userId: user.id, scope: 'openid roles' })

    const role = await createRole({ slug: 'late-grant' })
    await grant(user.id, role.id)

    const body = await (await userinfo(tokens.access_token)).json<{ roles: string[] }>()
    expect(body.roles).toContain('late-grant')
  })

  it('refuses a client credentials token, which stands for no user at all', async () => {
    const machine = await createApplication({
      clientSecret: 'userinfo-machine-secret',
      grantTypes: ['client_credentials'],
    })
    const body = await (
      await form({
        grant_type: 'client_credentials',
        client_id: machine.id,
        client_secret: 'userinfo-machine-secret',
        scope: 'openid',
      })
    ).json<{ access_token: string }>()

    const response = await userinfo(body.access_token)

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'This endpoint needs a token issued for a user, not for a client',
    })
  })
})

describe('POST /oauth/logout', () => {
  const logout = (params: Record<string, string>) =>
    SELF.fetch(`https://auth.internal/oauth/logout?${new URLSearchParams(params)}`, { redirect: 'manual' })

  it('revokes the session the id_token names', async () => {
    const tokens = await signIn()

    const response = await logout({ id_token_hint: tokens.id_token as string })

    expect(response.status).toBe(200)
    const [session] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(session?.revokedAt).not.toBeNull()
    expect(session?.revokedReason).toBe('rp_initiated_logout')
  })

  it('stops the access token from being accepted, without waiting for it to expire', async () => {
    const tokens = await signIn()

    await logout({ id_token_hint: tokens.id_token as string })

    const response = await SELF.fetch('https://auth.internal/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    expect(response.status).toBe(401)
  })

  it('accepts a hint that has already expired, which is the usual case at sign-out', async () => {
    const tokens = await signIn()
    const expired = await withFrozenTime(-TTL.idToken * 2000, () => signIn())

    await logout({ id_token_hint: expired.id_token as string })

    const [session] = await db().select().from(sessions).where(eq(sessions.id, expired.session_id))
    expect(session?.revokedAt).not.toBeNull()
    // The unrelated session is untouched.
    const [other] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(other?.revokedAt).toBeNull()
  })

  it('redirects to a post-logout URI the client registered', async () => {
    const application = await createApplication({
      redirectUris: ['https://bye.test/cb'],
      postLogoutRedirectUris: ['https://bye.test/signed-out'],
    })

    const response = await logout({
      client_id: application.id,
      post_logout_redirect_uri: 'https://bye.test/signed-out',
      state: 'client-state',
    })

    expect(response.status).toBe(302)
    const target = new URL(response.headers.get('Location') as string)
    expect(target.origin + target.pathname).toBe('https://bye.test/signed-out')
    expect(target.searchParams.get('state')).toBe('client-state')
  })

  it('refuses a post-logout URI that is not registered, rather than being an open redirect', async () => {
    const application = await createApplication({ postLogoutRedirectUris: ['https://bye.test/signed-out'] })

    const response = await logout({
      client_id: application.id,
      post_logout_redirect_uri: 'https://evil.test/steal',
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('Location')).toBeNull()
  })

  it('treats a hint it cannot verify as absent instead of trusting it', async () => {
    const tokens = await signIn()
    const [header, payload] = (tokens.id_token as string).split('.')

    const response = await logout({ id_token_hint: `${header}.${payload}.tampered` })

    expect(response.status).toBe(200)
    const [session] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(session?.revokedAt).toBeNull()
  })

  it('answers a POST the same way', async () => {
    const tokens = await signIn()

    const response = await SELF.fetch('https://auth.internal/oauth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token_hint: tokens.id_token as string }).toString(),
    })

    expect(response.status).toBe(200)
    const [session] = await db().select().from(sessions).where(eq(sessions.id, tokens.session_id))
    expect(session?.revokedAt).not.toBeNull()
  })
})

/**
 * Runs `body` with `Date.now` shifted, so a token can be minted as if it had been issued in the
 * past. `hono/jwt` reads the clock through `Date.now`, which makes this enough to produce a real,
 * correctly signed, genuinely expired token.
 */
const withFrozenTime = async <T>(offsetMs: number, body: () => Promise<T>): Promise<T> => {
  const original = Date.now
  Date.now = () => original() + offsetMs
  try {
    return await body()
  } finally {
    Date.now = original
  }
}
