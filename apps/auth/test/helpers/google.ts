import { sign } from 'hono/jwt'

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Matches `GOOGLE_CLIENT_ID` as injected by `vitest.config.ts`. */
const GOOGLE_CLIENT_ID = 'test-google-client-id'

type SigningKey = { privateJwk: JsonWebKey & { kid: string }; publicJwk: JsonWebKey & { kid: string } }

const keyCache = new Map<string, Promise<SigningKey>>()

/**
 * An RSA keypair standing in for one of Google's signing keys. Generated per `kid` and cached, so a
 * test that only needs the usual key does not pay for a 2048-bit keygen every time.
 */
const googleKey = (kid = 'google-test-key'): Promise<SigningKey> => {
  const cached = keyCache.get(kid)
  if (cached) {
    return cached
  }

  const created = (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    return {
      privateJwk: { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), alg: 'RS256', kid },
      publicJwk: { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), alg: 'RS256', kid, use: 'sig' },
    } as SigningKey
  })()

  keyCache.set(kid, created)
  return created
}

type IdTokenClaims = Record<string, unknown>

/** Mints an ID token that looks like Google's, defaulting every claim `verifyIdToken` inspects. */
const googleIdToken = async (claims: IdTokenClaims = {}, kid?: string) => {
  const key = await googleKey(kid)
  const now = Math.floor(Date.now() / 1000)
  return sign(
    {
      iss: 'https://accounts.google.com',
      aud: GOOGLE_CLIENT_ID,
      sub: 'google-sub-default',
      email: 'someone@example.test',
      email_verified: true,
      iat: now,
      exp: now + 300,
      ...claims,
    },
    key.privateJwk,
    'RS256',
  )
}

/** The JWKS document Google would publish for the given keys. */
const googleJwks = async (kids: string[] = ['google-test-key']) => ({
  keys: await Promise.all(kids.map(async (kid) => (await googleKey(kid)).publicJwk)),
})

export { GOOGLE_AUTHORIZATION_ENDPOINT, GOOGLE_CLIENT_ID, GOOGLE_JWKS_URI, GOOGLE_TOKEN_ENDPOINT, googleIdToken, googleJwks, googleKey }
