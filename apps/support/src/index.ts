import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import {
  MESSAGE_KIND,
  TICKET_EVENTS,
  TICKET_PRIORITY,
  TICKET_SOURCE,
  TICKET_STATUS,
} from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'

/* Routes */
import admin from '@/routes/admin'
import me from '@/routes/me'
import tickets from '@/routes/tickets'

const app = new Hono<AppEnv>()

// Hono's c.json() omits charset, which mangles non-ASCII bytes on clients that default to Latin-1.
// It matters more here than anywhere else in the monorepo: this Worker's payloads are people's own
// words, in two languages, written by whoever felt like writing them.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
})

// Published help content is public and worth caching briefly; everything else is a ticket, and a
// ticket must never sit in a shared cache. The help routes opt back in explicitly.
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

app.onError((err, c) => {
  const status = err instanceof HTTPException ? err.status : 500
  if (status >= 500) {
    // Logged, never returned — and the stakes are higher here than in the sibling Workers. An
    // unexpected error is usually a Drizzle failure, and a Drizzle failure message carries the
    // statement together with its bound parameters: in this Worker those parameters are a stranger's
    // email address and the text of the problem they wrote in about.
    console.error('unhandled error', err)
    return c.json({ code: status, error: 'Internal Server Error' }, status)
  }
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
    ticket_statuses: v.array(v.string()),
    ticket_priorities: v.array(v.string()),
    ticket_sources: v.array(v.string()),
    message_kinds: v.array(v.string()),
    timeline_events: v.array(v.string()),
    locales: v.array(v.string()),
    default_locale: v.string(),
  }),
})

app.get(
  '/',
  describeRoute({
    description:
      'Status of the support service and the vocabularies a front-end builds its filters from: ticket statuses, priorities, sources, message kinds, timeline events and the languages it publishes in.',
    tags: ['General'],
    responses: {
      200: {
        description: 'The service is operational',
        content: { 'application/json': { schema: resolver(rootResponseSchema) } },
      },
    },
  }),
  (c) =>
    c.json({
      code: 200,
      data: {
        message: 'Hello, Support!',
        // Advertised so the console builds its status filters and its timeline renderer from the
        // service rather than from a copy of these lists that drifts the day one gains a member.
        ticket_statuses: [...TICKET_STATUS],
        ticket_priorities: [...TICKET_PRIORITY],
        ticket_sources: [...TICKET_SOURCE],
        message_kinds: [...MESSAGE_KIND],
        timeline_events: [...TICKET_EVENTS],
        locales: [...LOCALES],
        default_locale: DEFAULT_LOCALE,
      },
    }),
)

app.route('/', tickets)
app.route('/', me)
app.route('/admin', admin)

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Support API',
        version: '1.0.0',
        description:
          'Support tickets and the help centre behind franciscosolis.cl. Opening a ticket is public; reading one needs either the secret from the emailed link or an access token whose verified email is on the ticket; everything under /admin needs an access token from the auth service belonging to an allowed email domain and carrying the support:agent permission.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access token from POST /auth/oauth/token. The support console is minted one for the `franciscosolis-support` application; the website is minted one for `franciscosolis-web`, which is accepted for a person reading their own ticket but never for /admin.',
          },
        },
      },
    },
    exclude: ['/openapi.json'],
  }),
)

export default app
