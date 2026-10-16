import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, generateSpecs, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { apps, appKeys, installations } from '@/db/schema'
import type { AppEnv } from '@/env'
import { TELEMETRY, type AppModule } from '@/lib/config'
import { iso } from '@/lib/json'
import { validate } from '@/lib/validate'
import { isUuid } from '@/lib/validation'
import { invalidToken, requireInstallation } from '@/middleware/installation'
import { enroll, enrollBodySchema, refresh, refreshBodySchema, type IssuedTokens } from '@/services/enrollment'
import { effectiveState, heartbeatCredit, hourlyStatements } from '@/services/presence'
import { buildSdk, modulesOf } from '@/services/apps'
import type { AppRow, InstallationRow } from '@/services/serialize'
import { ingestUrls } from '@/services/serialize'
import {
  eventsBodySchema,
  metricsBodySchema,
  snapshotSchema,
  withinWindow,
  type TelemetryMessage,
} from '@/services/telemetry'

/**
 * The ingest surface: what client apps talk to, at `ingest.franciscosolis.cl/custom-apps/v1/:appId`.
 *
 * Mounted by `src/index.ts` only for requests on the ingest host, with the base path already
 * stripped, so every route here starts at `/:appId`. It never sees a panel token and the panel never
 * sees one of these: the two surfaces share a database and nothing else.
 *
 * CORS is open (`*`, no credentials). These endpoints authenticate with a bearer token, never a
 * cookie, so a cross-origin page gains nothing a `curl` would not already have — and a customer's
 * website, on whatever domain it lives, is exactly who has to call them from a browser.
 */
const app = new Hono<AppEnv>()

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86_400,
  }),
)

app.use(
  '*',
  bodyLimit({
    maxSize: TELEMETRY.maxBodyBytes,
    onError: (c) => c.json({ code: 413, error: `Request bodies are limited to ${TELEMETRY.maxBodyBytes} bytes` }, 413),
  }),
)

// Device traffic is never cacheable, with the two public documents as the exception they set themselves.
app.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) {
    c.res.headers.set('Cache-Control', 'no-store')
  }
})

/** Resolves the app in the URL, or 404s. An id that is not even a UUID never reaches the database. */
const requireApp = async (c: { env: AppEnv['Bindings'] }, appId: string | undefined): Promise<AppRow> => {
  const [row] = appId && isUuid(appId)
    ? await getDb(c.env).select().from(apps).where(eq(apps.id, appId)).limit(1)
    : []
  if (!row) {
    throw new HTTPException(404, { message: 'App not found' })
  }
  return row
}

const requireModule = (row: AppRow, module: AppModule) => {
  if (!modulesOf(row).includes(module)) {
    throw new HTTPException(403, { message: `The ${module} module is not enabled for this app` })
  }
}

/** The state an installation is told to obey, in the shape every ingest response carries it. */
const stateFor = (row: AppRow, installation: Pick<InstallationRow, 'stateOverride' | 'stateMessage'> | null) => {
  const override = installation?.stateOverride ?? null
  return {
    state: effectiveState(row.state, override),
    message: override ? (installation?.stateMessage ?? row.stateMessage) : row.stateMessage,
    until: iso(row.stateUntil),
  }
}

const presenceFor = (row: AppRow) => ({ mode: row.presenceMode, interval_seconds: row.heartbeatIntervalSeconds })

const tokenBody = (installationId: string, tokens: IssuedTokens) => ({
  installation_id: installationId,
  access_token: tokens.accessToken,
  access_token_expires_at: tokens.accessTokenExpiresAt.toISOString(),
  refresh_token: tokens.refreshToken,
  refresh_token_expires_at: tokens.refreshTokenExpiresAt.toISOString(),
  token_type: 'Bearer' as const,
})

const stateSchema = v.object({
  state: v.picklist(['active', 'grace', 'maintenance', 'suspended']),
  message: v.nullable(v.string()),
  until: v.nullable(v.string()),
})
const presenceSchema = v.object({ mode: v.string(), interval_seconds: v.number() })
const tokensSchema = v.object({
  installation_id: v.string(),
  access_token: v.string(),
  access_token_expires_at: v.string(),
  refresh_token: v.string(),
  refresh_token_expires_at: v.string(),
  token_type: v.literal('Bearer'),
})

const json = (schema: v.GenericSchema) => ({ 'application/json': { schema: resolver(schema) } })

/* ── Public documents ──────────────────────────────────────────────────────── */

const tooMany = (message: string) =>
  new HTTPException(429, {
    message,
    res: new Response(JSON.stringify({ code: 429, error: message }), {
      status: 429,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Retry-After': '60' },
    }),
  })

