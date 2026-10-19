import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { alertRules, apps, appKeys, auditLogs, companies, installations } from '@/db/schema'
import type { AppEnv } from '@/env'
import { APP_KINDS, APP_MODULES, APP_STATES, GRACE_MAX_DAYS, INSTALLATION_STATUSES, LOG_LEVELS, PRESENCE_MODES, ROLLUP, TELEMETRY, HEARTBEAT } from '@/lib/config'
import { randomToken, TOKEN_PREFIXES } from '@/lib/tokens'
import { zonedDay } from '@/lib/time'
import {
  booleanQuery,
  dateInput,
  dayInput,
  hostnameInput,
  operatingHoursSchema,
  optionalText,
  optionalUrl,
  paginationQuery,
  requiredText,
  searchQuery,
} from '@/lib/validation'
import { readOptionalJson, validate } from '@/lib/validate'
import { openCountSql, retireRuleAlerts, snapshotAppName, toRule } from '@/services/alerts'
import { buildSdk } from '@/services/apps'
import { auditRow, diff, getActorContext, recordAudit } from '@/services/audit'
import { appUsage, usageHeatmap } from '@/services/series'
import { parsePublicKey } from '@/services/releases'
import { toApp, toAppKey, toAppSummary, toInstallationSummary, type AppRow } from '@/services/serialize'
import { syncApp } from '@/services/socket'
import {
  assertId,
  connectedSql,
  dataSchema,
  jsonContent,
  likeTerm,
  listSchema,
  notFound,
  nowSeconds,
  page,
  panelErrors,
} from '@/panel/shared'

/**
 * Apps, their keys, their kill switch, and the per-app views of their fleet.
 */
const app = new Hono<AppEnv>()

const appSchema = v.looseObject({ id: v.string(), name: v.string(), state: v.string() })

const intervalInput = v.pipe(v.number(), v.integer(), v.minValue(HEARTBEAT.min), v.maxValue(HEARTBEAT.max))
const modulesInput = v.pipe(v.array(v.picklist(APP_MODULES)), v.transform((modules) => [...new Set(modules)].sort()))

const createSchema = v.object({
  company_id: v.pipe(v.string(), v.uuid()),
  name: requiredText(120),
  kind: v.picklist(APP_KINDS),
  description: optionalText(2000),
  domain: v.optional(v.nullable(hostnameInput)),
  repository_url: optionalUrl,
  heartbeat_interval_seconds: v.optional(intervalInput),
  operating_hours: v.optional(v.nullable(operatingHoursSchema)),
  modules: v.optional(modulesInput),
})

const patchSchema = v.object({
  company_id: v.optional(v.pipe(v.string(), v.uuid())),
  name: v.optional(requiredText(120)),
  kind: v.optional(v.picklist(APP_KINDS)),
  description: optionalText(2000),
  domain: v.optional(v.nullable(hostnameInput)),
  repository_url: optionalUrl,
  presence_mode: v.optional(v.picklist(PRESENCE_MODES)),
  heartbeat_interval_seconds: v.optional(intervalInput),
  operating_hours: v.optional(v.nullable(operatingHoursSchema)),
  modules: v.optional(modulesInput),
  log_level: v.optional(v.picklist(LOG_LEVELS)),
  screenshots_enabled: v.optional(v.boolean()),
  release_public_key: v.optional(
    v.nullable(v.pipe(v.string(), v.trim(), v.check((value) => parsePublicKey(value) !== null, 'must be a raw 32-byte Ed25519 public key, base64'))),
  ),
  update_health_timeout_seconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400))),
  update_max_failures: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  rollout_pause_rollback_percent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  rollout_pause_crash_percent: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
})

/**
 * The kill switch. A grace period needs its end — the countdown the devices show — and a contract
 * caps it at `GRACE_MAX_DAYS`; when it runs out the cron suspends the app.
 */
