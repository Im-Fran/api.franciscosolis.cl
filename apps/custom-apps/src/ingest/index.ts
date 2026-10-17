import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { describeRoute, generateSpecs, resolver } from 'hono-openapi'
import * as v from 'valibot'
import { getDb } from '@/db/client'
import { apps, appKeys, commands, installations, messageReceipts, messages, screenshots } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CRASHES, LOG_LEVELS, LOGS, SCREENSHOTS, TELEMETRY, type AppModule } from '@/lib/config'
import { validate } from '@/lib/validate'
import { isUuid } from '@/lib/validation'
import { invalidToken, requireInstallation } from '@/middleware/installation'
import { buildSdk, modulesOf } from '@/services/apps'
import { acknowledgeCommand, commandAckSchema } from '@/services/commands'
import { enroll, enrollBodySchema, refresh, refreshBodySchema, type IssuedTokens } from '@/services/enrollment'
import { heartbeatBodySchema, presenceFor, recordHeartbeat, stateFor } from '@/services/heartbeat'
import { activeMessages } from '@/services/messages'
import { effectiveLogLevel, etagOf, resolveConfig } from '@/services/remote-config'
import type { AppRow, InstallationRow } from '@/services/serialize'
import { ingestUrls } from '@/services/serialize'
import { SOCKET_HEADERS } from '@/services/socket'
import {
  crashesBodySchema,
  crashSignature,
  crashTitle,
  eventsBodySchema,
  logsBodySchema,
  metricsBodySchema,
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

/** The one route whose body is not JSON: a screenshot's bytes, with a limit of its own. */
const isScreenshotUpload = (path: string) => /^\/[^/]+\/commands\/[^/]+\/screenshot$/.test(path)

const jsonBodyLimit = bodyLimit({
  maxSize: TELEMETRY.maxBodyBytes,
  onError: (c) => c.json({ code: 413, error: `Request bodies are limited to ${TELEMETRY.maxBodyBytes} bytes` }, 413),
})
const screenshotBodyLimit = bodyLimit({
  maxSize: SCREENSHOTS.maxBytes,
  onError: (c) => c.json({ code: 413, error: `Screenshots are limited to ${SCREENSHOTS.maxBytes} bytes` }, 413),
})

app.use('*', (c, next) => (isScreenshotUpload(c.req.path) ? screenshotBodyLimit(c, next) : jsonBodyLimit(c, next)))

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

/** The installation behind an authenticated request. It exists: `requireInstallation` just read it. */
const loadInstallation = async (c: { env: AppEnv['Bindings'] }, installationId: string): Promise<InstallationRow> => {
  const [row] = await getDb(c.env).select().from(installations).where(eq(installations.id, installationId)).limit(1)
  if (!row) throw invalidToken('The installation token is invalid, expired or revoked')
  return row
}

const requireModule = (row: AppRow, module: AppModule) => {
  if (!modulesOf(row).includes(module)) {
    throw new HTTPException(403, { message: `The ${module} module is not enabled for this app` })
  }
}

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
const commandSchema = v.object({
  id: v.string(),
  type: v.string(),
  payload: v.nullable(v.record(v.string(), v.unknown())),
  created_at: v.string(),
  expires_at: v.string(),
})
const directivesSchema = v.object({
  state: stateSchema,
  presence: presenceSchema,
  server_time: v.string(),
  commands: v.array(commandSchema),
  sync: v.object({ config_etag: v.nullable(v.string()), messages_etag: v.nullable(v.string()), log_level: v.nullable(v.string()) }),
})
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

app.post(
  '/:appId/heartbeat',
  describeRoute({
    operationId: 'heartbeat',
    summary: 'Report presence',
    description:
      'Send every `presence.interval_seconds` (in socket mode, send the same body down the socket instead). Marks the installation connected (it reads as disconnected after three missed intervals), credits the time since the previous heartbeat to the usage statistics, and keeps the light `snapshot` as the live view. Every heartbeat is kept for audit; with the `metrics` module on, the snapshot also becomes the sample of its minute — the last heartbeat of a minute wins, so sending more often than once a minute adds no points to the charts.\n\nThe answer is what the panel has for this device: the `state` to obey, the `presence` settings (a mode or interval change takes effect without a release), the `commands` not yet acknowledged — repeated in every answer until acknowledged, so deduplicate them by `id` — and in `sync` the tags of the config and messages (refetch `/config` or `/messages` when one changes) and the minimum `log_level` to send. Parts of modules the app does not have are null or empty.',
    tags: ['Presence'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Accepted', content: json(v.object({ code: v.literal(200), data: directivesSchema })) },
      401: { description: 'Refresh the token, or enroll again' },
    },
  }),
  requireInstallation,
  validate('json', heartbeatBodySchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    const directives = await recordHeartbeat(c.env, {
      installationId,
      appId,
      body: c.req.valid('json'),
      ip: c.req.header('CF-Connecting-IP') ?? null,
    })
    if (!directives) {
      throw invalidToken('The installation token is invalid, expired or revoked')
    }
    return c.json({ code: 200 as const, data: directives })
  },
)

app.get(
  '/:appId/socket',
  describeRoute({
    operationId: 'socket',
    summary: 'Hold a socket open (socket mode)',
    description:
      'For apps whose `presence.mode` is `socket`: a WebSocket, authenticated with the same `Authorization: Bearer` header as every other route — a native client sets it on the upgrade request. JSON text frames. On connect the server sends `{"type":"hello","data":<the heartbeat answer>}`. Send `{"type":"heartbeat", …heartbeat body}` every `presence.interval_seconds` and get `{"type":"heartbeat_ack","data":…}` back; acknowledge commands with `{"type":"command_ack","id","status","result"}` (or `POST /commands/{commandId}/ack`). Whenever the panel changes something for this device the server sends `{"type":"sync","data":…}` at once. `{"type":"ping"}` is answered `{"type":"pong"}`. One socket per installation: a new one closes the previous (code 4000); a revoked installation is closed with 4001 — enroll again. In ping mode this answers 409: use `POST /heartbeat`.',
    tags: ['Presence'],
    security: [{ bearerAuth: [] }],
    responses: {
      101: { description: 'Switching protocols' },
      401: { description: 'Refresh the token, or enroll again' },
      409: { description: 'This app reports presence by ping' },
      426: { description: 'Not a WebSocket upgrade' },
    },
  }),
  requireInstallation,
  async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      throw new HTTPException(426, { message: 'This route only answers WebSocket upgrades' })
    }
    const { installationId, appId } = c.get('device')
    const appRow = await requireApp(c, appId)
    if (appRow.presenceMode !== 'socket') {
      throw new HTTPException(409, { message: 'This app reports presence by ping: use POST /heartbeat' })
    }
    // The device is handed over by headers this route sets itself, after authenticating it; the
    // object never reads an identity from the network.
    const headers = new Headers({ Upgrade: 'websocket' })
    headers.set(SOCKET_HEADERS.installation, installationId)
    headers.set(SOCKET_HEADERS.app, appId)
    const ip = c.req.header('CF-Connecting-IP')
    if (ip) headers.set(SOCKET_HEADERS.ip, ip)
    const upstream = await c.env.PRESENCE.get(c.env.PRESENCE.idFromName(installationId)).fetch('https://socket.internal/', { headers })
    // A fresh Response, so the conventions middleware can still set its headers on it.
    return new Response(null, { status: upstream.status, webSocket: upstream.webSocket, headers: { 'Cache-Control': 'no-store' } })
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
    const installation = await loadInstallation(c, installationId)
    return c.json({ code: 200 as const, data: { ...stateFor(appRow, installation), presence: presenceFor(appRow) } })
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

app.post(
  '/:appId/logs',
  describeRoute({
    operationId: 'logs',
    summary: 'Send log entries',
    description: `A batch of up to ${TELEMETRY.maxBatch} log entries. Send only those at or above \`sync.log_level\` from the last heartbeat answer — it can be changed remotely, per app or per device — anything below it is dropped and counted in \`dropped\`. \`id\` is minted by the device and unique per installation, so a batch sent twice is stored once. Messages longer than ${LOGS.maxMessageBytes} characters are cut. Kept ${TELEMETRY.rawRetentionDays} days. Queue them while offline and send them later; answer an \`upload_logs\` command by sending what it asks for here.`,
    tags: ['Logs and crashes'],
    security: [{ bearerAuth: [] }],
    responses: {
      202: {
        description: 'Queued for storage',
        content: json(v.object({ code: v.literal(202), data: v.object({ accepted: v.number(), rejected: v.number(), dropped: v.number() }) })),
      },
      403: { description: 'The logs module is not enabled for this app' },
    },
  }),
  requireInstallation,
  validate('json', logsBodySchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    const appRow = await requireApp(c, appId)
    requireModule(appRow, 'logs')
    const installation = await loadInstallation(c, installationId)
    const minimum = LOG_LEVELS.indexOf(effectiveLogLevel(appRow, installation))
    const now = Date.now()
    const entries = c.req.valid('json').entries
    const inWindow = entries.filter((entry) => withinWindow(entry.occurred_at, now))
    const accepted = inWindow.filter((entry) => LOG_LEVELS.indexOf(entry.level) >= minimum)
    if (accepted.length > 0) {
      await c.env.TELEMETRY_QUEUE.send({
        version: 1,
        kind: 'logs',
        installation_id: installationId,
        app_id: appId,
        received_at: Math.floor(now / 1000),
        entries: accepted,
      } satisfies TelemetryMessage)
    }
    return c.json(
      { code: 202 as const, data: { accepted: accepted.length, rejected: entries.length - inWindow.length, dropped: inWindow.length - accepted.length } },
      202,
    )
  },
)

app.post(
  '/:appId/crashes',
  describeRoute({
    operationId: 'crashes',
    summary: 'Report crashes',
    description: `Up to ${CRASHES.maxBatch} crash reports. Send each one on the next start after the crash, with the \`stack\` as the platform prints it (a Rust panic backtrace, a JavaScript \`error.stack\`), the \`kind\` (panic, signal or exception type), the \`message\` and the \`app_version\` that crashed. The service groups reports by the top frames of the stack — addresses and line numbers taken out — and by version. \`id\` is minted by the device and unique per installation, so a report sent twice counts once.`,
    tags: ['Logs and crashes'],
    security: [{ bearerAuth: [] }],
    responses: {
      202: { description: 'Queued for storage', content: json(acceptedSchema) },
      403: { description: 'The crashes module is not enabled for this app' },
    },
  }),
  requireInstallation,
  validate('json', crashesBodySchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'crashes')
    const now = Date.now()
    const crashes = c.req.valid('json').crashes
    const inWindow = crashes.filter((crash) => withinWindow(crash.occurred_at, now))
    if (inWindow.length > 0) {
      const queued = await Promise.all(inWindow.map(async (crash) => ({ ...crash, signature: await crashSignature(crash), title: crashTitle(crash) })))
      await c.env.TELEMETRY_QUEUE.send({
        version: 1,
        kind: 'crashes',
        installation_id: installationId,
        app_id: appId,
        received_at: Math.floor(now / 1000),
        crashes: queued,
      } satisfies TelemetryMessage)
    }
    return c.json({ code: 202 as const, data: { accepted: inWindow.length, rejected: crashes.length - inWindow.length } }, 202)
  },
)