/* ── Enrollment ────────────────────────────────────────────────────────────── */

app.post(
  '/:appId/enroll',
  describeRoute({
    operationId: 'enroll',
    summary: 'Enroll this device',
    description:
      'Registers the device as an installation of this app — or, for a `device_id` the app already knows, re-enrolls it — and answers with its tokens. Auto-approved for anybody holding an active app key; the panel flags every new installation for review. Store the tokens in the platform\'s secure store (Keychain, Credential Manager, libsecret, Android Keystore). Rate limited per IP and per app.',
    tags: ['Enrollment'],
    responses: {
      200: { description: 'Re-enrolled: the device was already known', content: json(v.object({ code: v.literal(200), data: tokensSchema })) },
      201: { description: 'Enrolled', content: json(v.object({ code: v.literal(201), data: tokensSchema })) },
      401: { description: 'The app key is unknown, revoked or belongs to another app' },
      403: { description: 'This device was revoked and cannot enroll again' },
      429: { description: 'Too many enrollments; retry after the `Retry-After` header' },
    },
  }),
  validate('json', enrollBodySchema),
  async (c) => {
    const appRow = await requireApp(c, c.req.param('appId'))
    const ip = c.req.header('CF-Connecting-IP') ?? null

    const [byIp, byApp] = await Promise.all([
      c.env.ENROLL_IP_LIMITER.limit({ key: ip ?? 'unknown' }),
      c.env.ENROLL_APP_LIMITER.limit({ key: appRow.id }),
    ])
    if (!byIp.success || !byApp.success) {
      throw tooMany('Too many enrollments, try again in a minute')
    }

    const body = c.req.valid('json')
    const db = getDb(c.env)
    const [key] = await db
      .select()
      .from(appKeys)
      .where(and(eq(appKeys.key, body.app_key), eq(appKeys.appId, appRow.id), eq(appKeys.status, 'active')))
      .limit(1)
    if (!key) {
      throw new HTTPException(401, { message: 'The app key is not valid for this app' })
    }

    const result = await enroll(db, { app: appRow, key, body, ip, userAgent: c.req.header('User-Agent') ?? null })
    const status = result.created ? 201 : 200
    return c.json(
      {
        code: status,
        data: {
          ...tokenBody(result.installation.id, result.tokens),
          presence: presenceFor(appRow),
          state: stateFor(appRow, result.installation),
        },
      },
      status,
    )
  },
)

app.post(
  '/:appId/token/refresh',
  describeRoute({
    operationId: 'refreshToken',
    summary: 'Renew the tokens',
    description:
      'Exchanges the refresh token for a new pair. Both rotate, so a refresh token works once. If this fails with 401, enroll again with the same `device_id`: the installation, its alias and its history are kept.',
    tags: ['Enrollment'],
    responses: {
      200: { description: 'A new pair', content: json(v.object({ code: v.literal(200), data: tokensSchema })) },
      401: { description: 'The refresh token is invalid, used, expired or revoked' },
    },
  }),
  validate('json', refreshBodySchema),
  async (c) => {
    const appRow = await requireApp(c, c.req.param('appId'))
    const result = await refresh(getDb(c.env), appRow.id, c.req.valid('json').refresh_token, c.req.header('CF-Connecting-IP') ?? null)
    if (!result) {
      throw invalidToken('The refresh token is invalid, expired or revoked')
    }
    return c.json({ code: 200 as const, data: tokenBody(result.installation.id, result.tokens) })
  },
)

/* ── Presence and state ────────────────────────────────────────────────────── */

const heartbeatBodySchema = v.object({
  app_version: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(64)))),
  /** Seconds somebody used the app since the previous heartbeat (a visible tab, recent input). */
  active_seconds: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400)))),
  snapshot: v.optional(v.nullable(snapshotSchema)),
})

