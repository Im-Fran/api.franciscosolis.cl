import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv, Env } from '@/env'
import { EDITOR_PERMISSION } from '@/lib/config'
import type { AccessTokenClaims } from '@/lib/jwks'
import { verifyAccessToken } from '@/lib/jwks'

/** Everything an authenticated editorial handler needs to know about the caller. */
type Editor = {
  id: string
  email: string
  name: string | null
  picture: string | null
  sessionId: string
  clientId: string
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
  env.MARKETPLACE_ALLOWED_EMAIL_DOMAINS.split(',')
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
 * Four things have to hold: the token is a valid, unexpired token signed by the auth Worker and
 * minted for an accepted client application (`verifyAccessToken`), the address on it was verified
 * by its provider, that address belongs to an allowed domain, and the token carries
 * `marketplace:editor`. The domain check is the broad access rule — this marketplace is run by
 * @franciscosolis.cl staff and everyone else is refused even with a flawless token — and the
 * permission is what narrows "everyone with a company address" down to a roster.
 *
 * Unlike `apps/pages` before it, the accepted audience is **this Worker's own client application**
 * rather than the CMS's. It has a front-end of its own, so it has an application of its own, which
 * is also the only mechanism `apps/auth` offers for resolving a permission — see `EDITOR_PERMISSION`
 * in `src/lib/config.ts`.
 */
const requireEditor = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new HTTPException(401, { message: 'A Bearer access token is required' })
  }

  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token, c.env.MARKETPLACE_ALLOWED_AUDIENCES)
  } catch (error) {
    throw new HTTPException(401, { message: `Invalid access token: ${describeTokenError(error)}` })
  }

  // An unverified address proves nothing about who is holding it, and the whole gate below is an
  // assertion about the address.
  if (!claims.email_verified) {
    throw new HTTPException(403, { message: 'This account has no verified email address' })
  }
  if (!isAllowedEmail(c.env, claims.email)) {
    throw new HTTPException(403, { message: 'This account is not allowed into the marketplace console' })
  }
  if (!(claims.permissions ?? []).includes(EDITOR_PERMISSION)) {
    throw new HTTPException(403, { message: `This account is missing the ${EDITOR_PERMISSION} permission` })
  }

  c.set('editor', {
    id: claims.sub,
    email: claims.email.toLowerCase(),
    name: claims.name ?? null,
    picture: claims.picture ?? null,
    sessionId: claims.sid,
    clientId: claims.aud,
    roles: claims.roles ?? [],
    permissions: claims.permissions ?? [],
    claims,
  })

  await next()
})

/**
 * Second-tier gate, applied per route on top of `requireEditor` and never instead of it.
 *
 * Nothing uses it today — `marketplace:editor` is the whole roster. It exists because the split it
 * would express is already visible in the routes: editing a product page and refunding a payment
 * are not the same authority, and the day they need separating it should be a middleware on a
 * handful of routes rather than a second gate somebody writes from scratch. Mirrors
 * `requirePermission` in `apps/support`.
 */
const requirePermission = (permission: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const editor = c.get('editor')
    if (!editor.permissions.includes(permission)) {
      throw new HTTPException(403, { message: `This account is missing the ${permission} permission` })
    }
    await next()
  })

export { bearerToken, describeTokenError, isAllowedEmail, requireEditor, requirePermission }
export type { Editor }
