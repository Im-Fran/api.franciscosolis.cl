import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '@/env'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, generateSpecs, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { mergeRemoteSpecs } from '@/openapi'

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
    description: 'Estado de la API y listado de módulos disponibles',
    tags: ['General'],
    responses: {
      200: {
        description: 'La API está operativa',
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
      modules: ["landing", "auth"]
    }
  })
)

app.all(
  '/landing/*',
  describeRoute({
    description: 'Proxy hacia el Worker del sitio landing (franciscosolis.cl)',
    tags: ['Landing'],
    responses: {
      200: { description: 'Respuesta reenviada desde el Worker landing' },
    },
  }),
  (c) => {
    const url = new URL(c.req.url)
    url.pathname = url.pathname.replace(/^\/landing/, '') || '/'
    return c.env.LANDING.fetch(new Request(url, c.req.raw), {
      headers: {
        'Content-Type': c.req.header('Content-Type') || '',
        'Authorization': c.req.header('Authorization') || '',
      }
    })
  }
)

app.all(
  '/auth/*',
  describeRoute({
    description: 'Proxy hacia el Worker de autenticación centralizada',
    tags: ['Auth'],
    responses: {
      200: { description: 'Respuesta reenviada desde el Worker auth' },
    },
  }),
  (c) => {
    const url = new URL(c.req.url)
    url.pathname = url.pathname.replace(/^\/auth/, '') || '/'
    // Se reenvía la Request completa (método, cabeceras y cuerpo) en vez de reconstruir solo
    // algunas cabeceras: el módulo auth necesita CF-Connecting-IP y User-Agent para su bitácora,
    // y el cuerpo para los POST. `redirect: 'manual'` evita que los 302 que llevan el authorization
    // code se sigan dentro del Worker en lugar de llegar al navegador.
    return c.env.AUTH.fetch(new Request(new Request(url, c.req.raw), { redirect: 'manual' }))
  }
)

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

  // Nuevos componentes internos solo necesitan una entrada más aquí.
  await mergeRemoteSpecs(spec, [
    { prefix: '/landing', fetchSpec: () => c.env.LANDING.fetch(new Request('https://landing.internal/openapi.json')) },
    { prefix: '/auth', fetchSpec: () => c.env.AUTH.fetch(new Request('https://auth.internal/openapi.json')) },
  ])

  return c.json(spec)
})

export default app
