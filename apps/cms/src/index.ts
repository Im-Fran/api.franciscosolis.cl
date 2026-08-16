import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { COLLECTION_NAMES } from '@/lib/collections'

/* Routes */
import admin from '@/routes/admin'
import content from '@/routes/content'
import legal from '@/routes/legal'

const app = new Hono<AppEnv>()

// Hono's c.json() omits charset, which mangles non-ASCII bytes on clients that default to Latin-1.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
})

// Published content is public and worth caching briefly; everything else is either editorial or
// tied to an access token, so it must never sit in a shared cache. The public routes opt back in
// explicitly with their own Cache-Control.
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500
  if (status >= 500) {
    // Logged, never returned. An unexpected error here is usually a Drizzle failure, whose message
    // carries the full statement and its bound parameters — which can include the body and
    // recipients of an email. That belongs in the observability logs, not in a response.
    console.error('unhandled error', err)
    return c.json({ code: status, error: 'Internal Server Error' }, status)
  }
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
    collections: v.array(v.string()),
  }),
})

app.get(
  '/',
  describeRoute({
    description: 'Status of the CMS service and the content collections it manages.',
    tags: ['General'],
    responses: {
      200: {
        description: 'The CMS service is operational',
        content: { 'application/json': { schema: resolver(rootResponseSchema) } },
      },
    },
  }),
  (c) =>
    c.json({
      code: 200,
      data: {
        message: 'Hello, CMS!',
        collections: [...COLLECTION_NAMES],
      },
    }),
)

app.route('/', content)
app.route('/', legal)
app.route('/admin', admin)

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - CMS API',
        version: '1.0.0',
        description:
          'Content management for franciscosolis.cl: the landing page\'s collections (projects, experience, skills, certifications, education), its legal pages, and outgoing email sent through Cloudflare Email Sending. Reads of published content are public; everything under /admin requires an access token from the auth service belonging to an allowed email domain.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token obtained from POST /auth/oauth/token, minted for the CMS client application.',
          },
        },
      },
    },
    exclude: ['/openapi.json'],
  }),
)

export default app
