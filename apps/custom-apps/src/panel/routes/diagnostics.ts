import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import { Hono } from 'hono'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, crashGroups, crashReports, installations, logEntries } from '@/db/schema'
import type { AppEnv } from '@/env'
import { CRASH_STATUSES, LOG_LEVELS, TELEMETRY } from '@/lib/config'
import { iso, parseJsonObject } from '@/lib/json'
import { dateInput, paginationQuery, searchQuery } from '@/lib/validation'
import { validate } from '@/lib/validate'
import { getActorContext, recordAudit } from '@/services/audit'
import { assertId, dataSchema, jsonContent, likeTerm, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * What went wrong on the devices: crash groups and their reports, and remote logs.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

/* ── Crashes ───────────────────────────────────────────────────────────────── */

type CrashGroupRow = typeof crashGroups.$inferSelect

/** Installations among the reports still kept, which is what "affected" can honestly mean. */
const affectedSql = sql<number>`(SELECT COUNT(DISTINCT r.installation_id) FROM crash_reports r WHERE r.group_id = "crash_groups"."id")`

const toCrashGroup = (row: CrashGroupRow, affected: number) => ({
  id: row.id,
  app_id: row.appId,
  signature: row.signature,
  app_version: row.appVersion || null,
  title: row.title,
  status: row.status,
  occurrences: row.occurrences,
  affected_installations: affected,
  first_seen_at: iso(row.firstSeenAt),
  last_seen_at: iso(row.lastSeenAt),
  resolved_at: iso(row.resolvedAt),
  resolved_by: row.resolvedBy,
})

const loadApp = async (db: Database, id: string) => {
  const [row] = await db.select({ id: apps.id }).from(apps).where(eq(apps.id, id)).limit(1)
  if (!row) throw notFound('App')
}

const loadGroup = async (db: Database, id: string) => {
  const [row] = await db.select({ group: crashGroups, affected: affectedSql }).from(crashGroups).where(eq(crashGroups.id, id)).limit(1)
  if (!row) throw notFound('Crash')
  return row
}

app.get(
  '/apps/:appId/crashes',
  describeRoute({
    description: `An app's crashes, grouped by stack signature and version, most recently seen first. Counts are kept for good; the reports behind them for ${TELEMETRY.rawRetentionDays} days, so \`affected_installations\` counts those.`,
    tags: ['Crashes and logs'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The crash groups', content: jsonContent(listSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate(
    'query',
    v.object({
      status: v.optional(v.picklist(CRASH_STATUSES)),
      app_version: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
      search: searchQuery,
      ...paginationQuery,
    }),
  ),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const query = c.req.valid('query')
    const { limit, offset } = page(query)
    const db = getDb(c.env)
    await loadApp(db, id)
    const where = and(
      eq(crashGroups.appId, id),
      query.status ? eq(crashGroups.status, query.status) : undefined,
      query.app_version !== undefined ? eq(crashGroups.appVersion, query.app_version) : undefined,
      query.search ? sql`${crashGroups.title} LIKE ${likeTerm(query.search)} ESCAPE '\\'` : undefined,
    )
    const [rows, [total]] = await Promise.all([
      db.select({ group: crashGroups, affected: affectedSql }).from(crashGroups).where(where).orderBy(desc(crashGroups.lastSeenAt), desc(crashGroups.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(crashGroups).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map((row) => toCrashGroup(row.group, Number(row.affected))),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

app.get(
  '/crashes/:crashId',
  describeRoute({
    description: 'One crash group.',
    tags: ['Crashes and logs'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The group', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('crashId'), 'Crash')
    const row = await loadGroup(getDb(c.env), id)
    return c.json({ code: 200 as const, data: toCrashGroup(row.group, Number(row.affected)) })
  },
)

app.get(
  '/crashes/:crashId/reports',
  describeRoute({
    description: `The reports of one crash group, newest first, stack and context included. Kept ${TELEMETRY.rawRetentionDays} days.`,
    tags: ['Crashes and logs'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The reports' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object(paginationQuery)),
  async (c) => {
    const id = assertId(c.req.param('crashId'), 'Crash')
    const { limit, offset } = page(c.req.valid('query'))
    const db = getDb(c.env)
    await loadGroup(db, id)
    const where = eq(crashReports.groupId, id)
    const [rows, [total]] = await Promise.all([
      db
        .select({ report: crashReports, alias: installations.alias, hostname: installations.hostname })
        .from(crashReports)
        .leftJoin(installations, eq(installations.id, crashReports.installationId))
        .where(where)
        .orderBy(desc(crashReports.occurredAt), desc(crashReports.reportId))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)` }).from(crashReports).where(where),
    ])
    return c.json({
      code: 200 as const,
      data: rows.map(({ report, alias, hostname }) => ({
        id: report.reportId,
        installation_id: report.installationId,
        installation_alias: alias,
        installation_hostname: hostname,
        app_version: report.appVersion,
        kind: report.kind,
        message: report.message,
        stack: report.stack,
        context: parseJsonObject(report.context),
        occurred_at: new Date(report.occurredAt).toISOString(),
        received_at: iso(report.receivedAt),
      })),
      pagination: { limit, offset, total: Number(total?.count ?? 0) },
    })
  },
)

app.patch(
  '/crashes/:crashId',
  describeRoute({
    description: 'Marks a crash group `resolved` (a new report after now reopens it), `ignored` (it keeps counting, quietly) or `open` again.',
    tags: ['Crashes and logs'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('json', v.object({ status: v.picklist(CRASH_STATUSES) })),
  async (c) => {
    const id = assertId(c.req.param('crashId'), 'Crash')
    const { status } = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadGroup(db, id)
    if (before.group.status !== status) {
      const resolved = status === 'resolved'
      await db
        .update(crashGroups)
        .set({ status, resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? actor.actorEmail : null })
        .where(eq(crashGroups.id, id))
      await recordAudit(db, {
        event: 'crash.status_changed',
        resourceType: 'app',
        resourceId: before.group.appId,
        ...actor,
        metadata: { crash_id: id, title: before.group.title, before: { status: before.group.status }, after: { status } },
      })
    }
    const after = await loadGroup(db, id)
    return c.json({ code: 200 as const, data: toCrashGroup(after.group, Number(after.affected)) })
  },
)

/* ── Logs ──────────────────────────────────────────────────────────────────── */

const logQuery = v.object({
  /** The least severe level to include: `warning` lists warnings, errors and fatals. */
  level: v.optional(v.picklist(LOG_LEVELS)),
  search: searchQuery,
  from: v.optional(dateInput),
  to: v.optional(dateInput),
  ...paginationQuery,
})

const logsFor = async (db: Database, scope: SQL | undefined, query: v.InferOutput<typeof logQuery>) => {
  const { limit, offset } = page(query)
  const where = and(
    scope,
    query.level ? gte(logEntries.severity, LOG_LEVELS.indexOf(query.level)) : undefined,
    query.search ? sql`(${logEntries.message} LIKE ${likeTerm(query.search)} ESCAPE '\\' OR ${logEntries.target} LIKE ${likeTerm(query.search)} ESCAPE '\\')` : undefined,
    query.from ? gte(logEntries.occurredAt, query.from.getTime()) : undefined,
    query.to ? lte(logEntries.occurredAt, query.to.getTime()) : undefined,
  )
  const [rows, [total]] = await Promise.all([
    db
      .select({ entry: logEntries, alias: installations.alias, hostname: installations.hostname })
      .from(logEntries)
      .leftJoin(installations, eq(installations.id, logEntries.installationId))
      .where(where)
      .orderBy(desc(logEntries.occurredAt), desc(logEntries.entryId))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(logEntries).where(where),
  ])
  return {
    data: rows.map(({ entry, alias, hostname }) => ({
      id: entry.entryId,
      installation_id: entry.installationId,
      installation_alias: alias,
      installation_hostname: hostname,
      level: entry.level,
      message: entry.message,
      target: entry.target,
      context: parseJsonObject(entry.context),
      occurred_at: new Date(entry.occurredAt).toISOString(),
      received_at: iso(entry.receivedAt),
    })),
    pagination: { limit, offset, total: Number(total?.count ?? 0) },
  }
}

app.get(
  '/apps/:appId/logs',
  describeRoute({
    description: `Remote logs from every installation of an app, newest first. \`level\` is the least severe level to include. Kept ${TELEMETRY.rawRetentionDays} days.`,
    tags: ['Crashes and logs'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The entries' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', v.object({ ...logQuery.entries, installation_id: v.optional(v.pipe(v.string(), v.uuid())) })),
  async (c) => {
    const id = assertId(c.req.param('appId'), 'App')
    const query = c.req.valid('query')
    const db = getDb(c.env)
    await loadApp(db, id)
    const scope = and(eq(logEntries.appId, id), query.installation_id ? eq(logEntries.installationId, query.installation_id) : undefined)
    return c.json({ code: 200 as const, ...(await logsFor(db, scope, query)) })
  },
)

app.get(
  '/installations/:installationId/logs',
  describeRoute({
    description: `One installation's remote logs, newest first. Kept ${TELEMETRY.rawRetentionDays} days.`,
    tags: ['Crashes and logs'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The entries' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  validate('query', logQuery),
  async (c) => {
    const id = assertId(c.req.param('installationId'), 'Installation')
    const db = getDb(c.env)
    const [row] = await db.select({ id: installations.id }).from(installations).where(eq(installations.id, id)).limit(1)
    if (!row) throw notFound('Installation')
    return c.json({ code: 200 as const, ...(await logsFor(db, eq(logEntries.installationId, id), c.req.valid('query'))) })
  },
)

export default app
