import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv, Env } from '@/env'
import type { AccessTokenClaims } from '@/lib/jwks'
import { verifyAccessToken } from '@/lib/jwks'
import { bearerToken, describeTokenError } from '@/middleware/auth'

/**
 * The buyer's side of the gate, beside `requireEditor`.
 *
 * An account here is not an editor and is never treated as one: it is somebody who signed in to
 * franciscosolis.cl, and the only things it opens are checkout, that account's own purchases and that
 * account's own downloads. The audience list is `PAGES_ACCOUNT_AUDIENCES` — a separate variable from
 * the editorial one on purpose, so widening the website's access can never widen `/admin`'s. There is
 * no domain check and there must not be one: the whole point is that anybody can buy.
 *
 * **This Worker cannot ask whether an address has an account**, exactly as `apps/support` cannot: it
 * has no binding into the auth database and must never get one. So the link between a payment and a
 * person is only ever made while a verified token is in hand — which is why buying requires signing
 * in first, and why "buying creates an SSO account" is the magic-link sign-in on the website doing
 * its usual job rather than anything this Worker provisions.
 */

/** Everything a buyer-facing handler needs to know about the caller. */
type Account = {
  /** `sub` claim: the auth account id. What a purchase is filed under. */
  id: string
  email: string
  name: string | null
  sessionId: string
  /** Client application the token was minted for. */
  applicationId: string
  claims: AccessTokenClaims
}

const toAccount = (claims: AccessTokenClaims): Account => ({
  id: claims.sub,
  email: claims.email.toLowerCase(),
  name: claims.name ?? null,
  sessionId: claims.sid,
  applicationId: claims.aud,
  claims,
})

/** Verifies a buyer token, or throws the 401/403 the routes hand back. */
const readAccount = async (c: Context<AppEnv>): Promise<Account> => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    throw new HTTPException(401, { message: 'A Bearer access token is required' })
  }

  let claims: AccessTokenClaims
  try {
    claims = await verifyAccessToken(c.env, token, c.env.PAGES_ACCOUNT_AUDIENCES)
  } catch (error) {
    throw new HTTPException(401, { message: `Invalid access token: ${describeTokenError(error)}` })
  }

  // A purchase is filed against an address a receipt is sent to and support is given on, so an
  // unverified one proves nothing the row is about.
  if (!claims.email_verified) {
    throw new HTTPException(403, { message: 'This account has no verified email address' })
  }

  return toAccount(claims)
}

/** Gate for the routes that are meaningless without an account: checkout, `/me/*`. */
const requireAccount = createMiddleware<AppEnv>(async (c, next) => {
  c.set('account', await readAccount(c))
  await next()
})

/**
 * Reads an account when one was sent, and lets the request through when it was not.
 *
 * This is what the download routes use, and the asymmetry is the feature: a free build and an
 * optional-pay build are downloadable by anybody, and asking for a token first would put a sign-in
 * wall in front of software that does not need one. A *bad* token is also let through rather than
 * refused — the caller is then simply anonymous, which grants strictly less. Anything that actually
 * needs the identity (a paid application, a purchase history) reaches for `requireAccount` instead.
 */
const optionalAccount = createMiddleware<AppEnv>(async (c, next) => {
  const account = await tryAccount(c)
  if (account) {
    c.set('account', account)
  }
  await next()
})

/** `readAccount` that answers null instead of throwing, for the optional path above. */
const tryAccount = async (c: Context<AppEnv>): Promise<Account | null> => {
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) {
    return null
  }
  try {
    const claims = await verifyAccessToken(c.env, token, (c.env as Env).PAGES_ACCOUNT_AUDIENCES)
    return claims.email_verified ? toAccount(claims) : null
  } catch {
    return null
  }
}

export { optionalAccount, readAccount, requireAccount, toAccount, tryAccount }
export type { Account }
