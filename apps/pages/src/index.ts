import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv } from '@/env'
import { TRANSLATION } from '@/lib/config'
import { LINK_KINDS } from '@/lib/links'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'
import { AMOUNT_LIMITS, CURRENCY, PRICING_MODES } from '@/lib/pricing'
import { TAB_KEYS, TABS } from '@/lib/tabs'

/* Routes */
import admin from '@/routes/admin'
import applications from '@/routes/applications'
import downloads from '@/routes/downloads'
import payments from '@/routes/payments'
import store from '@/routes/store'

const app = new Hono<AppEnv>()

// Hono's c.json() omits charset, which mangles non-ASCII bytes on clients that default to Latin-1.
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type') === 'application/json') {
    c.res.headers.set('Content-Type', 'application/json; charset=UTF-8')
  }
})

// Published pages are public and worth caching briefly; everything else is either editorial or tied
// to an access token, so it must never sit in a shared cache. The public routes opt back in
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
    // carries the full statement and its bound parameters — which for this Worker means the body of
    // a page an editor had not published yet. That belongs in the observability logs.
    console.error('unhandled error', err)
    return c.json({ code: status, error: 'Internal Server Error' }, status)
  }
  return c.json({ code: status, error: err.message || 'Internal Server Error' }, status)
})

const rootResponseSchema = v.object({
  code: v.literal(200),
  data: v.object({
    message: v.string(),
    tabs: v.array(v.object({ key: v.string(), name: v.string(), description: v.string(), source: v.string() })),
    link_kinds: v.array(v.string()),
    locales: v.array(v.string()),
    default_locale: v.string(),
    pricing_modes: v.array(v.string()),
    currency: v.string(),
    minimum_amount: v.number(),
    translation: v.object({
      /** Whether machine-translation drafts are offered. False would mean the editor hides the button. */
      ai: v.boolean(),
      /** Longest source text `POST /admin/translate` accepts, in characters. */
      max_source_chars: v.number(),
    }),
  }),
})

app.get(
  '/',
  describeRoute({
    description:
      'Status of the standalone application pages service, the tabs a page can be built from, the link kinds it renders and the locales it publishes in.',
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
        message: 'Hello, Standalone App Pages!',
        // Advertised so an editorial front-end builds its tab pickers and its link-kind dropdown
        // from the service rather than from a list of its own that drifts the day a tab is added.
        tabs: TAB_KEYS.map((key) => ({ key, ...TABS[key] })),
        link_kinds: [...LINK_KINDS],
        locales: [...LOCALES],
        default_locale: DEFAULT_LOCALE,
        // Advertised for the same reason the tabs are: the pricing picker in the editor and the
        // payment modal on the website both build themselves from this rather than from a copy of the
        // list that drifts the day a mode is added.
        pricing_modes: [...PRICING_MODES],
        currency: CURRENCY,
        minimum_amount: AMOUNT_LIMITS.min,
        // Advertised for the same reason as the locale list: the editor's translation modal only
        // offers to draft a field with Workers AI when the service it is talking to says it can,
        // and only up to the length that service will actually accept.
        translation: {
          ai: true,
          max_source_chars: TRANSLATION.maxSourceChars,
        },
      },
    }),
)

app.route('/', applications)
app.route('/', store)
app.route('/', downloads)
app.route('/', payments)
app.route('/admin', admin)

app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Standalone App Pages API',
        version: '1.0.0',
        description:
          'Standalone pages for the applications built at franciscosolis.cl, all to one house standard: a banner, a tab bar and the content behind it. Reads of published pages are public and take an optional `?locale`; everything under /admin requires an access token from the auth service belonging to an allowed email domain. An application can also be paid for or donated to through MercadoPago, in which case its downloads are served by this Worker against a per-request ticket rather than from a bucket URL — see the Store and Downloads tags.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'Access token obtained from POST /auth/oauth/token. Editorial routes (/admin) need one minted for the CMS client application; the store routes (checkout, /me/purchases, /me/downloads) take one minted for the website, which is a separate audience list.',
          },
        },
      },
    },
    exclude: ['/openapi.json'],
  }),
)

export default app
