import { decode, sign, verify } from 'hono/jwt'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import type { Env } from '@/env'
import { TTL } from '@/lib/config'
import type { ProviderName } from '@/lib/config'
import { base64UrlEncode } from '@/lib/crypto'

/** Ed25519 keys are OKP keys; `d` is the private scalar and is present only on the signing key. */
type Ed25519Jwk = HonoJsonWebKey & {
  kty: 'OKP'
  crv: 'Ed25519'
  x: string
  d?: string
  alg: 'EdDSA'
  kid: string
}

type AccessTokenClaims = {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  jti: string
  /** The client the token was issued to. Equal to `sub` on a client credentials token. */
  client_id: string
  /** Space-delimited scope the token was granted. */
  scope: string
  /**
   * Session id, so a token can be tied back to the sign-in that produced it. Absent on a client
   * credentials token, which authenticates an application rather than a person and has no session.
   */
  sid?: string
  /** Absent on a client credentials token, for the same reason. */
  provider?: ProviderName
  email?: string
  email_verified?: boolean
  name?: string | null
  picture?: string | null
  roles: string[]
  permissions: string[]
}

/**
 * OpenID Connect ID token. Unlike the access token this is a statement *about the authentication*
 * made to the client, so it is audience-restricted to that client and carries `nonce` and `at_hash`
 * to bind it to the request and to the access token it came with.
 *
 * `groups` duplicates `roles` deliberately: relying parties that do group-based access control —
 * Cloudflare Access is the one this server is meant to sit behind — look for that claim by name.
 */
type IdTokenClaims = {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  /** When the user actually authenticated, which a refresh does not reset. */
  auth_time: number
  /** Session id, so RP-initiated logout can find what to revoke from an `id_token_hint` alone. */
  sid: string
  nonce?: string
  at_hash?: string
  /** Authorized party; equal to `aud` here, since a token is never issued for a third party. */
  azp: string
  provider: ProviderName
  email?: string
  email_verified?: boolean
  name?: string | null
  given_name?: string | null
  family_name?: string | null
  picture?: string | null
  locale?: string | null
  roles?: string[]
  groups?: string[]
  permissions?: string[]
}

const parseJwk = (raw: string, label: string): Ed25519Jwk => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }

  const jwk = parsed as Partial<Ed25519Jwk>
  if (jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519' || !jwk?.x || !jwk?.kid) {
    throw new Error(`${label} must be an Ed25519 JWK with kty=OKP, crv=Ed25519, x and kid`)
  }
  // `sign()` copies `alg` and `kid` from the key into the JWT header, so both must be present for
  // the token to advertise which key in the JWKS verifies it.
  return { ...jwk, alg: 'EdDSA' } as Ed25519Jwk
}

/** The private JWK used to sign. Parsed per call; the secret is a string binding, not a keypair. */
const getSigningKey = (env: Env): Ed25519Jwk => {
  const key = parseJwk(env.JWT_PRIVATE_KEY, 'JWT_PRIVATE_KEY')
  if (!key.d) {
    throw new Error('JWT_PRIVATE_KEY is missing the private component `d`')
  }
  return key
}

/** Strips the private component and marks the key as verification-only for publication. */
const toPublicJwk = (key: Ed25519Jwk): Ed25519Jwk => {
  const { d: _private, ...publicKey } = key
  return { ...publicKey, use: 'sig', key_ops: ['verify'] } as Ed25519Jwk
}

/**
 * Every key a consumer may need to verify a token this Worker issued: the current signing key plus
 * any retired keys, which stay published until the last access token signed with them expires.
 */
