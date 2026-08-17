import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { OAuthException } from '@/lib/errors'
import { describeProviders } from '@/providers'

import { clientCors } from '@/middleware/cors'

/* Routes */
import admin from '@/routes/admin'
import authorize from '@/routes/authorize'
import google from '@/routes/google'
import introspect from '@/routes/introspect'
import logout from '@/routes/logout'
import magicLink from '@/routes/magic-link'
import me from '@/routes/me'
import token from '@/routes/token'
import userinfo from '@/routes/userinfo'
import wellKnown from '@/routes/well-known'

const app = new Hono<AppEnv>()

// Client applications live on their own domains, so the endpoints a browser calls directly answer
// cross-origin requests from any origin a registered client actually uses. See middleware/cors.ts.
app.use('*', clientCors)

// Hono's c.json() omits charset, which mangles non-ASCII bytes on clients that default to Latin-1.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
})

// Nothing this Worker returns is cacheable by a shared cache: every response is either a token, a
// redirect carrying a one-time code, or user-specific data. The two discovery endpoints opt back in
// explicitly with their own Cache-Control.
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

app.onError((err, c) => {
  // OAuth clients parse `{ error, error_description }` (RFC 6749 §5.2); everything else in this
  // monorepo answers with `{ code, error }`. Both shapes are kept, chosen by error type.
  if (err instanceof OAuthException) {
    return c.json({ error: err.code, error_description: err.description }, err.status)
  }
  const status = err instanceof HTTPException ? err.status : 500
  if (status >= 500) {
    console.error('unhandled error', err)
  }
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
    issuer: v.string(),
    providers: v.array(
      v.object({
        name: v.string(),
        display_name: v.string(),
        initiation: v.string(),
        start_path: v.string(),
        available: v.boolean(),
      }),
    ),
  }),
})

app.get(
  '/',
  describeRoute({
    description:
      'Status of the auth service and the authentication providers it exposes. `available` is false for a provider whose secrets are not configured on this deployment.',
    tags: ['General'],
    responses: {
      200: {
        description: 'The auth service is operational',
        content: { 'application/json': { schema: resolver(rootResponseSchema) } },
      },
    },
  }),
  (c) =>
    c.json({
      code: 200,
      data: {
        message: 'Hello, Auth!',
        issuer: c.env.AUTH_ISSUER,
        providers: describeProviders(c.env),
      },
    }),
)

app.route('/', wellKnown)
app.route('/', authorize)
app.route('/', magicLink)
app.route('/', google)
app.route('/', token)
app.route('/', userinfo)
app.route('/', introspect)
app.route('/', logout)
app.route('/', me)
app.route('/admin', admin)

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Auth API',
        version: '1.0.0',
        description:
          'Centralized authentication for franciscosolis.cl and its services. Sign-in is an OAuth 2.0 authorization code flow with PKCE, available through two providers (magic link and Google), and issues EdDSA-signed access tokens that any service can verify offline against /.well-known/jwks.json.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token obtained from POST /oauth/token.',
          },
        },
      },
    },
    // The discovery endpoints end in `.json` / contain dots, which the default static-file
    // heuristic would drop from the document.
    excludeStaticFile: false,
    exclude: ['/openapi.json'],
  }),
)

export default app
