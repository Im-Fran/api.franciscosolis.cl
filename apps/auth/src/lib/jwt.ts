import { decode, sign, verify } from 'hono/jwt'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import type { Env } from '@/env'
import { TTL } from '@/lib/config'
import type { ProviderName } from '@/lib/config'

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
  /** Session id, so a token can be tied back to the sign-in that produced it. */
  sid: string
  provider: ProviderName
  email: string
  email_verified: boolean
  name: string | null
  picture: string | null
  roles: string[]
  permissions: string[]
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
 * Verifies a token this Worker issued. The `kid` header selects the key, so tokens signed before a
 * rotation keep verifying as long as their key is still listed in `JWT_RETIRED_PUBLIC_KEYS`.
 * Throws whatever `hono/jwt` throws (expired, signature mismatch, wrong issuer) — callers map it.
 */
const verifyAccessToken = async (env: Env, token: string): Promise<AccessTokenClaims> => {
  const { header } = decode(token)
  const keys = getPublicJwks(env)
  const key = header.kid ? keys.find((candidate) => candidate.kid === header.kid) : keys[0]
  if (!key) {
    throw new Error(`no published key matches kid "${header.kid}"`)
  }

  const payload = await verify(token, key, { alg: 'EdDSA', iss: env.AUTH_ISSUER })
  return payload as unknown as AccessTokenClaims
}

export { getPublicJwks, getSigningKey, signAccessToken, toPublicJwk, verifyAccessToken }
export type { AccessTokenClaims, Ed25519Jwk }
