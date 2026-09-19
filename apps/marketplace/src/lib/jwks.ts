import { decode, verify } from 'hono/jwt'
import type { HonoJsonWebKey } from 'hono/utils/jwt/jws'
import type { Env } from '@/env'
import { JWKS_CACHE_TTL } from '@/lib/config'

/**
 * Offline verification of the access tokens issued by the auth Worker.
 *
 * Tokens are EdDSA-signed and the matching public keys are published at `AUTH_JWKS_URL`, so
 * validating one is a signature check plus a cached key fetch — the auth Worker is never asked
 * about a specific token.
 *
 * That key fetch goes over the `AUTH` service binding rather than over the public URL, and it has
 * to. `api.franciscosolis.cl` is answered entirely by Workers, and a Worker's subrequest to its own
 * zone bypasses Workers routing and is sent to the zone's origin — of which there is none. The
 * public fetch therefore came back `522` every single time, the key set never loaded, and
 * `requireEditor` would answer `401 Invalid access token: JWKS endpoint answered 522` to every
 * caller, valid token or not — which is precisely what happened to the CMS Worker before its key
 * fetch was moved onto the binding. Nothing about the request reveals it; the editorial API is
 * simply shut.
 *
 * The trade-off the offline check buys: authorization data in the token (roles, permissions) is a
 * snapshot from when it was minted. Access tokens live 15 minutes, so a revoked account keeps
 * working for at most that long. The email-domain gate in `middleware/auth.ts` is what actually
 * bounds who gets in.
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

const fetchJwks = async (env: Env): Promise<HonoJsonWebKey[]> => {
  const response = await env.AUTH.fetch(env.AUTH_JWKS_URL, { headers: { Accept: 'application/json' } })
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

  const keys = await fetchJwks(env)
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
 * a valid token, it is just not a token this Worker accepts a write from. It is a *parameter* rather
 * than read off `env` here, because this Worker now accepts two different populations: editors from
 * `MARKETPLACE_ALLOWED_AUDIENCES`, and buyers reading their own purchases from `MARKETPLACE_ACCOUNT_AUDIENCES`.
 * Every caller names the list it means, so widening one can never silently widen the other.
 */
const verifyAccessToken = async (
  env: Env,
  token: string,
  allowedAudiences: string,
): Promise<AccessTokenClaims> => {
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

  const audiences = allowedAudiences.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (audiences.length === 0) {
    throw new Error('the audience allowlist is empty, so no token can be accepted')
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