app.post(
  '/:appId/heartbeat',
  describeRoute({
    operationId: 'heartbeat',
    summary: 'Report presence',
    description:
      'Send every `presence.interval_seconds`. Marks the installation connected (it reads as disconnected after three missed intervals), credits the time since the previous heartbeat to the usage statistics, and keeps the light `snapshot` as the live view. With the `metrics` module on, the snapshot is also stored as a sample. The answer carries the state to obey and the presence settings, which can change without a new release.',
    tags: ['Presence'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Accepted',
        content: json(v.object({ code: v.literal(200), data: v.object({ state: stateSchema, presence: presenceSchema, server_time: v.string() }) })),
      },
      401: { description: 'Refresh the token, or enroll again' },
    },
  }),
  requireInstallation,
  validate('json', heartbeatBodySchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    const body = c.req.valid('json')
    const db = getDb(c.env)
    const now = new Date()

    const [appRow, installation] = await Promise.all([
      requireApp(c, appId),
      db.select().from(installations).where(eq(installations.id, installationId)).limit(1).then((rows) => rows[0]!),
    ])

    const credits = heartbeatCredit(installation.lastSeenAt, now, appRow.heartbeatIntervalSeconds, body.active_seconds)
    const versionChanged = body.app_version != null && body.app_version !== installation.appVersion
    const nowSeconds = Math.floor(now.getTime() / 1000)

    const assignments = ['last_seen_at = ?', 'last_ip = ?', 'updated_at = ?']
    const bindings: unknown[] = [nowSeconds, c.req.header('CF-Connecting-IP') ?? installation.lastIp, nowSeconds]
    if (body.snapshot) {
      assignments.push('last_snapshot = ?')
      bindings.push(JSON.stringify(body.snapshot))
    }
    if (versionChanged) {
      assignments.push('app_version = ?', 'previous_app_version = ?')
      bindings.push(body.app_version, installation.appVersion)
    }

    // The presence update and the hours it is filed under commit together, so the panel never shows
    // a connected installation with no use recorded for the hour, or the reverse.
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE installations SET ${assignments.join(', ')} WHERE id = ?`).bind(...bindings, installationId),
      ...hourlyStatements(c.env.DB, installationId, appId, credits),
    ])

    if (body.snapshot && modulesOf(appRow).includes('metrics')) {
      await c.env.TELEMETRY_QUEUE.send({
        version: 1,
        kind: 'metrics',
        installation_id: installationId,
        app_id: appId,
        received_at: Math.floor(now.getTime() / 1000),
        samples: [{ recorded_at: now.getTime(), ...body.snapshot }],
      } satisfies TelemetryMessage)
    }

    return c.json({
      code: 200 as const,
      data: { state: stateFor(appRow, installation), presence: presenceFor(appRow), server_time: now.toISOString() },
    })
  },
)

app.get(
  '/:appId/status',
  describeRoute({
    operationId: 'status',
    summary: 'Read the state to obey',
    description:
      'Call on start-up before anything else. `active`: run normally. `grace`: run, and show `message` with a countdown to `until`. `maintenance`: show a maintenance notice with `until` as the estimated end. `suspended`: show `message` and stop.',
    tags: ['Presence'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The state', content: json(v.object({ code: v.literal(200), data: v.object({ ...stateSchema.entries, presence: presenceSchema }) })) },
      401: { description: 'Refresh the token, or enroll again' },
    },
  }),
  requireInstallation,
  async (c) => {
    const { installationId, appId } = c.get('device')
    const appRow = await requireApp(c, appId)
    const [installation] = await getDb(c.env)
      .select({ stateOverride: installations.stateOverride, stateMessage: installations.stateMessage })
      .from(installations)
      .where(eq(installations.id, installationId))
      .limit(1)
    return c.json({ code: 200 as const, data: { ...stateFor(appRow, installation ?? null), presence: presenceFor(appRow) } })
  },
)

/* ── Telemetry ─────────────────────────────────────────────────────────────── */

const acceptedSchema = v.object({ code: v.literal(202), data: v.object({ accepted: v.number(), rejected: v.number() }) })

app.post(
  '/:appId/metrics',
  describeRoute({
    operationId: 'metrics',
    summary: 'Send system metrics',
    description: `A batch of up to ${TELEMETRY.maxBatch} samples. Send only what the platform can measure; anything omitted or null is shown as N/A. Network counters are bytes since the previous sample. Samples dated more than ${TELEMETRY.maxClockSkewSeconds} s in the future or older than ${TELEMETRY.rawRetentionDays} days are rejected and counted in \`rejected\`. Queue them locally while offline and send them when the network is back.`,
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: {
      202: { description: 'Queued for storage', content: json(acceptedSchema) },
      403: { description: 'The metrics module is not enabled for this app' },
    },
  }),
  requireInstallation,
  validate('json', metricsBodySchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'metrics')
    const now = Date.now()
    const samples = c.req.valid('json').samples
    const accepted = samples.filter((sample) => withinWindow(sample.recorded_at, now))
    if (accepted.length > 0) {
      await c.env.TELEMETRY_QUEUE.send({
        version: 1,
        kind: 'metrics',
        installation_id: installationId,
        app_id: appId,
        received_at: Math.floor(now / 1000),
        samples: accepted,
      } satisfies TelemetryMessage)
    }
    return c.json({ code: 202 as const, data: { accepted: accepted.length, rejected: samples.length - accepted.length } }, 202)
  },
)

