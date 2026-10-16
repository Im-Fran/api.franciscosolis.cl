import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv, Env } from '@/env'
import {
  APP_KINDS,
  APP_MODULES,
  APP_STATES,
  CHANNELS,
  CONTACT_ROLES,
  HEARTBEAT,
  PLATFORMS,
  PRESENCE_MODES,
  ROLLUP,
  TELEMETRY,
} from '@/lib/config'
import { ingest } from '@/ingest/index'
import { panel } from '@/panel/index'
import { runScheduled } from '@/services/rollup'
import { consumeTelemetry } from '@/services/telemetry'

/**
 * The custom-apps Worker: the panel API behind the gateway, and the ingest surface client apps
 * report to. One database, two front doors, chosen by hostname in `fetch` below.
 */

/** Charset, cache policy and error shape — the same for both surfaces. */
const withConventions = (app: Hono<AppEnv>) => {
  // Hono's c.json() omits charset, which mangles non-ASCII on clients that default to Latin-1 — and
  // most of what is stored here (names, addresses, messages to show a customer) is Spanish.
  app.use('*', async (c, next) => {
    await next()
    if (c.res.headers.get('Content-Type') === 'application/json') {
      c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
    }
  })

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // A middleware that built its own response (a 401 with `WWW-Authenticate`, a 429 with
      // `Retry-After`) has headers a plain JSON body would drop.
      if (err.res) {
        return err.getResponse()
      }
      if (err.status < 500) {
        return c.json({ code: err.status, error: err.message || 'Error' }, err.status)
      }
    }
    // Logged, never returned: a Drizzle failure message carries the statement and its parameters,
    // which here are clients' names, addresses and phone numbers.
    console.error('unhandled error', err)
    return c.json({ code: 500, error: 'Internal Server Error' }, 500)
  })

  app.notFound((c) => c.json({ code: 404, error: 'Not Found' }, 404))
  return app
}

/* ── The panel host (through the gateway) ──────────────────────────────────── */

const panelApp = withConventions(new Hono<AppEnv>())

// Clients' details and device data: nothing here may sit in a shared cache, the root excepted.
panelApp.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
    ingest_base_url: v.string(),
    kinds: v.array(v.string()),
    platforms: v.array(v.string()),
    states: v.array(v.string()),
    channels: v.array(v.string()),
    presence_modes: v.array(v.string()),
    modules: v.array(v.string()),
    contact_roles: v.array(v.string()),
    heartbeat_interval: v.object({ min: v.number(), max: v.number(), default: v.number() }),
    offline_after_intervals: v.number(),
    retention: v.object({ raw_days: v.number() }),
    timezone: v.string(),
  }),
})

panelApp.get(
  '/',
  describeRoute({
    description: 'Status of the custom-apps service and the vocabularies the panel builds its forms from.',
    tags: ['General'],
    responses: { 200: { description: 'The service is operational', content: { 'application/json': { schema: resolver(rootResponseSchema) } } } },
  }),
  (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    return c.json({
      code: 200 as const,
      data: {
        message: 'Hello, Custom Apps!',
        ingest_base_url: c.env.INGEST_PUBLIC_URL,
        kinds: [...APP_KINDS],
        platforms: [...PLATFORMS],
        states: [...APP_STATES],
        channels: [...CHANNELS],
        presence_modes: [...PRESENCE_MODES],
        modules: [...APP_MODULES],
        contact_roles: [...CONTACT_ROLES],
        heartbeat_interval: { min: HEARTBEAT.min, max: HEARTBEAT.max, default: HEARTBEAT.default },
        offline_after_intervals: HEARTBEAT.offlineAfterIntervals,
        retention: { raw_days: TELEMETRY.rawRetentionDays },
        timezone: ROLLUP.timeZone,
      },
    })
  },
)

panelApp.route('/v1', panel)

panelApp.get(
  '/openapi.json',
  openAPIRouteHandler(panelApp, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Custom Apps API',
        version: '1.0.0',
        description:
          'The panel behind the bespoke apps built for clients: companies and contacts, apps and their keys, installations and their telemetry. Everything under /v1 needs an access token minted for the `franciscosolis-custom-apps` application, carrying `custom-apps:admin`. The client apps themselves use a separate ingest API, documented per app at <ingest>/<appId>/openapi.json.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token from POST /auth/oauth/token, minted for the `franciscosolis-custom-apps` application.',
          },
        },
      },
    },
    exclude: ['/openapi.json'],
  }),
)

/* ── The ingest host ───────────────────────────────────────────────────────── */

const ingestApp = withConventions(new Hono<AppEnv>())
ingestApp.route('/', ingest)

/**
 * Picks the surface for a request.
 *
 * By hostname, not by path, and that is the security property rather than a routing detail: a
 * request through the gateway arrives with the gateway's host and can only ever reach the panel; a
 * request on the ingest host can only ever reach the ingest app, with the base path
 * (`/custom-apps/v1`) stripped. A path cannot smuggle one into the other.
 */
const dispatch = (request: Request, env: Env, ctx: ExecutionContext) => {
  const ingestBase = new URL(env.INGEST_PUBLIC_URL)
  const url = new URL(request.url)
  if (url.host !== ingestBase.host) {
    return panelApp.fetch(request, env, ctx)
  }
  const basePath = ingestBase.pathname.replace(/\/+$/, '')
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return Response.json({ code: 404, error: 'Not Found' }, { status: 404 })
  }
  url.pathname = url.pathname.slice(basePath.length) || '/'
  return ingestApp.fetch(new Request(url, request), env, ctx)
}

const handleQueue: ExportedHandlerQueueHandler<Env, unknown> = async (batch, env) => {
  const counts = await consumeTelemetry(env, batch)
  console.log('telemetry batch', batch.queue, JSON.stringify(counts))
}

const handleScheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  ctx.waitUntil(
    runScheduled(env, new Date(controller.scheduledTime)).then((result) => {
      console.log('custom-apps maintenance', JSON.stringify(result))
    }),
  )
}

export default {
  fetch: dispatch,
  queue: handleQueue,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>

export { ingestApp, panelApp }