/* ── Remote operation ──────────────────────────────────────────────────────── */

app.get(
  '/:appId/config',
  describeRoute({
    operationId: 'config',
    summary: 'Read flags and remote config',
    description:
      'The feature flags that apply to this device — each key resolved to the most specific value: this installation, then its channel, then the app — and the remote config document with its version. Answers an `ETag`; send it back as `If-None-Match` to get a 304 when nothing changed. Fetch it on start-up and whenever `sync.config_etag` in a heartbeat answer differs from the tag you hold. Cache it locally so the app still works offline.',
    tags: ['Remote control'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The resolved config',
        content: json(
          v.object({
            code: v.literal(200),
            data: v.object({ flags: v.record(v.string(), v.unknown()), config: v.record(v.string(), v.unknown()), config_version: v.number() }),
          }),
        ),
      },
      304: { description: 'Unchanged since the ETag sent' },
      403: { description: 'The config module is not enabled for this app' },
    },
  }),
  requireInstallation,
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'config')
    const installation = await loadInstallation(c, installationId)
    const resolved = await resolveConfig(getDb(c.env), appId, { id: installation.id, channel: installation.channel })
    const etag = await etagOf(resolved)
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' }
    if (c.req.header('If-None-Match') === etag) {
      return c.body(null, 304, headers)
    }
    return c.json({ code: 200 as const, data: resolved }, 200, headers)
  },
)

