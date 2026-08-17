import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '@/env'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, generateSpecs, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { mergeRemoteSpecs } from '@/openapi'
import { registerServiceProxies, remoteSpecComponents } from '@/proxy'
import { SERVICE_MODULE_NAMES } from '@/services'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: (origin) => {
    if (origin?.endsWith('localhost:5173') || origin?.endsWith('franciscosolis.workers.dev') || origin?.endsWith('franciscosolis.cl')) {
      return origin
    }
    return 'https://franciscosolis.cl'
  },
  // The auth module needs the write verbs: sign-in, token exchange and the admin API are all
  // POST/PATCH/DELETE. Origins stay locked down to the list above.
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Type'],
  maxAge: 600,
  credentials: false,
}));

// ponytail: Hono's c.json() omits charset, which mangles non-ASCII bytes on clients that default to Latin-1
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
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
