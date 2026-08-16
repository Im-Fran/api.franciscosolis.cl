import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { OAuthException } from '@/lib/errors'
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  getRedirectUri,
  googleProvider,
  verifyIdToken,
} from '@/providers/google'
import { testEnv } from '../helpers/env'
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_CLIENT_ID,
  GOOGLE_JWKS_URI,
  GOOGLE_TOKEN_ENDPOINT,
  googleIdToken,
  googleJwks,
} from '../helpers/google'
import { restoreFetch, stubFetch } from '../helpers/http'

afterEach(restoreFetch)

describe('googleProvider', () => {
  it('is available only when both halves of the client credential are present', () => {
    expect(googleProvider.isConfigured(env)).toBe(true)
    expect(googleProvider.isConfigured(testEnv({ GOOGLE_CLIENT_ID: '' }))).toBe(false)
    expect(googleProvider.isConfigured(testEnv({ GOOGLE_CLIENT_SECRET: '' }))).toBe(false)
    expect(googleProvider.isConfigured(testEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }))).toBe(false)
  })

  it('describes itself as a redirect-initiated provider', () => {
    expect(googleProvider).toMatchObject({
      name: 'google',
      initiation: 'redirect',
      startPath: '/oauth/google/authorize',
    })
  })
})

describe('getRedirectUri', () => {
  it('is derived from the public URL, because the incoming request URL is internal', () => {
    expect(getRedirectUri(env)).toBe(`${env.AUTH_PUBLIC_URL}/oauth/google/callback`)
    expect(getRedirectUri(testEnv({ AUTH_PUBLIC_URL: 'http://localhost:8789' }))).toBe(
      'http://localhost:8789/oauth/google/callback',
    )
  })
})

describe('buildAuthorizationUrl', () => {
  const url = (overrides: Partial<Parameters<typeof buildAuthorizationUrl>[1]> = {}) =>
    new URL(
      buildAuthorizationUrl(env, {
        state: 'state-value',
        codeChallenge: 'challenge-value',
        nonce: 'nonce-value',
        ...overrides,
      }),
    )

  it('targets Google\'s authorization endpoint with this deployment\'s client and redirect URI', () => {
    const target = url()

    expect(target.origin + target.pathname).toBe(GOOGLE_AUTHORIZATION_ENDPOINT)
    expect(target.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID)
    expect(target.searchParams.get('redirect_uri')).toBe(getRedirectUri(env))
    expect(target.searchParams.get('response_type')).toBe('code')
    expect(target.searchParams.get('scope')).toBe('openid email profile')
  })

  it('carries our own PKCE challenge, state and nonce', () => {
    const target = url()

    expect(target.searchParams.get('state')).toBe('state-value')
    expect(target.searchParams.get('nonce')).toBe('nonce-value')
    expect(target.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(target.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('asks for an online, account-picking authorization, never a refresh token', () => {
    const target = url()

    expect(target.searchParams.get('access_type')).toBe('online')
    expect(target.searchParams.get('prompt')).toBe('select_account')
    expect(target.searchParams.has('offline')).toBe(false)
  })

  it('includes login_hint only when one is known', () => {
    expect(url({ loginHint: 'someone@example.test' }).searchParams.get('login_hint')).toBe('someone@example.test')
    expect(url({ loginHint: null }).searchParams.has('login_hint')).toBe(false)
    expect(url({ loginHint: '' }).searchParams.has('login_hint')).toBe(false)
  })

  it('never puts the client secret in a URL the browser will see', () => {
    expect(url().toString()).not.toContain(env.GOOGLE_CLIENT_SECRET)
  })
})

describe('exchangeAuthorizationCode', () => {
  it('posts the full credential set as a form body', async () => {
    const { calls } = stubFetch({ [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ id_token: 'token' }) })

    await exchangeAuthorizationCode(env, { code: 'auth-code', codeVerifier: 'the-verifier' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['content-type']).toContain('application/x-www-form-urlencoded')

    const body = new URLSearchParams(calls[0]?.body ?? '')
    expect(Object.fromEntries(body)).toEqual({
      code: 'auth-code',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: getRedirectUri(env),
      grant_type: 'authorization_code',
      code_verifier: 'the-verifier',
    })
  })

  it('returns the token payload when Google accepts the code', async () => {
    stubFetch({ [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ id_token: 'the-id-token', expires_in: 3599 }) })

    await expect(exchangeAuthorizationCode(env, { code: 'c', codeVerifier: 'v' })).resolves.toMatchObject({
      id_token: 'the-id-token',
      expires_in: 3599,
    })
  })

  it('surfaces the error_description Google returns', async () => {
    stubFetch({
      [GOOGLE_TOKEN_ENDPOINT]: () =>
        Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 }),
    })

    await expect(exchangeAuthorizationCode(env, { code: 'c', codeVerifier: 'v' })).rejects.toThrow(
      'Google rejected the authorization code: Bad Request',
    )
  })

  it('falls back to the error code, then to the HTTP status, when no description is given', async () => {
    stubFetch({ [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ error: 'invalid_client' }, { status: 401 }) })
    await expect(exchangeAuthorizationCode(env, { code: 'c', codeVerifier: 'v' })).rejects.toThrow(
      'Google rejected the authorization code: invalid_client',
    )

    restoreFetch()
    stubFetch({ [GOOGLE_TOKEN_ENDPOINT]: () => new Response('nope', { status: 503 }) })
    await expect(exchangeAuthorizationCode(env, { code: 'c', codeVerifier: 'v' })).rejects.toThrow(
      'Google rejected the authorization code: HTTP 503',
    )
  })

  it('refuses a 200 that carries no ID token, which would leave us with nothing to verify', async () => {
    stubFetch({ [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ access_token: 'only-an-access-token' }) })

    await expect(exchangeAuthorizationCode(env, { code: 'c', codeVerifier: 'v' })).rejects.toMatchObject({
      status: 502,
      code: 'server_error',
    })
  })
})