const messageSchema = v.object({
  id: v.string(),
  title: v.string(),
  body: v.string(),
  severity: v.picklist(['info', 'warning', 'critical']),
  display: v.picklist(['banner', 'modal']),
  starts_at: v.nullable(v.string()),
  ends_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
  seen: v.boolean(),
})

app.get(
  '/:appId/messages',
  describeRoute({
    operationId: 'messages',
    summary: 'Read in-app messages',
    description:
      'The messages running now that are aimed at this device, most severe first. Show a `banner` where it does not block work and a `modal` the user has to close; confirm each one with `POST /messages/{messageId}/seen` once it was shown. `seen` says whether this device already did. Answers an `ETag` like `/config`; refetch when `sync.messages_etag` changes.',
    tags: ['Remote control'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The messages', content: json(v.object({ code: v.literal(200), data: v.array(messageSchema) })) },
      304: { description: 'Unchanged since the ETag sent' },
      403: { description: 'The messages module is not enabled for this app' },
    },
  }),
  requireInstallation,
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'messages')
    const installation = await loadInstallation(c, installationId)
    const list = await activeMessages(getDb(c.env), appId, { id: installation.id, channel: installation.channel })
    const etag = await etagOf(list)
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' }
    if (c.req.header('If-None-Match') === etag) {
      return c.body(null, 304, headers)
    }
    return c.json({ code: 200 as const, data: list }, 200, headers)
  },
)

