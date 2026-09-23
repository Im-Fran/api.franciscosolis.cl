import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from '@/env'
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
 * token in several of its error messages, which would echo a live credential into a response body;
 * the class name says everything the caller needs. Same mapping as `apps/support`.
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

/**
 * Gate for everything under `/me`: a valid token minted for an allowed audience, and nothing else.
 *
 * No email-domain check and no permission, unlike the editorial Workers — there is nothing here but
 * the caller's own inbox, and every query below is scoped to the token's `sub`. That scoping *is*
 * the authorization, which is why no handler ever takes a user id from the request.
 *
 * An unverified address is still let in: the inbox is keyed by account, not by address. It is just
 * not recorded as somewhere to send email (`services/recipients.ts` only learns an address a
 * provider vouched for), since mailing an address nobody proved they own is how a digest ends up in
 * a stranger's inbox.
 */
const requireUser = createMiddleware<AppEnv>(async (c, next) => {
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

  c.set('user', {
    id: claims.sub,
    email: claims.email_verified && claims.email ? claims.email.toLowerCase() : null,
    name: claims.name ?? null,
    claims,
  })
  await next()
})

export { bearerToken, describeTokenError, requireUser }
