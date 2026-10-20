import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, openAPIRouteHandler, resolver } from 'hono-openapi'
import * as v from 'valibot'
import type { AppEnv, Env } from '@/env'
import {
  ALERT_KINDS,
  ALERT_STATUSES,
  APP_KINDS,
  APP_MODULES,
  APP_STATES,
  ARCHES,
  BILLING_PERIODS,
  CHANNELS,
  COMMAND_STATUSES,
  COMMAND_TYPES,
  CONTACT_ROLES,
  CONTRACTS,
  CRASH_STATUSES,
  CURRENCIES,
  CYCLE_PERIODS,
  CYCLE_STATUSES,
  GRACE_ALLOWANCES,
  GRACE_MAX_DAYS,
  HEARTBEAT,
  LOG_LEVELS,
  MAINTENANCE_KINDS,
  MAINTENANCE_STATUSES,
  MAINTENANCE_WINDOW_SOURCES,
  MAINTENANCES,
  MESSAGE_DISPLAYS,
  MESSAGE_SEVERITIES,
  PLATFORMS,
  PRESENCE_MODES,
  RELEASE_STATUSES,
  RELEASES,
  ROLLUP,
  SCREENSHOTS,
  TARGET_SCOPES,
  TELEMETRY,
  TICKET_STATUSES,
  UPDATE_REPORT_STATUSES,
  WORK_KINDS,
} from '@/lib/config'
import { ingest } from '@/ingest/index'
import { approval } from '@/panel/approval'
import { ci } from '@/panel/ci'
import { panel } from '@/panel/index'
import { CONTRACT_STATUSES } from '@/services/contracts'
import { runScheduled } from '@/services/maintenance'
import { InstallationSocket } from '@/services/socket'
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
      // Raised on purpose, so its message is written for the caller — a 502 or 503 included, which
      // tell a device to retry later rather than that something broke here.
      return c.json({ code: err.status, error: err.message || 'Error' }, err.status)
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
    log_levels: v.array(v.string()),
    command_types: v.array(v.string()),
    command_statuses: v.array(v.string()),
    target_scopes: v.array(v.string()),
    message_severities: v.array(v.string()),
    message_displays: v.array(v.string()),
    crash_statuses: v.array(v.string()),
    alert_kinds: v.array(v.string()),
    alert_statuses: v.array(v.string()),
    release_statuses: v.array(v.string()),
    update_report_statuses: v.array(v.string()),
    arches: v.array(v.string()),
    release_max_bytes: v.number(),
    currencies: v.array(v.string()),
    billing_periods: v.array(v.string()),
    cycle_periods: v.array(v.string()),
    cycle_statuses: v.array(v.string()),
    contract_statuses: v.array(v.string()),
    grace_allowances: v.array(v.string()),
    work_kinds: v.array(v.string()),
    ticket_statuses: v.array(v.string()),
    maintenance_statuses: v.array(v.string()),
    maintenance_kinds: v.array(v.string()),
    maintenance_window_sources: v.array(v.string()),
    maintenance_limits: v.object({
      min_lead_hours: v.number(),
      resend_after_hours: v.number(),
      reminder_before_hours: v.number(),
      suggest_days: v.number(),
      suggest_count: v.number(),
      security_min_lead_minutes: v.number(),
      min_estimated_minutes: v.number(),
      max_estimated_minutes: v.number(),
      max_windows: v.number(),
    }),
    contract_limits: v.object({
      max_grace_days: v.number(),
      max_notice_days: v.number(),
      default_notice_days: v.number(),
      max_work_log_minutes: v.number(),
      default_security_patch_days: v.number(),
      max_security_patch_days: v.number(),
    }),
    grace_max_days: v.number(),
    screenshot_max_bytes: v.number(),
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
        log_levels: [...LOG_LEVELS],
        command_types: [...COMMAND_TYPES],
        command_statuses: [...COMMAND_STATUSES],
        target_scopes: [...TARGET_SCOPES],
        message_severities: [...MESSAGE_SEVERITIES],
        message_displays: [...MESSAGE_DISPLAYS],
        crash_statuses: [...CRASH_STATUSES],
        alert_kinds: [...ALERT_KINDS],
        alert_statuses: [...ALERT_STATUSES],
        release_statuses: [...RELEASE_STATUSES],
        update_report_statuses: [...UPDATE_REPORT_STATUSES],
        arches: [...ARCHES],
        release_max_bytes: RELEASES.maxArtifactBytes,
        currencies: [...CURRENCIES],
        billing_periods: [...BILLING_PERIODS],
        cycle_periods: [...CYCLE_PERIODS],
        cycle_statuses: [...CYCLE_STATUSES],
        contract_statuses: [...CONTRACT_STATUSES],
        grace_allowances: [...GRACE_ALLOWANCES],
        work_kinds: [...WORK_KINDS],
        ticket_statuses: [...TICKET_STATUSES],
        maintenance_statuses: [...MAINTENANCE_STATUSES],
        maintenance_kinds: [...MAINTENANCE_KINDS],
        maintenance_window_sources: [...MAINTENANCE_WINDOW_SOURCES],
        maintenance_limits: {
          min_lead_hours: MAINTENANCES.minLeadHours,
          resend_after_hours: MAINTENANCES.resendAfterHours,
          reminder_before_hours: MAINTENANCES.reminderBeforeHours,
          suggest_days: MAINTENANCES.suggestDays,
          suggest_count: MAINTENANCES.suggestCount,
          security_min_lead_minutes: MAINTENANCES.securityMinLeadMinutes,
          min_estimated_minutes: MAINTENANCES.minEstimatedMinutes,
          max_estimated_minutes: MAINTENANCES.maxEstimatedMinutes,
          max_windows: MAINTENANCES.maxWindows,
        },
        contract_limits: {
          max_grace_days: CONTRACTS.maxGraceDays,
          max_notice_days: CONTRACTS.maxNoticeDays,
          default_notice_days: CONTRACTS.defaultNoticeDays,
          max_work_log_minutes: CONTRACTS.maxWorkLogMinutes,
          default_security_patch_days: CONTRACTS.defaultSecurityPatchDays,
          max_security_patch_days: CONTRACTS.maxSecurityPatchDays,
        },
        grace_max_days: GRACE_MAX_DAYS,
        screenshot_max_bytes: SCREENSHOTS.maxBytes,
        heartbeat_interval: { min: HEARTBEAT.min, max: HEARTBEAT.max, default: HEARTBEAT.default },
        offline_after_intervals: HEARTBEAT.offlineAfterIntervals,
        retention: { raw_days: TELEMETRY.rawRetentionDays },
        timezone: ROLLUP.timeZone,
      },
    })
  },
)

// CI uploads and the public maintenance approval routes go first: one takes a CI token and the other
// a maintenance link rather than a panel token, so they have to answer before the `/v1` gate would
// refuse them. See `src/panel/ci.ts` and `src/panel/approval.ts`.
panelApp.route('/v1', approval)
panelApp.route('/v1', ci)
panelApp.route('/v1', panel)

panelApp.get(
  '/openapi.json',
  openAPIRouteHandler(panelApp, {
    documentation: {
      info: {
        title: 'FranciscoSolis - Custom Apps API',
        version: '1.0.0',
        description:
          'The panel behind the bespoke apps built for clients: companies and contacts, apps and their keys, installations and their telemetry, and their remote operation — commands and screenshots, flags and remote config, in-app messages, logs, crashes and alerts, releases, contracts and the work log, support tickets and scheduled maintenances. Everything under /v1 needs an access token minted for the `franciscosolis-custom-apps` application, carrying `custom-apps:admin` — except the CI upload, which takes a CI token, and /v1/public/maintenances/*, which a client opens from the approval link in their email without signing in. The client apps themselves use a separate ingest API, documented per app at <ingest>/<appId>/openapi.json.',
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

export { ingestApp, InstallationSocket, panelApp }