app.post(
  '/:appId/messages/:messageId/seen',
  describeRoute({
    operationId: 'messageSeen',
    summary: 'Confirm a message was shown',
    description: 'Idempotent: confirming twice is the same as once.',
    tags: ['Remote control'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Recorded', content: json(v.object({ code: v.literal(200), data: v.object({ id: v.string(), seen: v.literal(true) }) })) },
      403: { description: 'The messages module is not enabled for this app' },
      404: { description: 'No such message for this app' },
    },
  }),
  requireInstallation,
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'messages')
    const messageId = c.req.param('messageId')
    const db = getDb(c.env)
    const [message] = isUuid(messageId)
      ? await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, messageId), eq(messages.appId, appId))).limit(1)
      : []
    if (!message) {
      throw new HTTPException(404, { message: 'Message not found' })
    }
    await db.insert(messageReceipts).values({ messageId: message.id, installationId }).onConflictDoNothing()
    return c.json({ code: 200 as const, data: { id: message.id, seen: true as const } })
  },
)

/** A command of the calling installation, or 404 — whatever the reason, the device learns nothing. */
const requireCommand = async (c: { env: AppEnv['Bindings'] }, installationId: string, commandId: string | undefined) => {
  const [row] = commandId && isUuid(commandId)
    ? await getDb(c.env).select().from(commands).where(and(eq(commands.id, commandId), eq(commands.installationId, installationId))).limit(1)
    : []
  if (!row) {
    throw new HTTPException(404, { message: 'Command not found' })
  }
  return row
}

app.post(
  '/:appId/commands/:commandId/ack',
  describeRoute({
    operationId: 'commandAck',
    summary: 'Report the result of a command',
    description:
      'Once a command is done, or has failed. Only commands from the catalogue are ever sent — `restart_app`, `restart_device` (kiosks), `reload_config`, `clear_cache`, `screenshot` (answer with `POST /commands/{commandId}/screenshot` instead), `upload_logs` (send the logs to `/logs`, then acknowledge), `check_update` — and a device must refuse anything else by failing it. Acknowledging the same result twice is harmless. A command that expired or was cancelled before the acknowledgement answers 409.',
    tags: ['Remote control'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Recorded' },
      403: { description: 'The commands module is not enabled for this app' },
      404: { description: 'No such command for this installation' },
      409: { description: 'The command expired or was cancelled' },
    },
  }),
  requireInstallation,
  validate('json', commandAckSchema),
  async (c) => {
    const { installationId, appId } = c.get('device')
    requireModule(await requireApp(c, appId), 'commands')
    const commandId = c.req.param('commandId') ?? ''
    if (!isUuid(commandId)) throw new HTTPException(404, { message: 'Command not found' })
    const result = await acknowledgeCommand(getDb(c.env), installationId, commandId, c.req.valid('json'))
    if (result.outcome === 'not_found') throw new HTTPException(404, { message: 'Command not found' })
    if (result.outcome === 'closed') throw new HTTPException(409, { message: `The command is already ${result.row.status}` })
    return c.json({ code: 200 as const, data: { id: commandId, status: result.row.status } })
  },
)