const getPublicJwks = (env: Env): Ed25519Jwk[] => {
  const keys = [toPublicJwk(getSigningKey(env))]

  if (env.JWT_RETIRED_PUBLIC_KEYS) {
    let retired: unknown
    try {
      retired = JSON.parse(env.JWT_RETIRED_PUBLIC_KEYS)
    } catch {
      throw new Error('JWT_RETIRED_PUBLIC_KEYS is not valid JSON')
    }
    if (!Array.isArray(retired)) {
      throw new Error('JWT_RETIRED_PUBLIC_KEYS must be a JSON array of public JWKs')
    }
    for (const entry of retired) {
      const key = parseJwk(JSON.stringify(entry), 'JWT_RETIRED_PUBLIC_KEYS')
      if (!keys.some((existing) => existing.kid === key.kid)) {
        keys.push(toPublicJwk(key))
      }
    }
  }

  return keys
}

type AccessTokenInput = Omit<AccessTokenClaims, 'iss' | 'exp' | 'iat' | 'jti'>

const signAccessToken = async (env: Env, claims: AccessTokenInput) => {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + TTL.accessToken
  const payload: AccessTokenClaims = {
    ...claims,
    iss: env.AUTH_ISSUER,
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  }

  const token = await sign(payload, getSigningKey(env), 'EdDSA')
  return { token, expiresIn: TTL.accessToken, expiresAt }
}

/**
 * OIDC §3.1.3.6 `at_hash`: base64url of the left-most half of the hash of the access token. The
 * hash is picked from the signing algorithm, and EdDSA over Ed25519 does not name one for this — so
 * SHA-256 is used, matching every other digest in this Worker. A relying party that cannot verify
 * it is expected to ignore the claim, which is what the specification tells it to do.
 */
const accessTokenHash = async (accessToken: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)))
  return base64UrlEncode(digest.slice(0, digest.length / 2))
}

type IdTokenInput = Omit<IdTokenClaims, 'iss' | 'exp' | 'iat' | 'azp'> & { azp?: string }

const signIdToken = async (env: Env, claims: IdTokenInput) => {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + TTL.idToken
  const payload: IdTokenClaims = {
    ...claims,
    azp: claims.azp ?? claims.aud,
    iss: env.AUTH_ISSUER,
    iat: issuedAt,
    exp: expiresAt,
  }

  const token = await sign(payload, getSigningKey(env), 'EdDSA')
  return { token, expiresIn: TTL.idToken, expiresAt }
}

/**
 * Verifies a token this Worker issued. The `kid` header selects the key, so tokens signed before a
 * rotation keep verifying as long as their key is still listed in `JWT_RETIRED_PUBLIC_KEYS`.
 * Throws whatever `hono/jwt` throws (expired, signature mismatch, wrong issuer) — callers map it.
 *
 * `allowExpired` exists for exactly one caller: OpenID Connect RP-initiated logout, which is
 * specified to accept an `id_token_hint` that has already expired — the user being signed out is
 * the case where it most often has. The signature and the issuer are still checked, so the hint
 * remains something only this server could have produced.
 */
const verifySignedToken = async <Claims>(
  env: Env,
  token: string,
  options: { allowExpired?: boolean } = {},
): Promise<Claims> => {
  const { header } = decode(token)
  const keys = getPublicJwks(env)
  const key = header.kid ? keys.find((candidate) => candidate.kid === header.kid) : keys[0]
  if (!key) {
    throw new Error(`no published key matches kid "${header.kid}"`)
  }

  const payload = await verify(token, key, {
    alg: 'EdDSA',
    iss: env.AUTH_ISSUER,
    ...(options.allowExpired ? { exp: false } : {}),
  })
  return payload as unknown as Claims
}

const verifyAccessToken = (env: Env, token: string): Promise<AccessTokenClaims> =>
  verifySignedToken<AccessTokenClaims>(env, token)

export {
  accessTokenHash,
  getPublicJwks,
  getSigningKey,
  signAccessToken,
  signIdToken,
  toPublicJwk,
  verifyAccessToken,
  verifySignedToken,
}
export type { AccessTokenClaims, Ed25519Jwk, IdTokenClaims }
