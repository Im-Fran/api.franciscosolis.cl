import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { alertRules, alerts, apps, installations } from '@/db/schema'
import type { AppEnv } from '@/env'
import { ALERT_KINDS, ALERT_STATUSES, ALERTS, type AlertKind } from '@/lib/config'
import { dateInput, paginationQuery, requiredText } from '@/lib/validation'
import { readOptionalJson, validate } from '@/lib/validate'
import { alertSelection, toAlert, toRule, type RuleRow } from '@/services/alerts'
import { diff, getActorContext, recordAudit } from '@/services/audit'
import { assertId, dataSchema, jsonContent, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * Alert rules and the alerts they raise. The evaluation itself is the cron's (`services/alerts.ts`);
 * these routes define what it watches and let a person acknowledge or close what it found.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

/** What `threshold` means per kind, and its bounds. */
const THRESHOLDS: Record<AlertKind, { min: number; max: number; unit: string }> = {
  installation_offline: { min: 1, max: 7 * 24 * 60, unit: 'minutes offline' },
  cpu_high: { min: 1, max: 100, unit: 'percent' },
  memory_high: { min: 1, max: 100, unit: 'percent' },
  crash_spike: { min: 1, max: 100_000, unit: 'crash reports' },
  error_log_spike: { min: 1, max: 1_000_000, unit: 'error entries' },
  enrollment_spike: { min: 1, max: 100_000, unit: 'new installations' },
  release_rollbacks: { min: 1, max: 100_000, unit: 'rollbacks reported' },
}

const windowInput = v.pipe(v.number(), v.integer(), v.minValue(5), v.maxValue(24 * 60))

const checkThreshold = (kind: AlertKind, threshold: number) => {
  const bounds = THRESHOLDS[kind]
  if (threshold < bounds.min || threshold > bounds.max) {
    throw new HTTPException(400, { message: `threshold: for ${kind} it is ${bounds.unit}, between ${bounds.min} and ${bounds.max}` })
  }
}

const openCountSql = sql<number>`(SELECT COUNT(*) FROM alerts x WHERE x.rule_id = "alert_rules"."id" AND x.status != 'resolved')`

const loadRule = async (db: Database, id: string) => {
  const [row] = await db
    .select({ rule: alertRules, appName: apps.name, open: openCountSql })
    .from(alertRules)
    .leftJoin(apps, eq(apps.id, alertRules.appId))
    .where(eq(alertRules.id, id))
    .limit(1)
  if (!row) throw notFound('Alert rule')
  return row
}

const ruleView = (row: { rule: RuleRow; appName: string | null; open: number }) => toRule(row.rule, row.appName, Number(row.open))

app.get(
  '/alert-rules',
  describeRoute({
    description: 'Every alert rule, global ones (no app) first, each with its open alerts.',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The rules', content: jsonContent(dataSchema(v.array(looseSchema))) }, ...panelErrors },
  }),
  validate('query', v.object({ app_id: v.optional(v.pipe(v.string(), v.uuid())) })),
  async (c) => {
    const { app_id: appId } = c.req.valid('query')
    const rows = await getDb(c.env)
      .select({ rule: alertRules, appName: apps.name, open: openCountSql })
      .from(alertRules)
      .leftJoin(apps, eq(apps.id, alertRules.appId))
      .where(appId ? eq(alertRules.appId, appId) : undefined)
      .orderBy(sql`${alertRules.appId} IS NOT NULL`, asc(apps.name), asc(alertRules.name))
    return c.json({ code: 200 as const, data: rows.map(ruleView) })
  },
)

app.post(
  '/alert-rules',
  describeRoute({
    description: `Creates a rule, on one app or (no \`app_id\`) on every app. \`threshold\` means, per kind: ${Object.entries(THRESHOLDS).map(([kind, bounds]) => `\`${kind}\` ${bounds.unit}`).join(', ')}. \`window_minutes\` is what a sustained value or a count is measured over (not used by \`installation_offline\`). The account creating it is the one notified, through the notification centre — in the bell, by push and by email as its preferences say.`,
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(looseSchema, 201)) }, 422: { description: 'Unknown app' }, ...panelErrors },
  }),
  validate(
    'json',
    v.object({
      app_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
      name: requiredText(120),
      kind: v.picklist(ALERT_KINDS),
      threshold: v.pipe(v.number(), v.finite()),
      window_minutes: v.optional(windowInput),
      enabled: v.optional(v.boolean()),
    }),
  ),
  async (c) => {
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const admin = c.get('admin')
    const db = getDb(c.env)
    checkThreshold(body.kind, body.threshold)
    if (body.app_id) {
      const [row] = await db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.app_id)).limit(1)
      if (!row) throw new HTTPException(422, { message: 'app_id does not name an existing app' })
    }
    const [count] = await db.select({ count: sql<number>`COUNT(*)` }).from(alertRules)
    if (Number(count?.count ?? 0) >= ALERTS.maxRules) throw new HTTPException(409, { message: `There are at most ${ALERTS.maxRules} alert rules` })
    const id = crypto.randomUUID()
    await db.insert(alertRules).values({
      id,
      appId: body.app_id ?? null,
      name: body.name,
      kind: body.kind,
      threshold: body.threshold,
      windowMinutes: body.window_minutes ?? 15,
      enabled: body.enabled ?? true,
      notifyUserId: admin.id,
      notifyEmail: admin.email,
      createdBy: actor.actorEmail,
      updatedBy: actor.actorEmail,
    })
    const created = ruleView(await loadRule(db, id))
    await recordAudit(db, { event: 'alert_rule.created', resourceType: 'alert_rule', resourceId: id, ...actor, metadata: { after: created } })
    return c.json({ code: 201 as const, data: created }, 201)
  },
)

