import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv, Env } from '@/env'
import type { AccessTokenClaims } from '@/lib/jwks'
import { verifyAccessToken } from '@/lib/jwks'

/** Everything an authenticated CMS handler needs to know about the caller. */
type Editor = {
  id: string
  email: string
  name: string | null
  picture: string | null
  sessionId: string
  applicationId: string
  /** Snapshot from the access token — see the note on staleness in `lib/jwks.ts`. */
  roles: string[]
  permissions: string[]
  claims: AccessTokenClaims
}

const bearerToken = (header: string | undefined) => {
  if (!header) {
    return null
  }
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    return null
  }
  return rest.join(' ').trim() || null
}

/**
 * Turns a verification failure into a message safe to hand back.
 *
 * `hono/jwt` embeds the offending token in several of its error messages (`JwtTokenExpired`,
 * `JwtTokenInvalid`, `JwtTokenSignatureMismatched`), which would echo a live credential into a
 * response body, a browser console and any log that captures either. The error class name says
 * everything the caller needs and carries nothing secret.
 */
const describeTokenError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'JwtTokenExpired':
      return 'the token has expired'
    case 'JwtTokenNotBefore':
    case 'JwtTokenIssuedAt':
      return 'the token is not valid yet'
    case 'JwtTokenIssuer':
      return 'the token was issued by a different service'
    case 'JwtTokenAudience':
    case 'JwtPayloadRequiresAud':
      return 'the token was not issued for the CMS'
    case 'JwtTokenSignatureMismatched':
    case 'JwtAlgorithmMismatch':
    case 'JwtAlgorithmNotAllowed':
      return 'the signature could not be verified'
    case 'JwtTokenInvalid':
    case 'JwtHeaderInvalid':
    case 'JwtHeaderRequiresKid':
      return 'the token is malformed'
    default:
      // Everything else is ours (JWKS unreachable, no matching key) and carries no credential.
      return error instanceof Error ? error.message : 'unknown error'
  }
}

const allowedDomains = (env: Env) =>
  env.CMS_ALLOWED_EMAIL_DOMAINS.split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)

/**
 * True only for an address whose domain is on the allowlist. Matching is on the full domain label,
 * never a suffix: `franciscosolis.cl.evil.com` and `notfranciscosolis.cl` must not pass a gate
 * that says `franciscosolis.cl`.
 */
const isAllowedEmail = (env: Env, email: string) => {
  const domain = email.split('@')[1]?.toLowerCase()
  return domain !== undefined && allowedDomains(env).includes(domain)
}

/**
 * Gate for every write and every non-public read in this Worker.
 *
 * Three things have to hold: the token is a valid, unexpired token signed by the auth Worker and
 * minted for this CMS (`verifyAccessToken`), the address on it was verified by its provider, and
 * that address belongs to an allowed domain. The domain check is the actual access rule — the CMS
 * is for @franciscosolis.cl staff, and everyone else is refused even with a flawless token.
 */
const requireEditor = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new HTTPException(401, { message: 'A Bearer access token is required' })
  }

  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token)
  } catch (error) {
    throw new HTTPException(401, { message: `Invalid access token: ${describeTokenError(error)}` })
  }

  // An unverified address proves nothing about who is holding it, and the whole gate below is an
  // assertion about the address.
  if (!claims.email_verified) {
    throw new HTTPException(403, { message: 'This account has no verified email address' })
  }
  if (!isAllowedEmail(c.env, claims.email)) {
    throw new HTTPException(403, { message: 'This account is not allowed to access the CMS' })
  }

  c.set('editor', {
    id: claims.sub,
    email: claims.email.toLowerCase(),
    name: claims.name ?? null,
    picture: claims.picture ?? null,
    sessionId: claims.sid,
    applicationId: claims.aud,
    roles: claims.roles ?? [],
    permissions: claims.permissions ?? [],
    claims,
  })

  await next()
})

export { isAllowedEmail, requireEditor }
export type { Editor }