const SCREENSHOT_EXTENSIONS: Record<(typeof SCREENSHOTS.contentTypes)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

app.post(
  '/:appId/commands/:commandId/screenshot',
  describeRoute({
    operationId: 'commandScreenshot',
    summary: 'Upload the screenshot a command asked for',
    description: `The answer to a \`screenshot\` command: the image as the request body — not JSON — with \`Content-Type\` \`image/png\`, \`image/jpeg\` or \`image/webp\`, at most ${SCREENSHOTS.maxBytes / (1024 * 1024)} MB. It completes the command; no separate acknowledgement is needed. If screenshots were turned off for the app or this device after the command was sent, this answers 403 — fail the command instead.`,
    tags: ['Remote control'],
    security: [{ bearerAuth: [] }],
    responses: {
      201: { description: 'Stored' },
      403: { description: 'Screenshots, or the commands module, are off' },
      404: { description: 'No such screenshot command for this installation' },
      409: { description: 'The command is no longer waiting for a screenshot' },
      413: { description: 'The image is too large' },
      415: { description: 'Not a PNG, JPEG or WebP image' },
    },
  }),
  requireInstallation,
  async (c) => {
    const { installationId, appId } = c.get('device')
    const appRow = await requireApp(c, appId)
    requireModule(appRow, 'commands')
    const command = await requireCommand(c, installationId, c.req.param('commandId'))
    if (command.type !== 'screenshot') throw new HTTPException(404, { message: 'Command not found' })
    if ((command.status !== 'pending' && command.status !== 'delivered') || command.expiresAt.getTime() <= Date.now()) {
      throw new HTTPException(409, { message: `The command is already ${command.status === 'pending' || command.status === 'delivered' ? 'expired' : command.status}` })
    }
    const installation = await loadInstallation(c, installationId)
    if (!appRow.screenshotsEnabled || !installation.screenshotsEnabled) {
      throw new HTTPException(403, { message: 'Screenshots are turned off for this app or this device' })
    }
    const contentType = (c.req.header('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!(SCREENSHOTS.contentTypes as readonly string[]).includes(contentType)) {
      throw new HTTPException(415, { message: 'A screenshot is a PNG, JPEG or WebP image' })
    }
    const bytes = await c.req.arrayBuffer()
    if (bytes.byteLength === 0) {
      throw new HTTPException(400, { message: 'The image is empty' })
    }

    const id = crypto.randomUUID()
    const objectKey = `screenshots/${appId}/${installationId}/${id}.${SCREENSHOT_EXTENSIONS[contentType as keyof typeof SCREENSHOT_EXTENSIONS]}`
    await c.env.SCREENSHOTS.put(objectKey, bytes, { httpMetadata: { contentType } })
    const now = new Date()
    const db = getDb(c.env)
    await db.batch([
      db.insert(screenshots).values({ id, installationId, appId, commandId: command.id, objectKey, contentType, sizeBytes: bytes.byteLength }),
      db
        .update(commands)
        .set({ status: 'succeeded', completedAt: now, deliveredAt: command.deliveredAt ?? now, result: JSON.stringify({ screenshot_id: id }) })
        .where(eq(commands.id, command.id)),
    ])
    return c.json({ code: 201 as const, data: { id, command_id: command.id, size_bytes: bytes.byteLength } }, 201)
  },
)

/* ── Documents ─────────────────────────────────────────────────────────────── */

/**
 * The module an operation belongs to, by the first segment of its path relative to the app. Anything
 * not listed is presence, which every app has.
 */
const MODULE_OF_SEGMENT: Record<string, AppModule> = {
  metrics: 'metrics',
  events: 'events',
  logs: 'logs',
  crashes: 'crashes',
  config: 'config',
  messages: 'messages',
  commands: 'commands',
}

/** Socket presence is listed only for apps in socket mode: a ping app would be refused it. */
const isSocketPath = (relative: string) => relative === '/socket'

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
      const module = MODULE_OF_SEGMENT[relative.split('/')[1] ?? '']
      if (module && !modules.includes(module)) continue
      if (isSocketPath(relative) && appRow.presenceMode !== 'socket') continue
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
