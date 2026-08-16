import axios from 'axios'
import { verifyWithJwks } from 'hono/jwt'
import type { Env } from '@/env'
import { OAuthException } from '@/lib/errors'
import type { ProviderDescriptor, ProviderProfile } from '@/providers/types'

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
/** Google issues tokens under both spellings; either is acceptable per its discovery document. */
const GOOGLE_ISSUERS = /^(https:\/\/)?accounts\.google\.com$/
const GOOGLE_SCOPE = 'openid email profile'

const googleProvider: ProviderDescriptor = {
  name: 'google',
  displayName: 'Google',
  initiation: 'redirect',
  startPath: '/oauth/google/authorize',
  isConfigured: (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
}

/** The redirect URI registered in the Google Cloud console. Derived from the Worker's public URL. */
const getRedirectUri = (env: Env) => `${env.AUTH_PUBLIC_URL}/oauth/google/callback`

/**
 * Builds the URL the browser is sent to. PKCE is used on this leg too — the `code_challenge` here
 * is ours, protecting the code Google returns, and is unrelated to the client application's own
 * challenge, which protects the code we later return to the client.
 */
const buildAuthorizationUrl = (
  env: Env,
  input: { state: string; codeChallenge: string; nonce: string; loginHint?: string | null },
) => {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', getRedirectUri(env))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', GOOGLE_SCOPE)
  url.searchParams.set('state', input.state)
  url.searchParams.set('nonce', input.nonce)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // No refresh token is requested: Google is only asked to prove identity once, and the session
  // afterwards is this Worker's own.
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('prompt', 'select_account')
  if (input.loginHint) {
    url.searchParams.set('login_hint', input.loginHint)
  }
  return url.toString()
}

type GoogleTokenResponse = {
  access_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
}

const exchangeAuthorizationCode = async (env: Env, input: { code: string; codeVerifier: string }) => {
  const body = new URLSearchParams({
    code: input.code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: getRedirectUri(env),
    grant_type: 'authorization_code',
    code_verifier: input.codeVerifier,
  })

  const response = await axios.post<GoogleTokenResponse>(GOOGLE_TOKEN_ENDPOINT, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true,
  })

  if (response.status !== 200 || !response.data?.id_token) {
    const detail = response.data?.error_description ?? response.data?.error ?? `HTTP ${response.status}`
    throw new OAuthException(502, 'server_error', `Google rejected the authorization code: ${detail}`)
  }

  return response.data
}

type GoogleIdTokenClaims = {
  sub?: string
  email?: string
  email_verified?: boolean | string
  name?: string
  given_name?: string
  family_name?: string
  picture?: string
  locale?: string
  nonce?: string
  hd?: string
}

/**
 * Validates Google's ID token and maps it onto a `ProviderProfile`.
 *
 * The signature is checked against Google's published JWKS even though the token came straight from
 * the token endpoint over TLS (which OIDC Core §3.1.3.7 would let us skip): it is one call, it is
 * cached, and it removes any dependency on the transport being the only thing standing between us
 * and a forged token. `nonce` is then matched against the value stored when the flow started, which
 * is what makes a replayed ID token useless.
 */
const verifyIdToken = async (env: Env, idToken: string, expectedNonce: string): Promise<ProviderProfile> => {
  let claims: GoogleIdTokenClaims
  try {
    claims = (await verifyWithJwks(
      idToken,
      {
        jwks_uri: GOOGLE_JWKS_URI,
        allowedAlgorithms: ['RS256'],
        verification: { iss: GOOGLE_ISSUERS, aud: env.GOOGLE_CLIENT_ID },
      },
      // Google's certs rotate slowly and the response is cacheable; the hint keeps this from being
      // a fresh round trip on every single sign-in.
      { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit,
    )) as GoogleIdTokenClaims
  } catch (error) {
    throw new OAuthException(401, 'access_denied', `Google ID token could not be verified: ${(error as Error).message}`)
  }

  if (!claims.nonce || claims.nonce !== expectedNonce) {
    throw new OAuthException(401, 'access_denied', 'Google ID token nonce does not match this sign-in attempt')
  }
  if (!claims.sub || !claims.email) {
    throw new OAuthException(401, 'access_denied', 'Google ID token is missing the sub or email claim')
  }

  // Google serialises `email_verified` as a boolean, but older clients have seen the string form.
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true'

  return {
    provider: 'google',
    providerAccountId: claims.sub,
    email: claims.email,
    emailVerified,
    name: claims.name ?? null,
    givenName: claims.given_name ?? null,
    familyName: claims.family_name ?? null,
    picture: claims.picture ?? null,
    locale: claims.locale ?? null,
    raw: {
      sub: claims.sub,
      email: claims.email,
      email_verified: emailVerified,
      name: claims.name ?? null,
      picture: claims.picture ?? null,
      hd: claims.hd ?? null,
    },
  }
}

export { buildAuthorizationUrl, exchangeAuthorizationCode, getRedirectUri, googleProvider, verifyIdToken }