const stateSchema = v.pipe(
  v.object({
    state: v.picklist(APP_STATES),
    message: optionalText(1000),
    until: v.optional(v.nullable(dateInput)),
  }),
  v.forward(
    v.check((body) => body.state !== 'grace' || (body.until != null && body.until.getTime() > Date.now()), 'a grace period needs an `until` in the future'),
    ['until'],
  ),
  v.forward(
    v.check(
      (body) => body.state !== 'grace' || body.until == null || body.until.getTime() <= Date.now() + GRACE_MAX_DAYS * 86_400_000,
      `a grace period lasts at most ${GRACE_MAX_DAYS} days`,
    ),
    ['until'],
  ),
)

/** Installation counts per app, and the company it belongs to, as subqueries on one select. */
const appSelect = (now: number) => ({
  app: apps,
  companyId: companies.id,
  companyLegalName: companies.legalName,
  companyTradeName: companies.tradeName,
  installations: sql<number>`(SELECT COUNT(*) FROM installations i WHERE i.app_id = "apps"."id")`,
  connected: sql<number>`(SELECT COUNT(*) FROM installations i JOIN apps a ON a.id = i.app_id WHERE i.app_id = "apps"."id" AND ${sql.raw(connectedSql(now))})`,
  needsReview: sql<number>`(SELECT COUNT(*) FROM installations i WHERE i.app_id = "apps"."id" AND i.needs_review = 1 AND i.status = 'active')`,
})

type AppSelection = Awaited<ReturnType<typeof selectApps>>[number]
const selectApps = (db: Database, now: number) =>
  db.select(appSelect(now)).from(apps).innerJoin(companies, eq(companies.id, apps.companyId))

const countsOf = (row: AppSelection) => ({
  installations: Number(row.installations),
  connected: Number(row.connected),
  needsReview: Number(row.needsReview),
})

const companyOf = (row: AppSelection) => ({ id: row.companyId, legalName: row.companyLegalName, tradeName: row.companyTradeName })

const loadAppRow = async (db: Database, id: string): Promise<AppRow> => {
  const [row] = await db.select().from(apps).where(eq(apps.id, id)).limit(1)
  if (!row) throw notFound('App')
  return row
}

const loadApp = async (db: Database, id: string, ingestBaseUrl: string) => {
  const [row] = await selectApps(db, nowSeconds()).where(eq(apps.id, id)).limit(1)
  if (!row) throw notFound('App')
  return toApp(row.app, companyOf(row), countsOf(row), ingestBaseUrl)
}

const requireCompany = async (db: Database, id: string) => {
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)).limit(1)
  if (!row) throw new HTTPException(422, { message: 'company_id does not name an existing company' })
}

/** A new app key row, ready to insert. */
const newKey = (appId: string, label: string | null, createdBy: string) => ({
  id: crypto.randomUUID(),
  appId,
  key: randomToken(TOKEN_PREFIXES.appKey, 24),
  label,
  status: 'active',
  createdBy,
})