app.post(
  '/:appId/events',
  describeRoute({
    operationId: 'events',
    summary: 'Send usage events',
    description: `A batch of up to ${TELEMETRY.maxBatch} usage events: \`session_start\` / \`session_end\`, \`screen\` (with the screen in \`name\`), \`action\` and \`custom\`. \`id\` is minted by the device and must be unique per installation — a batch sent twice is stored once. \`properties\` is a flat object of at most ${TELEMETRY.maxEventPropertiesBytes} bytes.`,
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: {
      202: { description: 'Queued for storage', content: json(acceptedSchema) },
      403: { description: 'The events module is not enabled for this app' },
    },
  }),
  requireInstallation,
  validate('json', eventsBodySchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'events')
    const now = Date.now()
    const events = c.req.valid('json').events
    const accepted = events.filter((event) => withinWindow(event.occurred_at, now))
    if (accepted.length > 0) {
      await c.env.TELEMETRY_QUEUE.send({
        version: 1,
        kind: 'events',
        installation_id: installationId,
        app_id: appId,
        received_at: Math.floor(now / 1000),
        events: accepted,
      } satisfies TelemetryMessage)
    }
    return c.json({ code: 202 as const, data: { accepted: accepted.length, rejected: events.length - accepted.length } }, 202)
  },
)

/* ── Documents ─────────────────────────────────────────────────────────────── */

/** The operations that belong to an optional module, by path relative to the app. */
const MODULE_OF_PATH: Record<string, AppModule> = { '/metrics': 'metrics', '/events': 'events' }

app.get(
  '/:appId/sdk.js',
  describeRoute({
    operationId: 'sdk',
    summary: 'The JavaScript SDK for websites',
    description:
      'Pre-generated for this app with its id, public key and enabled modules. Load it with `<script src="…/sdk.js" async>`; the panel quotes an `integrity` hash to pin it. Exposes `window.FSCustomApps` (`track`, `screen`, `custom`, `state`, `onState`, `installationId`) and dispatches `fscustomapps:state` on `window` when the state changes.',
    tags: ['Documents'],
    responses: { 200: { description: 'The script' }, 404: { description: 'Unknown app, or the app has no active key' } },
  }),
  async (c) => {
    const appRow = await requireApp(c, c.req.param('appId'))
    const sdk = await buildSdk(c.env, appRow)
    if (!sdk) {
      throw new HTTPException(404, { message: 'This app has no active key, so no SDK can be generated' })
    }
    const headers = {
      'Content-Type': 'text/javascript; charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
      ETag: sdk.etag,
      'X-Content-Integrity': sdk.integrity,
    }
    if (c.req.header('If-None-Match') === sdk.etag) {
      return c.body(null, 304, headers)
    }
    return c.body(sdk.script, 200, headers)
  },
)

app.get(
  '/:appId/openapi.json',
  describeRoute({ hide: true }),
  async (c) => {
    const appRow = await requireApp(c, c.req.param('appId'))
    const modules = modulesOf(appRow)
    const urls = ingestUrls(c.env.INGEST_PUBLIC_URL, appRow.id)

    const spec = await generateSpecs(app, {
      documentation: {
        info: {
          title: `${appRow.name} — ingest API`,
          version: '1.0.0',
          description: `What this app reports to franciscosolis.cl. Enroll once with the app key, keep the tokens in the platform's secure store, ask \`/status\` on start-up, and send \`/heartbeat\` every \`presence.interval_seconds\`. Only the modules enabled for this app are listed (${modules.length ? modules.join(', ') : 'none beyond presence'}). Every route but /enroll and /token/refresh takes \`Authorization: Bearer <access_token>\`.`,
        },
        servers: [{ url: urls.base_url }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', description: 'The access token from /enroll or /token/refresh.' },
          },
        },
      },
    })

    // Paths come out as `/{appId}/…`; the server URL already carries the app, so strip it, and drop
    // the operations of modules this app does not have.
    const paths: Record<string, unknown> = {}
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      const relative = path.replace(/^\/\{appId\}/, '')
      const module = MODULE_OF_PATH[relative]
      if (module && !modules.includes(module)) continue
      if (relative === '/openapi.json') continue
      for (const operation of Object.values(item as Record<string, { parameters?: Array<{ name: string; in: string }> }>)) {
        if (operation && typeof operation === 'object' && Array.isArray(operation.parameters)) {
          operation.parameters = operation.parameters.filter((parameter) => !(parameter.in === 'path' && parameter.name === 'appId'))
        }
      }
      paths[relative] = item
    }

    c.header('Cache-Control', 'public, max-age=300')
    return c.json({ ...spec, paths })
  },
)


export { app as ingest }
