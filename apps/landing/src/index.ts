import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Env } from '@/env'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'

/* Routes */
import stats from '@/stats'

const app = new Hono<{Bindings: Env}>()

app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
})

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
  }),
})

app.get(
  '/',
  describeRoute({
    description: 'Estado del sitio landing',
    tags: ['General'],
    responses: {
      200: {
        description: 'El sitio landing está operativo',
        content: {
          'application/json': { schema: resolver(rootResponseSchema) },
        },
      },
    },
  }),
  (c) => c.json({
    code: 200,
    data: {
      message: '¡Hello, Landing!'
    }
  })
)

app.route('/stats', stats)

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Landing API',
        version: '1.0.0',
        description: 'Internal API detrás del sitio landing de franciscosolis.cl: estadísticas de GitHub y metadata del sitio.',
      },
    },
  })
)

export default app