app.patch(
  '/alert-rules/:ruleId',
  describeRoute({
    description: 'Edits a rule. `silenced_until` stops its notifications until then — alerts still open and resolve, quietly; `null` lifts it. `notify_me: true` makes the editor the one notified.',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate(
    'json',
    v.object({
      name: v.optional(requiredText(120)),
      threshold: v.optional(v.pipe(v.number(), v.finite())),
      window_minutes: v.optional(windowInput),
      enabled: v.optional(v.boolean()),
      silenced_until: v.optional(v.nullable(dateInput)),
      notify_me: v.optional(v.literal(true)),
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('ruleId'), 'Alert rule')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const admin = c.get('admin')
    const db = getDb(c.env)
    const before = await loadRule(db, id)
    if (body.threshold !== undefined) checkThreshold(before.rule.kind as AlertKind, body.threshold)
    await db
      .update(alertRules)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.threshold !== undefined && { threshold: body.threshold }),
        ...(body.window_minutes !== undefined && { windowMinutes: body.window_minutes }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.silenced_until !== undefined && { silencedUntil: body.silenced_until }),
        ...(body.notify_me && { notifyUserId: admin.id, notifyEmail: admin.email }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(alertRules.id, id))
    const after = ruleView(await loadRule(db, id))
    await recordAudit(db, { event: 'alert_rule.updated', resourceType: 'alert_rule', resourceId: id, ...actor, metadata: diff(ruleView(before), after) })
    return c.json({ code: 200 as const, data: after })
  },
)

app.delete(
  '/alert-rules/:ruleId',
  describeRoute({
    description: 'Deletes a rule and every alert it raised. To stop it while keeping its history, disable it instead.',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('ruleId'), 'Alert rule')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = ruleView(await loadRule(db, id))
    await db.delete(alertRules).where(eq(alertRules.id, id))
    await recordAudit(db, { event: 'alert_rule.deleted', resourceType: 'alert_rule', resourceId: id, ...actor, metadata: { before } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

/* ── Alerts ────────────────────────────────────────────────────────────────── */

const selectAlerts = (db: Database) =>
  db
    .select(alertSelection)
    .from(alerts)
    .innerJoin(alertRules, eq(alertRules.id, alerts.ruleId))
    .leftJoin(apps, eq(apps.id, alerts.appId))
    .leftJoin(installations, eq(installations.id, alerts.installationId))

const loadAlert = async (db: Database, id: string) => {
  const [row] = await selectAlerts(db).where(eq(alerts.id, id)).limit(1)
  if (!row) throw notFound('Alert')
  return row
}

app.get(
  '/alerts',
  describeRoute({
    description: 'Alerts, newest first. `status=unresolved` lists open and acknowledged ones together — the inbox.',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The alerts', content: jsonContent(listSchema(looseSchema)) }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      status: v.optional(v.picklist([...ALERT_STATUSES, 'unresolved'])),
      app_id: v.optional(v.pipe(v.string(), v.uuid())),
      rule_id: v.optional(v.pipe(v.string(), v.uuid())),
      installation_id: v.optional(v.pipe(v.string(), v.uuid())),
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    const where = and(
      query.status === 'unresolved' ? inArray(alerts.status, ['open', 'acknowledged']) : query.status ? eq(alerts.status, query.status) : undefined,
      query.app_id ? eq(alerts.appId, query.app_id) : undefined,
      query.rule_id ? eq(alerts.ruleId, query.rule_id) : undefined,
      query.installation_id ? eq(alerts.installationId, query.installation_id) : undefined,
    )
    const [rows, [total]] = await Promise.all([
      selectAlerts(db).where(where).orderBy(desc(alerts.lastTriggeredAt), desc(alerts.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(alerts).where(where),
    ])
    return c.json({ code: 200 as const, data: rows.map(toAlert), pagination: { limit, offset, total: Number(total?.count ?? 0) } })
  },
)

app.get(
  '/alerts/:alertId',
  describeRoute({
    description: 'One alert.',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The alert', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('alertId'), 'Alert')
    return c.json({ code: 200 as const, data: toAlert(await loadAlert(getDb(c.env), id)) })
  },
)

app.post(
  '/alerts/:alertId/ack',
  describeRoute({
    description: 'Acknowledges an open alert: somebody is on it. It stays unresolved until its condition clears.',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Acknowledged', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Already resolved' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('alertId'), 'Alert')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadAlert(db, id)
    if (before.alert.status === 'resolved') throw new HTTPException(409, { message: 'This alert is already resolved' })
    if (before.alert.status === 'open') {
      await db.update(alerts).set({ status: 'acknowledged', acknowledgedAt: new Date(), acknowledgedBy: actor.actorEmail }).where(and(eq(alerts.id, id), eq(alerts.status, 'open')))
      await recordAudit(db, { event: 'alert.acknowledged', resourceType: 'alert', resourceId: id, ...actor, metadata: { rule_id: before.alert.ruleId, subject: before.alert.subject } })
    }
    return c.json({ code: 200 as const, data: toAlert(await loadAlert(db, id)) })
  },
)

app.post(
  '/alerts/:alertId/resolve',
  describeRoute({
    description: 'Closes an alert by hand. If its condition still holds, the next evaluation reopens it — this is for an alert whose cause is gone but which the rule cannot see clear (a decommissioned kiosk, say).',
    tags: ['Alerts'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Resolved', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('alertId'), 'Alert')
    const { note } = await readOptionalJson(c, v.object({ note: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(500)))) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadAlert(db, id)
    if (before.alert.status !== 'resolved') {
      await db.update(alerts).set({ status: 'resolved', resolvedAt: new Date(), resolvedBy: actor.actorEmail }).where(eq(alerts.id, id))
      await recordAudit(db, { event: 'alert.resolved', resourceType: 'alert', resourceId: id, ...actor, metadata: { rule_id: before.alert.ruleId, subject: before.alert.subject, note: note ?? null } })
    }
    return c.json({ code: 200 as const, data: toAlert(await loadAlert(db, id)) })
  },
)

export default app

