import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, commands, configVersions, flags, installations, messageReceipts, messages, screenshots } from '@/db/schema'
import type { AppEnv } from '@/env'
import {
  CHANNELS,
  COMMAND_STATUSES,
  COMMAND_TYPES,
  COMMANDS,
  MESSAGE_DISPLAYS,
  MESSAGE_SEVERITIES,
  REMOTE_CONFIG,
  TARGET_SCOPES,
  type TargetScope,
} from '@/lib/config'
import { iso, parseJsonObject } from '@/lib/json'
import { checkSchema, validateJson, type Schema } from '@/lib/json-schema'
import { dateInput, optionalText, paginationQuery, requiredText } from '@/lib/validation'
import { isUniqueViolation } from '@/lib/errors'
import { validate } from '@/lib/validate'
import { modulesOf } from '@/services/apps'
import { auditRow, diff, getActorContext, recordAudit } from '@/services/audit'
import { commandObject, toCommand } from '@/services/commands'
import { runningAt, type MessageRow } from '@/services/messages'
import { currentConfig, flagValue, type FlagRow } from '@/services/remote-config'
import type { AppRow, InstallationRow } from '@/services/serialize'
import { syncApp, syncInstallation } from '@/services/socket'
import { storedScopeValue } from '@/services/targeting'
import { assertId, dataSchema, jsonContent, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * Remote operation from the panel: commands and the screenshots they bring back, feature flags, the
 * remote config document and in-app messages.
 *
 * Every change here reaches the devices holding a socket at once (`syncApp` / `syncInstallation`,
 * after the response, never holding it up) and the rest on their next heartbeat.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

const loadAppRow = async (db: Database, id: string): Promise<AppRow> => {
  const [row] = await db.select().from(apps).where(eq(apps.id, id)).limit(1)
  if (!row) throw notFound('App')
  return row
}

const loadInstallation = async (db: Database, id: string): Promise<{ installation: InstallationRow; app: AppRow }> => {
  const [row] = await db.select({ installation: installations, app: apps }).from(installations).innerJoin(apps, eq(apps.id, installations.appId)).where(eq(installations.id, id)).limit(1)
  if (!row) throw notFound('Installation')
  return row
}

/** Pushes to the app's sockets after the response. */
const pushToApp = (c: Context<AppEnv>, appId: string) => c.executionCtx.waitUntil(syncApp(c.env, appId))

/* ── Commands ──────────────────────────────────────────────────────────────── */

const createCommandSchema = v.object({
  type: v.picklist(COMMAND_TYPES),
  payload: v.optional(v.nullable(commandObject)),
  expires_in_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(COMMANDS.maxTtlSeconds))),
})

