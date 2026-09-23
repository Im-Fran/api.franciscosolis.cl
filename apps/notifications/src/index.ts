import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv, Env } from '@/env'
import { NOTIFICATION_TYPES } from '@/lib/catalog'
import { CATEGORIES, DIGEST, EMAIL_FREQUENCIES, LOCALES } from '@/lib/config'
import { runDigests } from '@/services/digest'
import { consumeBatch } from '@/services/ingest'
import { getVapidKeys } from '@/services/push'

/* Routes */
import me from '@/routes/me'

const app = new Hono<AppEnv>()

// Hono's c.json() omits charset, which mangles non-ASCII on clients that default to Latin-1 — and
// half of what this Worker says is in Spanish.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
})

// Everything here but the root is somebody's own inbox, which must never sit in a shared cache.
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500
  if (status >= 500) {
    // Logged, never returned: a Drizzle failure message carries the statement and its bound
    // parameters, which here are an account id and an email address.
    console.error('unhandled error', err)
    return c.json({ code: status, error: 'Internal Server Error' }, status)
  }
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
    categories: v.array(v.string()),
    types: v.array(v.string()),
    email_frequencies: v.array(v.string()),
    locales: v.array(v.string()),
    digest: v.object({ timezone: v.string(), hour: v.number(), weekly_day: v.string() }),
    push: v.object({ vapid_public_key: v.nullable(v.string()) }),
  }),
})

app.get(
  '/',
  describeRoute({
    description:
      'Status of the notifications service and what a front-end builds its preferences form from: the categories, the email frequencies, when digests go out, and the VAPID public key a browser subscribes with (null when push is not configured).',
    tags: ['General'],
    responses: {
      200: {
        description: 'The service is operational',
        content: { 'application/json': { schema: resolver(rootResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const keys = await getVapidKeys(c.env)
    // Public and identical for everybody, so it may be cached briefly — the website reads it on every
    // page that shows the bell.
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({
      code: 200 as const,
      data: {
        message: 'Hello, Notifications!',
        categories: [...CATEGORIES],
        types: [...NOTIFICATION_TYPES],
        email_frequencies: [...EMAIL_FREQUENCIES],
        locales: [...LOCALES],
        digest: { timezone: DIGEST.timeZone, hour: DIGEST.hour, weekly_day: 'monday' },
        push: { vapid_public_key: keys?.publicKey ?? null },
      },
    })
  },
)

app.route('/', me)

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Notifications API',
        version: '1.0.0',
        description:
          'The in-site notification inbox behind franciscosolis.cl, the preferences that decide what reaches email and push, and the devices registered for Web Push. Everything under /me needs an access token minted for the website.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access token from POST /auth/oauth/token, minted for the `franciscosolis-web` application.',
          },
        },
      },
    },
    exclude: ['/openapi.json'],
  }),
)

/**
 * The queue consumer: every notification this Worker ever creates arrives here. See
 * `src/services/ingest.ts` for why a queue and what makes a redelivery harmless.
 */
const handleQueue: ExportedHandlerQueueHandler<Env, unknown> = async (batch, env) => {
  const counts = await consumeBatch(getDb(env), env, batch)
  console.log('notification batch', batch.queue, JSON.stringify(counts))
}

/**
 * The hourly digest clock. A thin adapter over `runDigests`, which takes a `Date` so the suite can
 * ask "what happens at 09:00 on a Monday in Santiago" without waiting for one.
 */
const handleScheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  ctx.waitUntil(
    runDigests(getDb(env), env, new Date(controller.scheduledTime)).then((result) => {
      if (result.periods.length > 0) {
        console.log('notification digests', JSON.stringify(result))
      }
    }),
  )
}

/**
 * Three entry points, like `apps/support`, and only `fetch` comes through the gateway: the queue is
 * dispatched by Cloudflare Queues and the cron by the scheduler, and neither passes through `apps/api`.
 */
export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>

export { app }
