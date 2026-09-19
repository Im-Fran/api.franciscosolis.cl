import { Hono } from 'hono'
import PostalMime from 'postal-mime'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import type { AppEnv, Env } from '@/env'
import {
  MESSAGE_KIND,
  TICKET_EVENTS,
  TICKET_PRIORITY,
  TICKET_SOURCE,
  TICKET_STATUS,
  TRANSLATION,
} from '@/lib/config'
import { DEFAULT_LOCALE, LOCALES } from '@/lib/locales'

import { enrichTicket, ingestEmail } from '@/services/inbound'
import type { InboundMessage } from '@/services/inbound'
import { readBody } from '@/lib/mime'
import { INBOUND } from '@/lib/config'
import { sweepNotifications } from '@/services/notifications'

/* Routes */
import admin from '@/routes/admin'
import help from '@/routes/help'
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
    translation: v.object({
      /** Whether machine-translation drafts are offered. False would mean the console hides the button. */
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
        // Advertised for the same reason as the locale list: the console's translation modal only
        // offers to draft a field with Workers AI when the service it is talking to says it can,
        // and only up to the length that service will actually accept.
        translation: {
          ai: true,
          max_source_chars: TRANSLATION.maxSourceChars,
        },
      },
    }),
)

app.route('/', tickets)
app.route('/', me)
app.route('/', help)
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

/**
 * Mail arriving at soporte@ / support@, dispatched here by Cloudflare Email Routing.
 *
 * Deliberately thin. Everything that decides anything lives in `src/services/inbound.ts`, because
 * miniflare cannot dispatch an email event: a rule that only exists inside this handler is a rule
 * the suite cannot reach. What is left here is the part that needs a real `ForwardableEmailMessage` —
 * the size guard, the parse, and `setReject`.
 *
 * The size check comes before `message.raw` is touched on purpose: the point of refusing a 40 MB
 * message is not to store it, and buffering it to find out how big it is defeats that.
 */
const handleEmail: EmailExportedHandler<Env> = async (message, env, ctx) => {
  if (message.rawSize > INBOUND.maxBytes) {
    message.setReject('Message too large')
    return
  }

  const inboxes = env.SUPPORT_INBOX_ADDRESSES.split(',').map((entry) => entry.trim().toLowerCase())
  // Lowercased for the comparison below and for storage. That is safe because the reply routing key
  // is lowercase hex — see `generateRoutingKey` — which is exactly why it is not base64url.
  const to = message.to.trim().toLowerCase()
  if (!inboxes.includes(to) && !to.startsWith('reply+')) {
    message.setReject('Unknown recipient')
    return
  }

  const parsed = await PostalMime.parse(message.raw)
  const inbound: InboundMessage = {
    messageId: message.headers.get('message-id') ?? parsed.messageId ?? null,
    from: message.from,
    to,
    subject: parsed.subject ?? message.headers.get('subject') ?? null,
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    date: message.headers.get('date'),
    inReplyTo: message.headers.get('in-reply-to') ?? parsed.inReplyTo ?? null,
    references: [message.headers.get('references') ?? parsed.references ?? ''].filter(Boolean),
    // Metadata only. The bytes are not stored — see `attachmentNotice` in services/inbound.ts.
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? 'attachment',
      mime_type: attachment.mimeType ?? 'application/octet-stream',
      size: attachment.content instanceof ArrayBuffer ? attachment.content.byteLength : 0,
    })),
    rawSize: message.rawSize,
  }

  const db = getDb(env)
  const result = await ingestEmail(db, env, inbound)

  if (result.outcome === 'rejected') {
    // Refused at SMTP level, which is the notification. An auto-reply here would be a backscatter
    // amplifier, since `From` on a message worth refusing is usually forged.
    message.setReject(result.reason)
    return
  }

  if (result.outcome === 'created') {
    // The model runs after the ticket exists, so nothing it does can lose the email.
    ctx.waitUntil(
      enrichTicket(db, env, result.ticket.id, result.inboundId, readBody({ text: inbound.text, html: inbound.html }).text),
    )
  }
}

/**
 * The deferred-reply sweep, run by the cron in `wrangler.jsonc`.
 *
 * Everything it does lives in `src/services/notifications.ts`; this is the adapter. Keeping the
 * handler this thin is what makes the rule testable at all — miniflare will happily dispatch a
 * scheduled event, but reasoning about a 30-minute deadline is far easier against a function you can
 * hand a `Date` to than against a cron you have to wait for.
 */
const handleScheduled: ExportedHandlerScheduledHandler<Env> = async (controller, env, ctx) => {
  ctx.waitUntil(
    sweepNotifications(getDb(env), env, new Date(controller.scheduledTime)).then((result) => {
      // One line per run, which is what makes "did anybody get told" answerable from the logs alone.
      console.log('notification sweep', JSON.stringify(result))
    }),
  )
}

/**
 * This Worker has three entry points, and only one of them comes through the gateway.
 *
 * `fetch` is proxied from `apps/api` at `/support/*` like every other internal Worker here. `email`
 * is dispatched straight to this script by Cloudflare Email Routing, and `scheduled` by the cron —
 * neither passes through `apps/api`, and neither can. That is the one documented exception to this
 * monorepo's "internal Workers are reached only through the gateway" rule, and it is why the
 * `workers_dev` and routing configuration here must not be "tidied up": doing so silently removes
 * the inbound half of the product while every test still passes.
 */
export default {
  fetch: app.fetch,
  email: handleEmail,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>

export { app }