app.get(
  '/installations/:installationId/commands',
  describeRoute({
    description: 'The commands sent to an installation, newest first, with what the device answered.',
    tags: ['Commands'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The commands', content: jsonContent(listSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ status: v.optional(v.picklist(COMMAND_STATUSES)), ...paginationQuery })),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    await loadInstallation(db, id)
    const where = and(eq(commands.installationId, id), query.status ? eq(commands.status, query.status) : undefined)
    const [rows, [total]] = await Promise.all([
      db.select().from(commands).where(where).orderBy(desc(commands.createdAt), sql`${commands}.rowid DESC`).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(commands).where(where),
    ])
    return c.json({ code: 200 as const, data: rows.map(toCommand), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

app.post(
  '/installations/:installationId/commands',
  describeRoute({
    description: `Sends a command from the closed catalogue to one installation. It is pushed at once to a device holding a socket, and handed over in the next heartbeat answer otherwise — repeated until acknowledged — and expires after \`expires_in_seconds\` (default ${COMMANDS.defaultTtlSeconds}, at most ${COMMANDS.maxTtlSeconds}). \`restart_device\` is for kiosks only; \`screenshot\` needs screenshots on for both the app and the installation. Refused with 409 for a revoked installation, or an app without the \`commands\` module.`,
    tags: ['Commands'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Queued', content: jsonContent(dataSchema(looseSchema, 201)) }, 404: { description: 'Not found' }, 409: { description: 'The command cannot be sent to this installation' }, ...panelErrors },
  }),
  validate('json', createCommandSchema),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const { installation, app: appRow } = await loadInstallation(db, id)
    if (installation.status !== 'active') throw new HTTPException(409, { message: 'This installation is revoked' })
    if (!modulesOf(appRow).includes('commands')) throw new HTTPException(409, { message: 'The commands module is not enabled for this app' })
    if (body.type === 'restart_device' && appRow.kind !== 'kiosk') throw new HTTPException(409, { message: 'Only a kiosk can be told to restart its device' })
    if (body.type === 'screenshot' && !(appRow.screenshotsEnabled && installation.screenshotsEnabled)) {
      throw new HTTPException(409, { message: 'Screenshots are turned off for this app or this installation' })
    }

    const commandId = crypto.randomUUID()
    const now = new Date()
    await db.batch([
      db.insert(commands).values({
        id: commandId,
        installationId: id,
        appId: appRow.id,
        type: body.type,
        payload: body.payload ? JSON.stringify(body.payload) : null,
        status: 'pending',
        expiresAt: new Date(now.getTime() + (body.expires_in_seconds ?? COMMANDS.defaultTtlSeconds) * 1000),
        createdBy: actor.actorEmail,
        createdAt: now,
      }),
      db.insert(auditLogs).values(
        auditRow({ event: 'command.created', resourceType: 'installation', resourceId: id, ...actor, metadata: { app_id: appRow.id, command_id: commandId, type: body.type, payload: body.payload ?? null } }),
      ),
    ])
    if (installation.socketConnectedAt) c.executionCtx.waitUntil(syncInstallation(c.env, id))
    const [row] = await db.select().from(commands).where(eq(commands.id, commandId))
    return c.json({ code: 201 as const, data: toCommand(row!) }, 201)
  },
)

app.post(
  '/commands/:commandId/cancel',
  describeRoute({
    description: 'Withdraws a command the device has not answered yet. A device that already received it is told nothing more; its acknowledgement will be refused.',
    tags: ['Commands'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Cancelled', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Already answered, expired or cancelled' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('commandId'), 'Command')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const [row] = await db.select().from(commands).where(eq(commands.id, id)).limit(1)
    if (!row) throw notFound('Command')
    const [updated] = await db
      .update(commands)
      .set({ status: 'cancelled', cancelledBy: actor.actorEmail, completedAt: new Date() })
      .where(and(eq(commands.id, id), inArray(commands.status, ['pending', 'delivered'])))
      .returning()
    if (!updated) throw new HTTPException(409, { message: `The command is already ${row.status}` })
    await recordAudit(db, { event: 'command.cancelled', resourceType: 'installation', resourceId: row.installationId, ...actor, metadata: { app_id: row.appId, command_id: id, type: row.type } })
    return c.json({ code: 200 as const, data: toCommand(updated) })
  },
)

/* ── Screenshots ───────────────────────────────────────────────────────────── */

type ScreenshotRow = typeof screenshots.$inferSelect

const toScreenshot = (row: ScreenshotRow) => ({
  id: row.id,
  installation_id: row.installationId,
  app_id: row.appId,
  command_id: row.commandId,
  content_type: row.contentType,
  size_bytes: row.sizeBytes,
  created_at: iso(row.createdAt),
  image_path: `/v1/screenshots/${row.id}/image`,
})

app.get(
  '/installations/:installationId/screenshots',
  describeRoute({
    description: 'The screenshots an installation sent, newest first. Kept without expiry; `image_path` serves the image to the same token.',
    tags: ['Commands'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The screenshots', content: jsonContent(listSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    await loadInstallation(db, id)
    const where = eq(screenshots.installationId, id)
    const [rows, [total]] = await Promise.all([
      db.select().from(screenshots).where(where).orderBy(desc(screenshots.createdAt), desc(screenshots.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(screenshots).where(where),
    ])
    return c.json({ code: 200 as const, data: rows.map(toScreenshot), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

const loadScreenshot = async (db: Database, id: string) => {
  const [row] = await db.select().from(screenshots).where(eq(screenshots.id, id)).limit(1)
  if (!row) throw notFound('Screenshot')
  return row
}

app.get(
  '/screenshots/:screenshotId/image',
  describeRoute({
    description: 'The image itself. Behind the same gate as the rest of the panel: the bucket has no public access, so this is the only way to see one.',
    tags: ['Commands'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The image' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('screenshotId'), 'Screenshot')
    const row = await loadScreenshot(getDb(c.env), id)
    const object = await c.env.SCREENSHOTS.get(row.objectKey)
    if (!object) throw notFound('Screenshot')
    return new Response(object.body, {
      headers: {
        'Content-Type': row.contentType,
        'Content-Length': String(row.sizeBytes),
        // Never changes once stored, but it is a client's screen: the browser may keep it, nothing shared may.
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
)

app.delete(
  '/screenshots/:screenshotId',
  describeRoute({
    description: 'Deletes a screenshot, image and record. Screenshots are kept indefinitely by decision, so this is how one requested for removal is removed.',
    tags: ['Commands'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('screenshotId'), 'Screenshot')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadScreenshot(db, id)
    await c.env.SCREENSHOTS.delete(row.objectKey)
    await db.delete(screenshots).where(eq(screenshots.id, id))
    await recordAudit(db, {
      event: 'screenshot.deleted',
      resourceType: 'installation',
      resourceId: row.installationId,
      ...actor,
      metadata: { app_id: row.appId, screenshot_id: id, command_id: row.commandId, created_at: iso(row.createdAt) },
    })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

/* ── Targeting (flags and messages) ────────────────────────────────────────── */

const targetEntries = {
  scope: v.optional(v.picklist(TARGET_SCOPES), 'app'),
  /** The channel, or the installation id. Ignored for the app scope. */
  scope_value: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(64)))),
}

/** Checks a target names something real in the app, and answers what is stored. */
const resolveTarget = async (db: Database, appId: string, scope: TargetScope, value: string | null | undefined) => {
  const stored = storedScopeValue(scope, value)
  if (scope === 'channel' && !(CHANNELS as readonly string[]).includes(stored)) {
    throw new HTTPException(422, { message: `scope_value must be a channel: ${CHANNELS.join(', ')}` })
  }
  if (scope === 'installation') {
    const [row] = /^[0-9a-f-]{36}$/i.test(stored)
      ? await db.select({ id: installations.id }).from(installations).where(and(eq(installations.id, stored), eq(installations.appId, appId))).limit(1)
      : []
    if (!row) throw new HTTPException(422, { message: 'scope_value must be an installation of this app' })
  }
  return stored
}

/* ── Flags ─────────────────────────────────────────────────────────────────── */

const flagKey = v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'must be lowercase letters, digits, `_`, `.` or `-`, at most 64'))
const flagValueInput = v.union([
  v.boolean(),
  v.pipe(v.number(), v.finite()),
  v.pipe(v.string(), v.maxLength(REMOTE_CONFIG.maxFlagValueBytes)),
])

const toFlag = (row: FlagRow) => ({
  id: row.id,
  app_id: row.appId,
  key: row.key,
  description: row.description,
  scope: row.scope,
  scope_value: row.scope === 'app' ? null : row.scopeValue,
  value: flagValue(row) ?? null,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

app.get(
  '/apps/:appId/flags',
  describeRoute({
    description: "An app's flags, by key and then from the broadest scope to the most specific. A device gets, per key, the most specific row that applies to it: its installation, then its channel, then the app.",
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The flags', content: jsonContent(dataSchema(v.array(looseSchema))) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const rows = await db
      .select()
      .from(flags)
      .where(eq(flags.appId, id))
      .orderBy(asc(flags.key), sql`CASE ${flags.scope} WHEN 'app' THEN 0 WHEN 'channel' THEN 1 ELSE 2 END`, asc(flags.scopeValue))
    return c.json({ code: 200 as const, data: rows.map(toFlag) })
  },
)

app.post(
  '/apps/:appId/flags',
  describeRoute({
    description: 'Sets a flag for one scope: a boolean, a variant name or a number. Refused with 409 when the key already has a value at that scope — edit that one instead.',
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(looseSchema, 201)) }, 404: { description: 'Not found' }, 409: { description: 'Already set at this scope' }, 422: { description: 'Unknown channel or installation' }, ...panelErrors },
  }),
  validate('json', v.object({ key: flagKey, value: flagValueInput, description: optionalText(500), ...targetEntries })),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const scopeValue = await resolveTarget(db, id, body.scope, body.scope_value)
    const [count] = await db.select({ count: sql<number>`COUNT(*)` }).from(flags).where(eq(flags.appId, id))
    if (Number(count?.count ?? 0) >= REMOTE_CONFIG.maxFlags) throw new HTTPException(409, { message: `An app has at most ${REMOTE_CONFIG.maxFlags} flags` })
    const flagId = crypto.randomUUID()
    const [created] = await db
      .insert(flags)
      .values({
        id: flagId,
        appId: id,
        key: body.key,
        description: body.description ?? null,
        scope: body.scope,
        scopeValue,
        value: JSON.stringify(body.value),
        createdBy: actor.actorEmail,
        updatedBy: actor.actorEmail,
      })
      .onConflictDoNothing()
      .returning()
    if (!created) throw new HTTPException(409, { message: `The flag ${body.key} is already set at this scope` })
    await recordAudit(db, { event: 'flag.created', resourceType: 'app', resourceId: id, ...actor, metadata: { after: toFlag(created) } })
    pushToApp(c, id)
    return c.json({ code: 201 as const, data: toFlag(created) }, 201)
  },
)

const loadFlag = async (db: Database, id: string) => {
  const [row] = await db.select().from(flags).where(eq(flags.id, id)).limit(1)
  if (!row) throw notFound('Flag')
  return row
}

app.patch(
  '/flags/:flagId',
  describeRoute({
    description: "Changes a flag's value or description. Its key and scope are what it is; to aim it elsewhere, set another.",
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', v.object({ value: v.optional(flagValueInput), description: optionalText(500) })),
  async (c) => {
    const id = assertId(c.req.param('flagId'), 'Flag')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadFlag(db, id)
    const [updated] = await db
      .update(flags)
      .set({
        ...(body.value !== undefined && { value: JSON.stringify(body.value) }),
        ...(body.description !== undefined && { description: body.description }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(flags.id, id))
      .returning()
    await recordAudit(db, { event: 'flag.updated', resourceType: 'app', resourceId: before.appId, ...actor, metadata: { flag_id: id, key: before.key, ...diff(toFlag(before), toFlag(updated!)) } })
    pushToApp(c, before.appId)
    return c.json({ code: 200 as const, data: toFlag(updated!) })
  },
)

app.delete(
  '/flags/:flagId',
  describeRoute({
    description: 'Removes a flag at one scope. Devices it applied to fall back to the next broader one, or lose the key.',
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('flagId'), 'Flag')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadFlag(db, id)
    await db.delete(flags).where(eq(flags.id, id))
    await recordAudit(db, { event: 'flag.deleted', resourceType: 'app', resourceId: before.appId, ...actor, metadata: { before: toFlag(before) } })
    pushToApp(c, before.appId)
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

/* ── Remote config ─────────────────────────────────────────────────────────── */

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

const jsonObject = (max: number, what: string) =>
  v.pipe(v.record(v.string(), v.unknown()), v.check((value) => byteLength(value) <= max, `${what} must serialise to at most ${max} bytes`))

const configView = (appRow: AppRow, version: number, document: Record<string, unknown>, row: { note: string | null; createdAt: Date; createdBy: string | null } | null) => ({
  app_id: appRow.id,
  version,
  document,
  schema: parseJsonObject(appRow.configSchema),
  note: row?.note ?? null,
  created_at: iso(row?.createdAt),
  created_by: row?.createdBy ?? null,
})

/** The problems with `document` against `schema` (null: anything goes), as an HTTP 422. */
const assertValid = (schema: Schema | null, document: Record<string, unknown>) => {
  if (!schema) return
  const problems = validateJson(schema, document)
  if (problems.length > 0) {
    throw new HTTPException(422, {
      message: problems[0]!,
      res: new Response(JSON.stringify({ code: 422, error: problems[0], issues: problems.slice(0, 50) }), {
        status: 422,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      }),
    })
  }
}

/** Saves `document` as the next version. Answers the new version number, or throws 409 on a race. */
const publishVersion = async (c: Context<AppEnv>, db: Database, appRow: AppRow, document: Record<string, unknown>, note: string | null, extra: Record<string, unknown> = {}) => {
  const actor = getActorContext(c)
  const current = await currentConfig(db, appRow.id)
  const version = current.version + 1
  try {
    await db.batch([
      db.insert(configVersions).values({ appId: appRow.id, version, document: JSON.stringify(document), note, createdBy: actor.actorEmail }),
      db.insert(auditLogs).values(auditRow({ event: 'config.published', resourceType: 'app', resourceId: appRow.id, ...actor, metadata: { version, previous_version: current.version, note, ...extra } })),
    ])
  } catch (error) {
    // Two saves racing for the same version number: the primary key lets one through.
    if (isUniqueViolation(error)) {
      throw new HTTPException(409, { message: 'The config changed while saving; reload and try again' })
    }
    throw error
  }
  pushToApp(c, appRow.id)
  return version
}

app.get(
  '/apps/:appId/config',
  describeRoute({
    description: 'The current remote config document, its version and the JSON Schema it is validated against (null when there is none). Version 0 is the empty document no one saved.',
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The config' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const db = getDb(c.env)
    const appRow = await loadAppRow(db, id)
    const current = await currentConfig(db, id)
    return c.json({ code: 200 as const, data: configView(appRow, current.version, current.document, current.row) })
  },
)

app.put(
  '/apps/:appId/config',
  describeRoute({
    description: `Saves a new version of the remote config. \`document\` is validated against the app's schema — or against \`schema\`, when one is sent in the same request, which replaces it (\`null\` removes it). The schema supports a subset of JSON Schema, and a keyword outside it is refused rather than ignored. Send \`base_version\` (the version you edited) to have a concurrent save refused with 409 instead of overwritten. At most ${REMOTE_CONFIG.maxDocumentBytes / 1024} KB of document and ${REMOTE_CONFIG.maxSchemaBytes / 1024} KB of schema.`,
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Saved' }, 404: { description: 'Not found' }, 409: { description: 'Somebody saved first' }, 422: { description: 'Invalid schema, or a document that does not satisfy it' }, ...panelErrors },
  }),
  validate(
    'json',
    v.object({
      document: jsonObject(REMOTE_CONFIG.maxDocumentBytes, 'document'),
      schema: v.optional(v.nullable(jsonObject(REMOTE_CONFIG.maxSchemaBytes, 'schema'))),
      note: optionalText(500),
      base_version: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const appRow = await loadAppRow(db, id)
    const current = await currentConfig(db, id)
    if (body.base_version !== undefined && body.base_version !== current.version) {
      throw new HTTPException(409, { message: `The config is at version ${current.version}, not ${body.base_version}; reload and try again` })
    }

    const schemaChanged = body.schema !== undefined && JSON.stringify(body.schema) !== JSON.stringify(parseJsonObject(appRow.configSchema))
    if (body.schema) {
      const problems = checkSchema(body.schema)
      if (problems.length > 0) throw new HTTPException(422, { message: `schema ${problems[0]}` })
    }
    const schema = body.schema !== undefined ? body.schema : parseJsonObject<Schema>(appRow.configSchema)
    assertValid(schema, body.document)

    if (schemaChanged) {
      await db.update(apps).set({ configSchema: body.schema ? JSON.stringify(body.schema) : null, updatedBy: actor.actorEmail, updatedAt: new Date() }).where(eq(apps.id, id))
    }
    const version = await publishVersion(c, db, appRow, body.document, body.note ?? null, schemaChanged ? { schema_changed: true } : {})
    const saved = await currentConfig(db, id)
    return c.json({ code: 200 as const, data: configView(await loadAppRow(db, id), version, saved.document, saved.row) })
  },
)

app.get(
  '/apps/:appId/config/history',
  describeRoute({
    description: 'Every saved version of the remote config, newest first, documents included. Nothing is ever removed from it.',
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The versions' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const where = eq(configVersions.appId, id)
    const [rows, [total]] = await Promise.all([
      db.select().from(configVersions).where(where).orderBy(desc(configVersions.version)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(configVersions).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({ version: row.version, document: parseJsonObject(row.document) ?? {}, note: row.note, created_at: iso(row.createdAt), created_by: row.createdBy })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

app.post(
  '/apps/:appId/config/history/:version/restore',
  describeRoute({
    description: 'Saves an old version again, as the next version — the history only grows. Validated against the current schema, so a version from before a schema change may be refused with 422.',
    tags: ['Flags and config'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Restored' }, 404: { description: 'Not found' }, 422: { description: 'It does not satisfy the current schema' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const version = Number(c.req.param('version'))
    if (!Number.isInteger(version) || version < 1) throw notFound('Version')
    const db = getDb(c.env)
    const appRow = await loadAppRow(db, id)
    const [row] = await db.select().from(configVersions).where(and(eq(configVersions.appId, id), eq(configVersions.version, version))).limit(1)
    if (!row) throw notFound('Version')
    const document = parseJsonObject(row.document) ?? {}
    assertValid(parseJsonObject<Schema>(appRow.configSchema), document)
    const saved = await publishVersion(c, db, appRow, document, `Restored version ${version}`, { restored_from: version })
    const current = await currentConfig(db, id)
    return c.json({ code: 200 as const, data: configView(appRow, saved, current.document, current.row) })
  },
)

/* ── Messages ──────────────────────────────────────────────────────────────── */

const MESSAGE_STATUSES = ['active', 'scheduled', 'ended', 'all'] as const

const toMessage = (row: MessageRow, seenCount: number, now: Date = new Date()) => ({
  id: row.id,
  app_id: row.appId,
  title: row.title,
  body: row.body,
  severity: row.severity,
  display: row.display,
  scope: row.scope,
  scope_value: row.scope === 'app' ? null : row.scopeValue,
  starts_at: iso(row.startsAt),
  ends_at: iso(row.endsAt),
  status: row.startsAt > now ? 'scheduled' : row.endsAt && row.endsAt <= now ? 'ended' : 'active',
  seen_count: seenCount,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  created_by: row.createdBy,
  updated_by: row.updatedBy,
})

const messageFields = {
  title: requiredText(200),
  body: requiredText(4000),
  severity: v.optional(v.picklist(MESSAGE_SEVERITIES)),
  display: v.optional(v.picklist(MESSAGE_DISPLAYS)),
  starts_at: v.optional(v.nullable(dateInput)),
  ends_at: v.optional(v.nullable(dateInput)),
}

const seenCountSql = sql<number>`(SELECT COUNT(*) FROM message_receipts r WHERE r.message_id = "messages"."id")`

const loadMessage = async (db: Database, id: string) => {
  const [row] = await db.select({ message: messages, seen: seenCountSql }).from(messages).where(eq(messages.id, id)).limit(1)
  if (!row) throw notFound('Message')
  return row
}

const assertWindow = (startsAt: Date, endsAt: Date | null) => {
  if (endsAt && endsAt <= startsAt) throw new HTTPException(400, { message: 'ends_at: must be after starts_at' })
}

app.get(
  '/apps/:appId/messages',
  describeRoute({
    description: "An app's in-app messages, newest first, each with how many installations confirmed showing it. `status` filters by `active` (running now), `scheduled`, `ended` or `all` (default).",
    tags: ['Messages'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The messages', content: jsonContent(listSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ status: v.optional(v.picklist(MESSAGE_STATUSES)), ...paginationQuery })),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const now = new Date()
    const status =
      query.status === 'active'
        ? runningAt(now)
        : query.status === 'scheduled'
          ? gt(messages.startsAt, now)
          : query.status === 'ended'
            ? lte(messages.endsAt, now)
            : undefined
    const where = and(eq(messages.appId, id), status)
    const [rows, [total]] = await Promise.all([
      db.select({ message: messages, seen: seenCountSql }).from(messages).where(where).orderBy(desc(messages.startsAt), desc(messages.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(messages).where(where),
    ])
    return c.json({ code: 200 as const, data: rows.map((row) => toMessage(row.message, Number(row.seen), now)), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

app.post(
  '/apps/:appId/messages',
  describeRoute({
    description: 'Creates an in-app message for the whole app, one channel or one installation. It shows from `starts_at` (default now) until `ends_at` (default: until ended). Requires the `messages` module.',
    tags: ['Messages'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(looseSchema, 201)) }, 404: { description: 'Not found' }, 409: { description: 'The messages module is off' }, 422: { description: 'Unknown channel or installation' }, ...panelErrors },
  }),
  validate('json', v.object({ ...messageFields, ...targetEntries })),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const appRow = await loadAppRow(db, id)
    if (!modulesOf(appRow).includes('messages')) throw new HTTPException(409, { message: 'The messages module is not enabled for this app' })
    const scopeValue = await resolveTarget(db, id, body.scope, body.scope_value)
    const startsAt = body.starts_at ?? new Date()
    assertWindow(startsAt, body.ends_at ?? null)
    const messageId = crypto.randomUUID()
    await db.insert(messages).values({
      id: messageId,
      appId: id,
      title: body.title,
      body: body.body,
      severity: body.severity ?? 'info',
      display: body.display ?? 'banner',
      scope: body.scope,
      scopeValue,
      startsAt,
      endsAt: body.ends_at ?? null,
      createdBy: actor.actorEmail,
      updatedBy: actor.actorEmail,
    })
    const { message } = await loadMessage(db, messageId)
    await recordAudit(db, { event: 'message.created', resourceType: 'app', resourceId: id, ...actor, metadata: { after: toMessage(message, 0) } })
    pushToApp(c, id)
    return c.json({ code: 201 as const, data: toMessage(message, 0) }, 201)
  },
)

app.patch(
  '/messages/:messageId',
  describeRoute({
    description: 'Edits a message — its text, severity, display or window. Ending one now is `ends_at` set to now. Devices that already confirmed it are not asked again.',
    tags: ['Messages'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate(
    'json',
    v.object({
      title: v.optional(requiredText(200)),
      body: v.optional(requiredText(4000)),
      severity: messageFields.severity,
      display: messageFields.display,
      starts_at: v.optional(dateInput),
      ends_at: messageFields.ends_at,
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('messageId'), 'Message')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadMessage(db, id)
    assertWindow(body.starts_at ?? before.message.startsAt, body.ends_at !== undefined ? body.ends_at : before.message.endsAt)
    await db
      .update(messages)
      .set({
        ...(body.title !== undefined && { title: body.title }),
        ...(body.body !== undefined && { body: body.body }),
        ...(body.severity !== undefined && { severity: body.severity }),
        ...(body.display !== undefined && { display: body.display }),
        ...(body.starts_at !== undefined && { startsAt: body.starts_at }),
        ...(body.ends_at !== undefined && { endsAt: body.ends_at }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, id))
    const after = await loadMessage(db, id)
    const beforeView = toMessage(before.message, Number(before.seen))
    const afterView = toMessage(after.message, Number(after.seen))
    await recordAudit(db, { event: 'message.updated', resourceType: 'app', resourceId: before.message.appId, ...actor, metadata: { message_id: id, ...diff(beforeView, afterView) } })
    pushToApp(c, before.message.appId)
    return c.json({ code: 200 as const, data: afterView })
  },
)

app.delete(
  '/messages/:messageId',
  describeRoute({
    description: 'Deletes a message and its confirmations. To stop showing one while keeping its record, end it instead.',
    tags: ['Messages'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('messageId'), 'Message')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadMessage(db, id)
    await db.delete(messages).where(eq(messages.id, id))
    await recordAudit(db, { event: 'message.deleted', resourceType: 'app', resourceId: before.message.appId, ...actor, metadata: { before: toMessage(before.message, Number(before.seen)) } })
    pushToApp(c, before.message.appId)
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

app.get(
  '/messages/:messageId/receipts',
  describeRoute({
    description: 'The installations that confirmed showing a message, newest first.',
    tags: ['Messages'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The confirmations' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('messageId'), 'Message')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    await loadMessage(db, id)
    const where = eq(messageReceipts.messageId, id)
    const [rows, [total]] = await Promise.all([
      db
        .select({ installationId: messageReceipts.installationId, seenAt: messageReceipts.seenAt, alias: installations.alias, hostname: installations.hostname, deviceId: installations.deviceId })
        .from(messageReceipts)
        .leftJoin(installations, eq(installations.id, messageReceipts.installationId))
        .where(where)
        .orderBy(desc(messageReceipts.seenAt), asc(messageReceipts.installationId))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(messageReceipts).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({ installation_id: row.installationId, alias: row.alias, hostname: row.hostname, device_id: row.deviceId, seen_at: iso(row.seenAt) })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

export default app
