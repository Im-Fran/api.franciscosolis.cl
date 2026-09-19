import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { Agent, AppEnv, Env } from '@/env'
import { AGENT_PERMISSION } from '@/lib/config'
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
      // Everything else is ours (JWKS unreachable, no matching key) and carries no credential.
      return error instanceof Error ? error.message : 'unknown error'
  }
}

const allowedDomains = (env: Env) =>
  env.SUPPORT_ALLOWED_EMAIL_DOMAINS.split(',')
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
 * Gate for `/admin/*`: the support team's half of this Worker.
 *
 * Four things have to hold, and the fourth is new for this monorepo. The token must be valid,
 * unexpired and minted for a client application in `SUPPORT_ALLOWED_AUDIENCES`; the address on it
 * must have been verified by its provider; that address must belong to an allowed domain; and the
 * token must carry the `support:agent` permission.
 *
 * `apps/cms` deliberately stops at the domain check and never looks at `permissions`; `apps/marketplace` is the other Worker that does check one.
 * This Worker cannot, because tickets are *assignable to people*, and "assign to a person" only
 * means something if there is a defined set of people. Under a domain check alone that set is
 * "everyone with a company address", which is not a roster. `apps/auth` resolves roles and
 * permissions per client application, so a distinct audience plus a granted permission is exactly
 * the mechanism that produces one — and it is why the support console is registered as its own
 * application rather than reusing the CMS's, which is the same reason `apps/marketplace` was given one of its own.
 *
 * The cost, inherited from `lib/jwks.ts`: `permissions` is a snapshot taken when the token was
 * minted, so revoking an agent takes effect within one access-token lifetime (15 minutes) rather
 * than instantly. The domain check is evaluated on every request and is the harder boundary.
 */
const requireAgent = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new HTTPException(401, { message: 'A Bearer access token is required' })
  }

  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token, c.env.SUPPORT_ALLOWED_AUDIENCES)
  } catch (error) {
    throw new HTTPException(401, { message: `Invalid access token: ${describeTokenError(error)}` })
  }

  // An unverified address proves nothing about who is holding it, and the whole gate below is an
  // assertion about the address.
  if (!claims.email_verified) {
    throw new HTTPException(403, { message: 'This account has no verified email address' })
  }
  if (!isAllowedEmail(c.env, claims.email)) {
    throw new HTTPException(403, { message: 'This account is not allowed into the support console' })
  }
  if (!(claims.permissions ?? []).includes(AGENT_PERMISSION)) {
    throw new HTTPException(403, { message: 'This account is missing the support:agent permission' })
  }

  c.set('agent', toAgent(claims))

  await next()
})

/** Builds the context value every `/admin` handler reads. */
const toAgent = (claims: AccessTokenClaims): Agent => ({
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

/**
 * Second-tier gate for the handful of operations that reshape the service rather than answer a
 * ticket: the label catalogue, help-centre content and the AI assistant. Applied per route on top of
 * `requireAgent`, never instead of it.
 */
const requirePermission = (permission: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const agent = c.get('agent')
    if (!agent.permissions.includes(permission)) {
      throw new HTTPException(403, { message: `This account is missing the ${permission} permission` })
    }
    await next()
  })

export { bearerToken, describeTokenError, isAllowedEmail, requireAgent, requirePermission, toAgent }
