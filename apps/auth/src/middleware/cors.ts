import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { getDb } from '@/db/client'
import { applications } from '@/db/schema'
import type { AppEnv } from '@/env'
import { parseStringList } from '@/services/applications'

/**
 * Cross-origin access to the endpoints a browser-based client has to call itself.
 *
 * The gateway in `apps/api` keeps a hard-coded origin allowlist, which is right for the rest of the
 * API but cannot work here: the whole point of this Worker is to authenticate applications that
 * live on domains it does not know at build time. So the allowlist is the database instead — an
 * origin is allowed if some active client registered a redirect URI there, or listed it explicitly
 * in `allowed_origins`. Registering a client is already the act of trusting it; this makes that one
 * decision cover CORS too, instead of a second list that can silently disagree with the first.
 *
 * Credentials are never allowed: every one of these endpoints authenticates with a bearer token or
 * a client secret in the body, never with a cookie, so `Access-Control-Allow-Credentials` would
 * only widen what a hostile page could do with an origin that happens to be on the list.
 */
const collectAllowedOrigins = async (c: { env: AppEnv['Bindings'] }): Promise<Set<string>> => {
  const rows = await getDb(c.env)
    .select({ redirectUris: applications.redirectUris, allowedOrigins: applications.allowedOrigins })
    .from(applications)
    .where(eq(applications.isActive, true))

  const origins = new Set<string>()
  for (const row of rows) {
    for (const uri of parseStringList(row.redirectUris)) {
      try {
        origins.add(new URL(uri).origin)
      } catch {
        // A redirect URI that no longer parses cannot match one at authorization time either.
      }
    }
    for (const origin of parseStringList(row.allowedOrigins)) {
      origins.add(origin)
    }
  }
  return origins
}

/**
 * Endpoints a browser client legitimately calls cross-origin: everything a front-end reaches with
 * `fetch` rather than by navigating to it. `CORS_SUBTREES` covers the areas whose paths carry an
 * identifier or a document name; `CORS_ENDPOINTS` is matched exactly.
 *
 * The admin API is here because the sign-in front-end also *is* the administration front-end, on
 * its own domain. Nothing in this Worker authenticates ambiently — every one of these endpoints
 * wants a bearer token or a client secret, never a cookie — so letting an origin send the request
 * buys an attacker nothing it could not already do from curl. The guard that matters is
 * `requirePermission`, not the origin.
 *
 * Absent, and deliberately so, is everything the browser *navigates* to: `/oauth/authorize` and
 * the two provider callbacks answer with a redirect carrying a one-time code, and a top-level
 * navigation is not a cross-origin request, so CORS on them would only invite someone to try
 * reading that redirect with `fetch`.
 */
const CORS_ENDPOINTS = [
  '/',
  '/oauth/token',
  '/oauth/revoke',
  '/oauth/introspect',
  '/oauth/userinfo',
  '/oauth/logout',
  '/me',
  '/logout',
  '/magic-link',
]

/** Areas whose every path is called with `fetch`, matched on a segment boundary. */
const CORS_SUBTREES = ['/me', '/admin', '/.well-known']

const isCorsPath = (pathname: string) =>
  CORS_ENDPOINTS.includes(pathname) || CORS_SUBTREES.some((prefix) => pathname.startsWith(`${prefix}/`))

const clientCors = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header('Origin')
  const url = new URL(c.req.url)

  if (!origin || !isCorsPath(url.pathname)) {
    await next()
    return
  }

  const allowed = (await collectAllowedOrigins(c)).has(origin)

  // A preflight is answered here rather than passed on: there is no handler for OPTIONS on these
  // routes, and a 404 would tell the browser nothing useful.
  if (c.req.method === 'OPTIONS') {
    if (!allowed) {
      return c.body(null, 403)
    }
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': c.req.header('Access-Control-Request-Headers') ?? 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    })
  }

  await next()

  if (allowed) {
    c.res.headers.set('Access-Control-Allow-Origin', origin)
    c.res.headers.set('Access-Control-Expose-Headers', 'Content-Type, WWW-Authenticate')
  }
  // Set even when the origin is refused, so a shared cache never serves one origin's answer to
  // another.
  c.res.headers.append('Vary', 'Origin')
})

export { clientCors, collectAllowedOrigins, isCorsPath }