describe('verifyIdToken', () => {
  const withJwks = async (kids?: string[]) => {
    const jwks = await googleJwks(kids)
    return stubFetch({ [GOOGLE_JWKS_URI]: () => Response.json(jwks) })
  }

  it('maps a valid ID token onto a provider profile', async () => {
    await withJwks()
    const token = await googleIdToken({
      sub: 'sub-123',
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      given_name: 'Ada',
      family_name: 'Lovelace',
      picture: 'https://p.test/ada.png',
      locale: 'en-GB',
      hd: 'example.test',
      nonce: 'the-nonce',
    })

    await expect(verifyIdToken(env, token, 'the-nonce')).resolves.toEqual({
      provider: 'google',
      providerAccountId: 'sub-123',
      email: 'ada@example.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      picture: 'https://p.test/ada.png',
      locale: 'en-GB',
      raw: {
        sub: 'sub-123',
        email: 'ada@example.test',
        email_verified: true,
        name: 'Ada Lovelace',
        picture: 'https://p.test/ada.png',
        hd: 'example.test',
      },
    })
  })

  it('nulls the optional profile fields instead of leaving them undefined', async () => {
    await withJwks()
    const token = await googleIdToken({ nonce: 'n' })

    await expect(verifyIdToken(env, token, 'n')).resolves.toMatchObject({
      name: null,
      givenName: null,
      familyName: null,
      picture: null,
      locale: null,
    })
  })

  it('accepts the string form of email_verified that older clients report', async () => {
    await withJwks()

    await expect(verifyIdToken(env, await googleIdToken({ email_verified: 'true', nonce: 'n' }), 'n')).resolves.toMatchObject(
      { emailVerified: true },
    )
  })

  it('treats anything other than true or "true" as unverified', async () => {
    await withJwks()

    for (const value of [false, 'false', 'yes', 1, undefined]) {
      const token = await googleIdToken({ email_verified: value, nonce: 'n' })
      await expect(verifyIdToken(env, token, 'n')).resolves.toMatchObject({ emailVerified: false })
    }
  })

  it('refuses a token whose nonce does not match this sign-in attempt', async () => {
    await withJwks()
    const token = await googleIdToken({ nonce: 'issued-for-another-attempt' })

    await expect(verifyIdToken(env, token, 'the-expected-nonce')).rejects.toThrow(
      new OAuthException(401, 'access_denied', 'Google ID token nonce does not match this sign-in attempt'),
    )
  })

  it('refuses a token with no nonce at all, which is what a replayed token looks like', async () => {
    await withJwks()

    await expect(verifyIdToken(env, await googleIdToken(), 'the-nonce')).rejects.toThrow(
      'Google ID token nonce does not match this sign-in attempt',
    )
  })

  it('refuses a token missing the sub or the email claim', async () => {
    await withJwks()

    await expect(verifyIdToken(env, await googleIdToken({ sub: undefined, nonce: 'n' }), 'n')).rejects.toThrow(
      'Google ID token is missing the sub or email claim',
    )
    await expect(verifyIdToken(env, await googleIdToken({ email: undefined, nonce: 'n' }), 'n')).rejects.toThrow(
      'Google ID token is missing the sub or email claim',
    )
  })

  it('refuses a token issued for another OAuth client', async () => {
    await withJwks()
    const token = await googleIdToken({ aud: 'some-other-client.apps.googleusercontent.com', nonce: 'n' })

    await expect(verifyIdToken(env, token, 'n')).rejects.toThrow(/could not be verified/)
  })

  it('refuses a token from an issuer that is not Google', async () => {
    await withJwks()
    const token = await googleIdToken({ iss: 'https://accounts.evil.test', nonce: 'n' })

    await expect(verifyIdToken(env, token, 'n')).rejects.toMatchObject({ status: 401, code: 'access_denied' })
  })

  it('accepts both spellings of the Google issuer', async () => {
    await withJwks()

    for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
      await expect(verifyIdToken(env, await googleIdToken({ iss, nonce: 'n' }), 'n')).resolves.toMatchObject({
        provider: 'google',
      })
    }
  })

  it('refuses an expired token', async () => {
    await withJwks()
    const past = Math.floor(Date.now() / 1000) - 3600
    const token = await googleIdToken({ iat: past, exp: past + 60, nonce: 'n' })

    await expect(verifyIdToken(env, token, 'n')).rejects.toThrow(/could not be verified/)
  })

  it('refuses a token signed by a key Google does not publish', async () => {
    await withJwks(['google-test-key'])
    const token = await googleIdToken({ nonce: 'n' }, 'rogue-key')

    await expect(verifyIdToken(env, token, 'n')).rejects.toMatchObject({ status: 401, code: 'access_denied' })
  })

  it('refuses a string that is not a JWT', async () => {
    await withJwks()

    await expect(verifyIdToken(env, 'not-a-token', 'n')).rejects.toMatchObject({ code: 'access_denied' })
  })

  it('fails closed when the JWKS cannot be fetched', async () => {
    stubFetch({ [GOOGLE_JWKS_URI]: () => new Response('nope', { status: 500 }) })

    await expect(verifyIdToken(env, await googleIdToken({ nonce: 'n' }), 'n')).rejects.toThrow(
      /Google ID token could not be verified/,
    )
  })

  it('asks Cloudflare to cache the certs rather than fetching them on every sign-in', async () => {
    const { calls } = await withJwks()
    await verifyIdToken(env, await googleIdToken({ nonce: 'n' }), 'n')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(GOOGLE_JWKS_URI)
    // The hint travels in the `RequestInit`, not in the request itself, so it has to be read there.
    expect((calls[0]?.init as { cf?: Record<string, unknown> } | undefined)?.cf).toEqual({
      cacheTtl: 3600,
      cacheEverything: true,
    })
  })

  it('fetches the JWKS once per verification, not once per key in the set', async () => {
    const { calls } = await withJwks(['google-test-key', 'second-google-key'])

    await verifyIdToken(env, await googleIdToken({ nonce: 'n' }, 'second-google-key'), 'n')

    expect(calls.filter((call) => call.url === GOOGLE_JWKS_URI)).toHaveLength(1)
  })
})
