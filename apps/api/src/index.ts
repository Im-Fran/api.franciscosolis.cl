import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { resolveAllowedOrigin } from '@/cors'
import type { Env } from '@/env'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, generateSpecs, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { registerBrandAssets } from '@/brand'
import { mergeRemoteSpecs } from '@/openapi'
import { registerServiceProxies, remoteSpecComponents } from '@/proxy'
import { CORS_DELEGATED_PREFIXES, SERVICE_MODULE_NAMES } from '@/services'

const app = new Hono<{ Bindings: Env }>()

const gatewayCors = cors({
  // The allowlist itself lives in `src/cors.ts`, with the reasoning for each shape it accepts.
  origin: (origin) => resolveAllowedOrigin(origin),
  // The auth module needs the write verbs: sign-in, token exchange and the admin API are all
  // POST/PATCH/DELETE. Origins stay locked down to what `src/cors.ts` accepts.
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Type'],
  maxAge: 600,
  credentials: false,
})

// One module answers cross-origin requests itself and is skipped here — see `ownsCors` in
// src/services.ts. Running both would mean this middleware overwriting the module's decision with
// the fixed allowlist, which is exactly the answer that module exists to avoid giving.
app.use('*', async (c, next) => {
  const { pathname } = new URL(c.req.url)
  if (CORS_DELEGATED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return next()
  }
  return gatewayCors(c, next)
});

// ponytail: Hono's c.json() omits charset, which mangles non-ASCII bytes on clients that default to Latin-1
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') !== 'application/json') {
    return
  }
  // A Response that came back from a service binding carries immutable headers, so it has to be
  // rebuilt rather than edited in place — writing to it directly is silently dropped.
  const response = new Response(c.res.body, c.res)
  response.headers.set('Content-Type', 'application/json; charset=UTF-8')
  c.res = response
})

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
});

const rootResponseSchema = v.object({
  status: v.literal(200),
  data: v.object({
    message: v.string(),
    modules: v.array(v.string()),
  }),
})

app.get(
  '/',
  describeRoute({
    description: 'API status and list of available modules',
    tags: ['General'],
    responses: {
      200: {
        description: 'The API is up',
        content: {
          'application/json': { schema: resolver(rootResponseSchema) },
        },
      },
    },
  }),
  (c) => c.json({
    status: 200,
    data: {
      message: "¡Hello, API!",
      modules: SERVICE_MODULE_NAMES,
    }
  })
)

// One `ALL /<module>/*` proxy per entry in the service registry (`src/services.ts`).
registerServiceProxies(app)

// `GET /brand/lockup.png`. The only bytes this gateway owns, and it owns them because the emails
// the other Workers send need the logo at a public URL (see `src/brand.ts`).
registerBrandAssets(app)

app.get('/openapi.json', async (c) => {
  const spec = await generateSpecs(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Rest API',
        version: '1.0.0',
        description: 'Public API for franciscosolis.cl and its services. This API is designed to be consumed by the franciscosolis.cl website and its associated services, providing a seamless integration experience.',
      },
    },
  }, c)

  await mergeRemoteSpecs(spec, remoteSpecComponents(c.env))

  return c.json(spec)
})

export default app