app.get(
  '/apps',
  describeRoute({
    description: 'Every app, alphabetically, with its installation counts and its company.',
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The apps', content: jsonContent(listSchema(appSchema)) }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      company_id: v.optional(v.pipe(v.string(), v.uuid())),
      state: v.optional(v.picklist(APP_STATES)),
      kind: v.optional(v.picklist(APP_KINDS)),
      search: searchQuery,
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const conditions = [
      query.company_id ? eq(apps.companyId, query.company_id) : undefined,
      query.state ? eq(apps.state, query.state) : undefined,
      query.kind ? eq(apps.kind, query.kind) : undefined,
      query.search ? sql`(${apps.name} LIKE ${likeTerm(query.search)} ESCAPE '\\' OR ${apps.domain} LIKE ${likeTerm(query.search)} ESCAPE '\\')` : undefined,
    ].filter((condition) => condition !== undefined)
    const where = conditions.length ? and(...conditions) : undefined
    const [rows, [total]] = await Promise.all([
      selectApps(db, nowSeconds()).where(where).orderBy(asc(apps.name)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(apps).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => ({
        ...toAppSummary(row.app, countsOf(row)),
        company: { id: row.companyId, legal_name: row.companyLegalName, trade_name: row.companyTradeName },
      })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

app.post(
  '/apps',
  describeRoute({
    description:
      'Creates an app for a company, together with its first app key — the response carries it under `key`, ready to paste into the app. Presence is always on; `modules` turns on metrics and usage events.',
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(appSchema, 201)) }, 422: { description: 'Unknown company' }, ...panelErrors },
  }),
  validate('json', createSchema),
  async (c) => {
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    await requireCompany(db, body.company_id)

    const id = crypto.randomUUID()
    const key = newKey(id, 'Initial key', actor.actorEmail)
    await db.batch([
      db.insert(apps).values({
        id,
        companyId: body.company_id,
        name: body.name,
        kind: body.kind,
        description: body.description ?? null,
        domain: body.domain ?? null,
        repositoryUrl: body.repository_url ?? null,
        heartbeatIntervalSeconds: body.heartbeat_interval_seconds ?? HEARTBEAT.default,
        operatingHours: body.operating_hours ? JSON.stringify(body.operating_hours) : null,
        modules: JSON.stringify(body.modules ?? []),
        // Whoever turns support on hears about the tickets, until somebody takes them over.
        ...((body.modules ?? []).includes('support') && { supportAssigneeId: actor.actorId, supportAssigneeEmail: actor.actorEmail }),
        createdBy: actor.actorEmail,
        updatedBy: actor.actorEmail,
      }),
      db.insert(appKeys).values(key),
      db.insert(auditLogs).values(auditRow({ event: 'app_key.created', resourceType: 'app', resourceId: id, ...actor, metadata: { key_id: key.id } })),
    ])
    const created = await loadApp(db, id, c.env.INGEST_PUBLIC_URL)
    const [keyRow] = await db.select().from(appKeys).where(eq(appKeys.id, key.id))
    await recordAudit(db, { event: 'app.created', resourceType: 'app', resourceId: id, ...actor, metadata: { after: created } })
    return c.json({ code: 201 as const, data: { ...created, key: toAppKey(keyRow!) } }, 201)
  },
)

app.get(
  '/apps/:appId',
  describeRoute({
    description: 'One app, with its counts, its company and the ingest URLs a client app is configured with.',
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The app', content: jsonContent(dataSchema(appSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    return c.json({ code: 200 as const, data: await loadApp(getDb(c.env), id, c.env.INGEST_PUBLIC_URL) })
  },
)

app.patch(
  '/apps/:appId',
  describeRoute({
    description:
      'Edits an app. Presence settings and modules reach the fleet without a release: the interval on the next heartbeat answer, a module on the next request that uses it (a disabled one answers 403).',
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(appSchema)) }, 404: { description: 'Not found' }, 422: { description: 'Unknown company' }, ...panelErrors },
  }),
  validate('json', patchSchema),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadApp(db, id, c.env.INGEST_PUBLIC_URL)
    if (body.company_id !== undefined) {
      await requireCompany(db, body.company_id)
    }
    const takesSupport = body.modules?.includes('support') && !before.modules.includes('support') && !before.support_assignee_email
    await db
      .update(apps)
      .set({
        ...(body.company_id !== undefined && { companyId: body.company_id }),
        ...(body.name !== undefined && { name: body.name }),
        ...(body.kind !== undefined && { kind: body.kind }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.domain !== undefined && { domain: body.domain }),
        ...(body.repository_url !== undefined && { repositoryUrl: body.repository_url }),
        ...(body.presence_mode !== undefined && { presenceMode: body.presence_mode }),
        ...(body.heartbeat_interval_seconds !== undefined && { heartbeatIntervalSeconds: body.heartbeat_interval_seconds }),
        ...(body.operating_hours !== undefined && { operatingHours: body.operating_hours ? JSON.stringify(body.operating_hours) : null }),
        ...(body.modules !== undefined && { modules: JSON.stringify(body.modules) }),
        ...(body.log_level !== undefined && { logLevel: body.log_level }),
        ...(body.screenshots_enabled !== undefined && { screenshotsEnabled: body.screenshots_enabled }),
        ...(takesSupport && { supportAssigneeId: actor.actorId, supportAssigneeEmail: actor.actorEmail }),
        ...(body.release_public_key !== undefined && { releasePublicKey: body.release_public_key }),
        ...(body.update_health_timeout_seconds !== undefined && { updateHealthTimeoutSeconds: body.update_health_timeout_seconds }),
        ...(body.update_max_failures !== undefined && { updateMaxFailures: body.update_max_failures }),
        ...(body.rollout_pause_rollback_percent !== undefined && { rolloutPauseRollbackPercent: body.rollout_pause_rollback_percent }),
        ...(body.rollout_pause_crash_percent !== undefined && { rolloutPauseCrashPercent: body.rollout_pause_crash_percent }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(apps.id, id))
    const after = await loadApp(db, id, c.env.INGEST_PUBLIC_URL)
    await recordAudit(db, { event: 'app.updated', resourceType: 'app', resourceId: id, ...actor, metadata: diff(before, after) })
    // Presence settings, modules and the log level are all in what a device is told.
    c.executionCtx.waitUntil(syncApp(c.env, id))
    return c.json({ code: 200 as const, data: after })
  },
)

app.delete(
  '/apps/:appId',
  describeRoute({
    description:
      'Deletes an app and its keys. Refused with a 409 while it has installations, revoked ones included: they carry its history. Its alert rules go with it, each recorded in the audit trail as `alert_rule.deleted` with `cascade: "app.deleted"`; their alerts stay as history, resolved, and keep the app\'s name in `app_name`.',
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, 409: { description: 'The app has installations' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadApp(db, id, c.env.INGEST_PUBLIC_URL)
    if (before.installation_count > 0) {
      throw new HTTPException(409, { message: `This app has ${before.installation_count} installation(s) and cannot be deleted` })
    }
    // The app's own alert rules go with it (a cascade); their alerts stay, as history, and keep the
    // app's name — every alert filed under the app, a contract rule's included.
    const rules = await db.select({ rule: alertRules, open: openCountSql }).from(alertRules).where(eq(alertRules.appId, id))
    const ruleViews = rules.map((row) => toRule(row.rule, before.name, Number(row.open)))
    await snapshotAppName(db, id)
    await retireRuleAlerts(db, rules.map((row) => row.rule), actor.actorEmail)
    await db.delete(apps).where(eq(apps.id, id))
    // Each rule that went with it is deleted as surely as one deleted by hand, and the trail says so,
    // ahead of the app's own row. Like `recordAudit`, a failed write is logged, not answered.
    const statements = [
      ...ruleViews.map((view) =>
        db.insert(auditLogs).values(auditRow({ event: 'alert_rule.deleted', resourceType: 'alert_rule', resourceId: view.id, ...actor, metadata: { before: view, cascade: 'app.deleted', app_id: id } })),
      ),
      db.insert(auditLogs).values(auditRow({ event: 'app.deleted', resourceType: 'app', resourceId: id, ...actor, metadata: { before } })),
    ]
    try {
      await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]])
    } catch (error) {
      console.error('failed to write audit log', 'app.deleted', error)
    }
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

app.put(
  '/apps/:appId/status',
  describeRoute({
    description:
      `The kill switch. Every installation reads it on its next heartbeat or \`/status\` — at once, if it holds a socket: \`active\` runs normally, \`grace\` keeps working with a countdown to \`until\` (required, at most ${GRACE_MAX_DAYS} days ahead; the app is suspended automatically when it passes), \`maintenance\` shows a notice until \`until\`, \`suspended\` shows \`message\` and stops. \`until\` and \`message\` are cleared when not sent. An installation can override it individually.`,
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(appSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', stateSchema),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadAppRow(db, id)
    await db
      .update(apps)
      .set({ state: body.state, stateMessage: body.message ?? null, stateUntil: body.until ?? null, updatedBy: actor.actorEmail, updatedAt: new Date() })
      .where(eq(apps.id, id))
    const after = await loadApp(db, id, c.env.INGEST_PUBLIC_URL)
    await recordAudit(db, {
      event: 'app.state_changed',
      resourceType: 'app',
      resourceId: id,
      ...actor,
      metadata: {
        before: { state: before.state, message: before.stateMessage, until: before.stateUntil?.toISOString() ?? null },
        after: { state: after.state, message: after.state_message, until: after.state_until },
      },
    })
    c.executionCtx.waitUntil(syncApp(c.env, id))
    return c.json({ code: 200 as const, data: after })
  },
)

/* ── Keys ──────────────────────────────────────────────────────────────────── */

const keySchema = v.looseObject({ id: v.string(), key: v.string(), status: v.string() })

const loadKey = async (db: Database, appId: string, keyId: string) => {
  const [row] = await db.select().from(appKeys).where(and(eq(appKeys.id, keyId), eq(appKeys.appId, appId))).limit(1)
  if (!row) throw notFound('Key')
  return row
}

app.get(
  '/apps/:appId/keys',
  describeRoute({
    description: "An app's keys, newest first. Keys are public by design — they ship inside every build — so they are shown in full.",
    tags: ['App keys'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The keys', content: jsonContent(dataSchema(v.array(keySchema))) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const rows = await db.select().from(appKeys).where(eq(appKeys.appId, id)).orderBy(desc(appKeys.createdAt), desc(appKeys.id))
    return c.json({ code: 200 as const, data: rows.map(toAppKey) })
  },
)

app.post(
  '/apps/:appId/keys',
  describeRoute({
    description: 'Adds a key. Several can be active at once, which is how a key is replaced without a gap: add, ship, revoke the old one.',
    tags: ['App keys'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(keySchema, 201)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const { label } = await readOptionalJson(c, v.object({ label: optionalText(120) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    await loadAppRow(db, id)
    const key = newKey(id, label ?? null, actor.actorEmail)
    await db.insert(appKeys).values(key)
    await recordAudit(db, { event: 'app_key.created', resourceType: 'app', resourceId: id, ...actor, metadata: { key_id: key.id } })
    return c.json({ code: 201 as const, data: toAppKey(await loadKey(db, id, key.id)) }, 201)
  },
)

app.post(
  '/apps/:appId/keys/:keyId/rotate',
  describeRoute({
    description:
      'Replaces a key: issues a new one with the same label and revokes the old at once. Installations already enrolled keep working — a key only gates *new* enrollments — so the only thing that breaks is enrolling a new device with a build that still carries the old key.',
    tags: ['App keys'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'The new key and the revoked one' }, 404: { description: 'Not found' }, 409: { description: 'The key is already revoked' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const keyId = assertId(c.req.param('keyId'), 'Key')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const previous = await loadKey(db, id, keyId)
    if (previous.status !== 'active') {
      throw new HTTPException(409, { message: 'This key is already revoked' })
    }
    const replacement = newKey(id, previous.label, actor.actorEmail)
    await db.batch([
      db.insert(appKeys).values(replacement),
      db.update(appKeys).set({ status: 'revoked', revokedAt: new Date(), replacedBy: replacement.id }).where(eq(appKeys.id, keyId)),
      db.insert(auditLogs).values(
        auditRow({ event: 'app_key.rotated', resourceType: 'app', resourceId: id, ...actor, metadata: { key_id: keyId, replaced_by: replacement.id } }),
      ),
    ])
    return c.json(
      { code: 201 as const, data: { key: toAppKey(await loadKey(db, id, replacement.id)), previous: toAppKey(await loadKey(db, id, keyId)) } },
      201,
    )
  },
)

app.post(
  '/apps/:appId/keys/:keyId/revoke',
  describeRoute({
    description: 'Revokes a key. New enrollments with it are refused; installations already enrolled are not affected — revoke those one by one.',
    tags: ['App keys'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Revoked', content: jsonContent(dataSchema(keySchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const keyId = assertId(c.req.param('keyId'), 'Key')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const key = await loadKey(db, id, keyId)
    if (key.status === 'active') {
      await db.update(appKeys).set({ status: 'revoked', revokedAt: new Date() }).where(eq(appKeys.id, keyId))
      await recordAudit(db, { event: 'app_key.revoked', resourceType: 'app', resourceId: id, ...actor, metadata: { key_id: keyId } })
    }
    return c.json({ code: 200 as const, data: toAppKey(await loadKey(db, id, keyId)) })
  },
)

app.get(
  '/apps/:appId/sdk',
  describeRoute({
    description:
      'Where a website loads the SDK from, and the Subresource Integrity hash of the script as it is generated right now. The hash changes whenever the key, the interval or the modules do, so a page pinning it has to be updated with them.',
    tags: ['Apps'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The embed details' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const row = await loadAppRow(getDb(c.env), id)
    const sdk = await buildSdk(c.env, row)
    const appView = toApp(row, null, {}, c.env.INGEST_PUBLIC_URL)
    return c.json({
      code: 200 as const,
      data: { url: appView.ingest.sdk_url, integrity: sdk?.integrity ?? null, modules: appView.modules, available: sdk !== null },
    })
  },
)

/* ── The fleet of one app ──────────────────────────────────────────────────── */

app.get(
  '/apps/:appId/installations',
  describeRoute({
    description: "An app's installations, most recently seen first.",
    tags: ['Installations'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The installations' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      status: v.optional(v.picklist(INSTALLATION_STATUSES)),
      needs_review: booleanQuery,
      connected: booleanQuery,
      search: searchQuery,
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const appRow = await loadAppRow(db, id)
    const now = new Date()

    const conditions = [
      eq(installations.appId, id),
      query.status ? eq(installations.status, query.status) : undefined,
      query.needs_review !== undefined ? eq(installations.needsReview, query.needs_review) : undefined,
      query.search
        ? sql`(${installations.alias} LIKE ${likeTerm(query.search)} ESCAPE '\\' OR ${installations.hostname} LIKE ${likeTerm(query.search)} ESCAPE '\\' OR ${installations.deviceId} LIKE ${likeTerm(query.search)} ESCAPE '\\')`
        : undefined,
      query.connected !== undefined
        ? query.connected
          ? sql.raw(connectedSql(Math.floor(now.getTime() / 1000), '"installations"', String(appRow.heartbeatIntervalSeconds)))
          : sql`NOT ${sql.raw(connectedSql(Math.floor(now.getTime() / 1000), '"installations"', String(appRow.heartbeatIntervalSeconds)))}`
        : undefined,
    ].filter((condition) => condition !== undefined)
    const where = and(...conditions)

    const [rows, [total]] = await Promise.all([
      db.select().from(installations).where(where).orderBy(sql`${installations.lastSeenAt} IS NULL`, desc(installations.lastSeenAt), asc(installations.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(installations).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => toInstallationSummary(row, appRow.heartbeatIntervalSeconds, now)),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

/** `from`/`to` days for a usage query, defaulting to the last 30 days ending today in Santiago. */
const usageRange = (query: { from?: string; to?: string }) => {
  const today = zonedDay(new Date(), ROLLUP.timeZone)
  const to = query.to ?? today
  const fromDefault = new Date(Date.parse(`${to}T00:00:00Z`) - (TELEMETRY.rawRetentionDays - 1) * 86_400_000).toISOString().slice(0, 10)
  const from = query.from ?? fromDefault
  if (from > to) {
    throw new HTTPException(400, { message: '`from` must not be after `to`' })
  }
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000) {
    throw new HTTPException(400, { message: 'A usage range is at most a year' })
  }
  return { from, to }
}

app.get(
  '/apps/:appId/usage',
  describeRoute({
    description:
      "The app's fleet-wide usage per day (Santiago time): seconds connected and in use, installations that reported, events. Every day of the range is present, zero when nothing ran. Defaults to the last 30 days.",
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'One entry per day' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ from: v.optional(dayInput), to: v.optional(dayInput) })),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    await loadAppRow(getDb(c.env), id)
    const { from, to } = usageRange(c.req.valid('query'))
    return c.json({ code: 200 as const, data: await appUsage(c.env.DB, id, from, to) })
  },
)

app.get(
  '/apps/:appId/usage/heatmap',
  describeRoute({
    description:
      'Average use per weekday and hour over the last 30 days, in Santiago time: `cells[weekday][hour]` with Monday as 0, in seconds of use per hour summed over the fleet (or one installation). The lowest cells are where maintenance windows go.',
    tags: ['Telemetry'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The heatmap' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ installation_id: v.optional(v.pipe(v.string(), v.uuid())) })),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    await loadAppRow(getDb(c.env), id)
    return c.json({ code: 200 as const, data: await usageHeatmap(c.env.DB, id, c.req.valid('query').installation_id ?? null) })
  },
)

export default app
