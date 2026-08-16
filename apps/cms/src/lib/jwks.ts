import { decode, verify } from 'hono/jwt'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import type { Env } from '@/env'
import { JWKS_CACHE_TTL } from '@/lib/config'

/**
 * Offline verification of the access tokens issued by the auth Worker.
 *
 * The CMS deliberately has no service binding back into `auth`: tokens are EdDSA-signed and the
 * matching public keys are published at `AUTH_JWKS_URL`, so validating one is a signature check
 * plus a cached key fetch, not a call into another service.
 *
 * The trade-off that buys: authorization data in the token (roles, permissions) is a snapshot from
 * when it was minted. Access tokens live 15 minutes, so a revoked account keeps working for at most
 * that long. The email-domain gate in `middleware/auth.ts` is what actually bounds who gets in.
 */

/** Claims the auth Worker puts on an access token. Mirrors `AccessTokenClaims` in apps/auth. */
type AccessTokenClaims = {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  jti: string
  /** Session the token belongs to. */
  sid: string
  provider: string
  email: string
  email_verified: boolean
  name: string | null
  picture: string | null
  roles: string[]
  permissions: string[]
}

type CachedJwks = {
  url: string
  keys: HonoJsonWebKey[]
  /** Unix seconds after which the set is refetched. */
  expiresAt: number
}

/**
 * Per-isolate cache. Workers isolates are short-lived and per-colo, so this is a best-effort
 * memoisation rather than a shared cache — the worst case is one extra JWKS fetch per isolate.
 */
let cached: CachedJwks | null = null

const fetchJwks = async (url: string): Promise<HonoJsonWebKey[]> => {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`JWKS endpoint answered ${response.status}`)
  }

  const body = (await response.json()) as { keys?: unknown }
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('JWKS endpoint returned no keys')
  }
  return body.keys as HonoJsonWebKey[]
}

const getJwks = async (env: Env, force = false): Promise<HonoJsonWebKey[]> => {
  const now = Math.floor(Date.now() / 1000)
  if (!force && cached && cached.url === env.AUTH_JWKS_URL && cached.expiresAt > now) {
    return cached.keys
  }

  const keys = await fetchJwks(env.AUTH_JWKS_URL)
  cached = { url: env.AUTH_JWKS_URL, keys, expiresAt: now + JWKS_CACHE_TTL }
  return keys
}

const findKey = (keys: HonoJsonWebKey[], kid: string | undefined) =>
  keys.find((key) => (kid ? key.kid === kid : true)) ?? null

/**
 * Verifies an access token and returns its claims.
 *
 * A `kid` that is not in the cached key set triggers one forced refetch before giving up: that is
 * exactly what a key rotation on the auth side looks like from here, and waiting out the cache TTL
 * would mean up to an hour of rejected logins.
 *
 * The `aud` allowlist matters as much as the signature — a token minted for the public website is
 * a valid token, it is just not a token for this CMS.
 */
const verifyAccessToken = async (env: Env, token: string): Promise<AccessTokenClaims> => {
  const { header } = decode(token)

  let keys = await getJwks(env)
  let key = findKey(keys, header.kid)
  if (!key) {
    keys = await getJwks(env, true)
    key = findKey(keys, header.kid)
  }
  if (!key) {
    throw new Error(`no published key matches kid "${header.kid}"`)
  }

  const audiences = env.CMS_ALLOWED_AUDIENCES.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (audiences.length === 0) {
    throw new Error('CMS_ALLOWED_AUDIENCES is empty, so no token can be accepted')
  }

  const payload = await verify(token, key, {
    alg: 'EdDSA',
    iss: env.AUTH_ISSUER,
    aud: audiences,
  })

  return payload as unknown as AccessTokenClaims
}

export { verifyAccessToken }
export type { AccessTokenClaims }
