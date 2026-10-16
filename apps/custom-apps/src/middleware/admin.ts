import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv, Env } from '@/env'
import { ADMIN_PERMISSION } from '@/lib/config'
import type { AccessTokenClaims } from '@/lib/jwks'
import { verifyAccessToken } from '@/lib/jwks'

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
 * Turns a verification failure into a message safe to hand back. `hono/jwt` embeds the offending
 * token in several of its error messages, which would echo a live credential into a response body.
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
      return 'the token was not issued for this service'
    case 'JwtTokenSignatureMismatched':
    case 'JwtAlgorithmMismatch':
    case 'JwtAlgorithmNotAllowed':
      return 'the signature could not be verified'
    case 'JwtTokenInvalid':
    case 'JwtHeaderInvalid':
    case 'JwtHeaderRequiresKid':
      return 'the token is malformed'
    default:
      return error instanceof Error ? error.message : 'unknown error'
  }
}

const allowedDomains = (env: Env) =>
  env.CUSTOM_APPS_ALLOWED_EMAIL_DOMAINS.split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)

/** Matches the full domain label, never a suffix: `franciscosolis.cl.evil.com` must not pass. */
const isAllowedEmail = (env: Env, email: string) => {
  const domain = email.split('@')[1]?.toLowerCase()
  return domain !== undefined && allowedDomains(env).includes(domain)
}

/**
 * Gate for the whole panel API.
 *
 * Four things have to hold, the same four as the marketplace console: a valid token minted for
 * *this panel's* client application, a verified address, on an allowed domain, carrying
 * `custom-apps:admin`. The permission is the one that matters — the panel holds clients' contact
 * details and, later, their credentials, and it is meant for one person — and the domain is the
 * broad rule underneath it.
 *
 * An installation's token can never pass: it is an opaque string, not a JWT, and fails to decode
 * long before any of this. That separation is the point of the two surfaces.
 */
const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
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

  if (!claims.email_verified) {
    throw new HTTPException(403, { message: 'This account has no verified email address' })
  }
  if (!isAllowedEmail(c.env, claims.email)) {
    throw new HTTPException(403, { message: 'This account is not allowed into the custom apps panel' })
  }
  if (!(claims.permissions ?? []).includes(ADMIN_PERMISSION)) {
    throw new HTTPException(403, { message: `This account is missing the ${ADMIN_PERMISSION} permission` })
  }

  c.set('admin', {
    id: claims.sub,
    email: claims.email.toLowerCase(),
    name: claims.name ?? null,
    picture: claims.picture ?? null,
    roles: claims.roles ?? [],
    permissions: claims.permissions ?? [],
    claims,
  })
  await next()
})

export { bearerToken, describeTokenError, isAllowedEmail, requireAdmin }
