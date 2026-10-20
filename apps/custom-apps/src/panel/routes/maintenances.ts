import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeRoute } from 'hono-openapi'
import * as v from 'valibot'
import { getDb, type Database } from '@/db/client'
import { apps, auditLogs, installations, maintenances, maintenanceWindows, releases } from '@/db/schema'
import type { AppEnv } from '@/env'
import { MAINTENANCE_KINDS, MAINTENANCE_STATUSES, MAINTENANCE_WINDOW_SOURCES, MAINTENANCES, type MaintenanceStatus } from '@/lib/config'
import { iso, parseJsonArray, parseJsonObject } from '@/lib/json'
import { overlaps, securityWindow, suggestWindows, type OperatingHours } from '@/lib/maintenance-windows'
import { dateInput, optionalText, paginationQuery, requiredText } from '@/lib/validation'
import { readOptionalJson, validate } from '@/lib/validate'
import { auditRow, diff, getActorContext, recordAudit } from '@/services/audit'
import { securityPatchDaysFor, todayIn } from '@/services/contracts'
import {
  assertNotPaused,
  cancelMaintenance,
  finish,
  includedInstallations,
  markScheduled,
  onReleaseLine,
  sendRequest,
  serializeMaintenances,
  toWindow,
  viewOf,
  windowsOf,
  type MaintenanceRow,
  type WindowRow,
} from '@/services/maintenances'
import type { AppRow } from '@/services/serialize'
import { usageHeatmap } from '@/services/series'
import { assertId, dataSchema, jsonContent, listSchema, notFound, page, panelErrors } from '@/panel/shared'

/**
 * Scheduled maintenances from the panel's side: preparing one (what, how long, which release, which
 * installations), the windows it is offered in — with suggestions from the usage heatmap — sending it
 * to the client for approval, scheduling a security patch, and closing one by hand. What happens on its
 * own afterwards (resends, applying without an answer, the reminder, the start and the evaluation) is
 * the cron's, in `services/maintenances.ts`.
 */
const app = new Hono<AppEnv>()

const looseSchema = v.looseObject({ id: v.string() })

/** Statuses a maintenance can be edited in: being prepared, or offered again after nobody answered. */
const EDITABLE: MaintenanceStatus[] = ['draft', 'no_response']

const estimatedInput = v.pipe(v.number(), v.integer(), v.minValue(MAINTENANCES.minEstimatedMinutes), v.maxValue(MAINTENANCES.maxEstimatedMinutes))
const installationIdsInput = v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.maxLength(MAINTENANCES.maxInstallations), v.transform((ids) => [...new Set(ids)]))

const fields = {
  kind: v.picklist(MAINTENANCE_KINDS),
  title: requiredText(MAINTENANCES.maxTitleLength),
  description: requiredText(MAINTENANCES.maxDescriptionLength),
  estimated_minutes: estimatedInput,
  release_id: v.nullable(v.pipe(v.string(), v.uuid())),
  installation_ids: installationIdsInput,
}

const createSchema = v.object({
  kind: v.optional(fields.kind, 'normal'),
  title: fields.title,
  description: fields.description,
  estimated_minutes: fields.estimated_minutes,
  release_id: v.optional(fields.release_id, null),
  installation_ids: v.optional(fields.installation_ids, []),
})

const patchSchema = v.object({
  kind: v.optional(fields.kind),
  title: v.optional(fields.title),
  description: v.optional(fields.description),
  estimated_minutes: v.optional(fields.estimated_minutes),
  release_id: v.optional(fields.release_id),
  installation_ids: v.optional(fields.installation_ids),
})

const loadApp = async (db: Database, id: string): Promise<AppRow> => {
  const [row] = await db.select().from(apps).where(eq(apps.id, id)).limit(1)
  if (!row) throw notFound('App')
  return row
}

const loadRow = async (db: Database, id: string): Promise<MaintenanceRow> => {
  const [row] = await db.select().from(maintenances).where(eq(maintenances.id, id)).limit(1)
  if (!row) throw notFound('Maintenance')
  return row
}

const view = async (db: Database, id: string) => {
  const data = await viewOf(db, id)
  if (!data) throw notFound('Maintenance')
  return data
}

const assertEditable = (row: MaintenanceRow) => {
  if (!EDITABLE.includes(row.status as MaintenanceStatus)) {
    throw new HTTPException(409, { message: `A ${row.status} maintenance cannot be edited; cancel it and plan a new one instead` })
  }
}

/** A release attached to a maintenance: one of the same app, not paused or withdrawn. */
const assertRelease = async (db: Database, appId: string, releaseId: string) => {
  const [row] = await db.select().from(releases).where(eq(releases.id, releaseId)).limit(1)
  if (!row || row.appId !== appId) throw new HTTPException(422, { message: 'release_id must be a release of the same app' })
  if (row.status !== 'draft' && row.status !== 'published') throw new HTTPException(422, { message: `A ${row.status} release cannot be installed by a maintenance; attach a draft or a published one` })
  return row
}

/** Named installations must be active installations of the app — and, with a release, on its line, or it could never reach them. */
const assertInstallations = async (db: Database, appId: string, ids: string[], release: typeof releases.$inferSelect | null) => {
  if (ids.length === 0) return
  const rows = await db.select().from(installations).where(and(eq(installations.appId, appId), eq(installations.status, 'active'), inArray(installations.id, ids)))
  if (rows.length !== ids.length) throw new HTTPException(422, { message: 'installation_ids must all be active installations of this app' })
  if (release) {
    const off = rows.filter((row) => !onReleaseLine(release, row))
    if (off.length > 0) {
      throw new HTTPException(422, { message: `${off.length} of the installations are not on the release's line (${release.channel}/${release.platform}/${release.arch}), so it could never reach them` })
    }
  }
}

/* ── Maintenances ──────────────────────────────────────────────────────────── */

/** `upcoming` is scheduled or running, `pending` waits on the client; the rest are statuses as they are. */
const STATUS_FILTERS = [...MAINTENANCE_STATUSES, 'upcoming', 'pending'] as const

const listFilters = v.object({
  status: v.optional(v.picklist(STATUS_FILTERS)),
  kind: v.optional(v.picklist(MAINTENANCE_KINDS)),
  app_id: v.optional(v.pipe(v.string(), v.uuid())),
  company_id: v.optional(v.pipe(v.string(), v.uuid())),
  from: v.optional(dateInput),
  to: v.optional(dateInput),
  ...paginationQuery,
})

const statusCondition = (status: (typeof STATUS_FILTERS)[number]) => {
  if (status === 'upcoming') return inArray(maintenances.status, ['scheduled', 'in_progress'])
  if (status === 'pending') return eq(maintenances.status, 'pending_approval')
  return eq(maintenances.status, status)
}

const list = async (c: Context<AppEnv>, query: v.InferOutput<typeof listFilters>) => {
  const { limit, offset } = page(query)
  const db = getDb(c.env)
  const conditions: SQL[] = []
  if (query.status) conditions.push(statusCondition(query.status))
  if (query.kind) conditions.push(eq(maintenances.kind, query.kind))
  if (query.app_id) conditions.push(eq(maintenances.appId, query.app_id))
  if (query.company_id) conditions.push(eq(maintenances.companyId, query.company_id))
  if (query.from || query.to) {
    // For a calendar: the window it runs in once it has one, any window offered before that.
    const from = Math.floor((query.from?.getTime() ?? 0) / 1000)
    const to = Math.floor((query.to?.getTime() ?? 253_402_300_799_000) / 1000)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM maintenance_windows w WHERE w.maintenance_id = "maintenances"."id" AND ("maintenances"."chosen_window_id" IS NULL OR w.id = "maintenances"."chosen_window_id") AND w.starts_at < ${to} AND w.ends_at > ${from})`,
    )
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined
  const [rows, [total]] = await Promise.all([
    db.select().from(maintenances).where(where).orderBy(desc(maintenances.createdAt), sql`${maintenances}.rowid DESC`).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(maintenances).where(where),
  ])
  return { code: 200 as const, data: await serializeMaintenances(db, rows), pagination: { limit, offset, total: Number(total?.count ?? 0) } }
}

const listDoc = (scope: string) =>
  describeRoute({
    description: `Maintenances ${scope}, newest first. \`status\` takes any maintenance status, or \`upcoming\` (scheduled or in progress) and \`pending\` (waiting on the client); \`from\`/\`to\` keep those whose window — the chosen one, or any offered before one is chosen — overlaps the range, for a calendar.`,
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The maintenances', content: jsonContent(listSchema(looseSchema)) }, ...panelErrors },
  })

app.get('/maintenances', listDoc('across every app'), validate('query', listFilters), async (c) => c.json(await list(c, c.req.valid('query'))))

app.get('/apps/:appId/maintenances', listDoc('of one app'), validate('query', v.omit(listFilters, ['app_id'])), async (c) => {
  const appId = assertId(c.req.param('appId'), 'App')
  await loadApp(getDb(c.env), appId)
  return c.json(await list(c, { ...c.req.valid('query'), app_id: appId }))
})

app.post(
  '/apps/:appId/maintenances',
  describeRoute({
    description:
      "Plans a maintenance of an app, as a draft: `title` and `description` (what will be done and what the client will notice — the client reads both), `estimated_minutes`, optionally a `release_id` of the app (a draft or published release, installed on the included installations during the window) and `installation_ids` (empty for every active installation). `kind: 'security'` is a security patch, scheduled with `/schedule` instead of sent for approval.",
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Created', content: jsonContent(dataSchema(looseSchema, 201)) }, 404: { description: 'Not found' }, 422: { description: 'Unknown release or installation' }, ...panelErrors },
  }),
  validate('json', createSchema),
  async (c) => {
    const appId = assertId(c.req.param('appId'), 'App')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const admin = c.get('admin')
    const db = getDb(c.env)
    const appRow = await loadApp(db, appId)
    const release = body.release_id ? await assertRelease(db, appId, body.release_id) : null
    await assertInstallations(db, appId, body.installation_ids, release)
    const id = crypto.randomUUID()
    await db.insert(maintenances).values({
      id,
      appId,
      companyId: appRow.companyId,
      kind: body.kind,
      title: body.title,
      description: body.description,
      estimatedMinutes: body.estimated_minutes,
      releaseId: body.release_id,
      installationIds: JSON.stringify(body.installation_ids),
      createdById: admin.id,
      createdBy: actor.actorEmail,
      updatedBy: actor.actorEmail,
    })
    const data = await view(db, id)
    await recordAudit(db, { event: 'maintenance.created', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: appId, after: data } })
    return c.json({ code: 201 as const, data }, 201)
  },
)

app.get(
  '/maintenances/:maintenanceId',
  describeRoute({
    description:
      'One maintenance: what, how long, the release and installations, the windows offered and the one chosen, who the request went to and until when its links work, how the client answered, and — once it ran — what it did (`result_detail`: the installations put in maintenance, the update targets, why it failed) and the work log entry it filed.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The maintenance', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    return c.json({ code: 200 as const, data: await view(getDb(c.env), id) })
  },
)

app.patch(
  '/maintenances/:maintenanceId',
  describeRoute({
    description: 'Edits a maintenance while it is a draft (or after nobody answered, `no_response`). A shorter `estimated_minutes` is always fine; a longer one must still fit every window offered.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Updated', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not editable any more' }, 422: { description: 'Unknown release or installation, or a window too short' }, ...panelErrors },
  }),
  validate('json', patchSchema),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadRow(db, id)
    assertEditable(before)
    const releaseId = body.release_id !== undefined ? body.release_id : before.releaseId
    const release = releaseId ? await assertRelease(db, before.appId, releaseId) : null
    if (body.installation_ids !== undefined || body.release_id !== undefined) {
      await assertInstallations(db, before.appId, body.installation_ids ?? parseJsonArray<string>(before.installationIds), release)
    }
    if (body.estimated_minutes !== undefined) {
      const windows = (await windowsOf(db, [id])).get(id) ?? []
      if (windows.some((window) => window.endsAt.getTime() - window.startsAt.getTime() < body.estimated_minutes! * 60_000)) {
        throw new HTTPException(422, { message: 'estimated_minutes: some offered windows are shorter than that; lengthen or remove them first' })
      }
    }
    const beforeView = await view(db, id)
    await db
      .update(maintenances)
      .set({
        ...(body.kind !== undefined && { kind: body.kind }),
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.estimated_minutes !== undefined && { estimatedMinutes: body.estimated_minutes }),
        ...(body.release_id !== undefined && { releaseId: body.release_id }),
        ...(body.installation_ids !== undefined && { installationIds: JSON.stringify(body.installation_ids) }),
        updatedBy: actor.actorEmail,
        updatedAt: new Date(),
      })
      .where(eq(maintenances.id, id))
    const data = await view(db, id)
    await recordAudit(db, { event: 'maintenance.updated', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: before.appId, ...diff(beforeView, data) } })
    return c.json({ code: 200 as const, data })
  },
)

app.delete(
  '/maintenances/:maintenanceId',
  describeRoute({
    description: 'Deletes a draft or a cancelled maintenance, with its windows and links. Anything that was scheduled, ran or is waiting on the client is history: cancel it instead.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Deleted' }, 404: { description: 'Not found' }, 409: { description: 'Not a draft or cancelled' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const before = await loadRow(db, id)
    if (before.status !== 'draft' && before.status !== 'cancelled') throw new HTTPException(409, { message: 'Only a draft or a cancelled maintenance can be deleted' })
    const beforeView = await view(db, id)
    await db.delete(maintenances).where(eq(maintenances.id, id))
    await recordAudit(db, { event: 'maintenance.deleted', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: before.appId, before: beforeView } })
    return c.json({ code: 200 as const, data: { id, deleted: true } })
  },
)

/* ── Windows ───────────────────────────────────────────────────────────────── */

const windowBody = {
  starts_at: dateInput,
  ends_at: dateInput,
  position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAINTENANCES.maxWindows)),
}

/** A window must start in the future, last at least the estimated duration and overlap no other window of the maintenance. */
const checkWindow = (row: MaintenanceRow, others: WindowRow[], startsAt: Date, endsAt: Date) => {
  if (endsAt <= startsAt) throw new HTTPException(400, { message: 'ends_at: must be after starts_at' })
  if (startsAt.getTime() <= Date.now()) throw new HTTPException(422, { message: 'starts_at: a window must start in the future' })
  if (endsAt.getTime() - startsAt.getTime() < row.estimatedMinutes * 60_000) {
    throw new HTTPException(422, { message: `A window must last at least the estimated ${row.estimatedMinutes} minutes` })
  }
  const interval = { start: startsAt.getTime(), end: endsAt.getTime() }
  if (others.some((other) => overlaps(interval, { start: other.startsAt.getTime(), end: other.endsAt.getTime() }))) {
    throw new HTTPException(409, { message: 'That window overlaps another window of this maintenance' })
  }
}

/** Puts `windowId` at `position` and renumbers the rest 0, 1, 2… in their current order. */
const reorder = async (db: Database, windows: WindowRow[], windowId: string, position: number) => {
  const ordered = windows.filter((window) => window.id !== windowId)
  const moved = windows.find((window) => window.id === windowId)
  if (moved) ordered.splice(Math.min(position, ordered.length), 0, moved)
  const updates = ordered.map((window, index) => db.update(maintenanceWindows).set({ position: index }).where(eq(maintenanceWindows.id, window.id)))
  const [first, ...rest] = updates
  if (first) await db.batch([first, ...rest])
}

const windowsResponse = async (db: Database, row: MaintenanceRow) => ((await windowsOf(db, [row.id])).get(row.id) ?? []).map((window) => toWindow(window, row.chosenWindowId))

app.get(
  '/maintenances/:maintenanceId/windows',
  describeRoute({
    description: 'The windows a maintenance is offered in, in the order the client sees them.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The windows', content: jsonContent(dataSchema(v.array(looseSchema))) }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const db = getDb(c.env)
    return c.json({ code: 200 as const, data: await windowsResponse(db, await loadRow(db, id)) })
  },
)

app.post(
  '/maintenances/:maintenanceId/windows',
  describeRoute({
    description: `Offers a window (instants; the panel works in Santiago time). At least the estimated duration long, starting in the future, overlapping no other window of the maintenance; at most ${MAINTENANCES.maxWindows}. \`ends_at\` defaults to \`starts_at\` plus the estimated duration, \`position\` to last, \`source\` to \`manual\` — \`suggested\` when saving one of \`/windows/suggest\`. Only while the maintenance is editable.`,
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 201: { description: 'Added', content: jsonContent(dataSchema(v.array(looseSchema), 201)) }, 404: { description: 'Not found' }, 409: { description: 'Not editable, overlapping, or too many windows' }, 422: { description: 'In the past or too short' }, ...panelErrors },
  }),
  validate('json', v.object({ starts_at: windowBody.starts_at, ends_at: v.optional(windowBody.ends_at), position: v.optional(windowBody.position), source: v.optional(v.picklist(MAINTENANCE_WINDOW_SOURCES), 'manual') })),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    assertEditable(row)
    const windows = (await windowsOf(db, [id])).get(id) ?? []
    if (windows.length >= MAINTENANCES.maxWindows) throw new HTTPException(409, { message: `A maintenance offers at most ${MAINTENANCES.maxWindows} windows` })
    const endsAt = body.ends_at ?? new Date(body.starts_at.getTime() + row.estimatedMinutes * 60_000)
    checkWindow(row, windows, body.starts_at, endsAt)
    const windowId = crypto.randomUUID()
    await db.insert(maintenanceWindows).values({ id: windowId, maintenanceId: id, startsAt: body.starts_at, endsAt, source: body.source, position: windows.length })
    if (body.position !== undefined && body.position < windows.length) {
      await reorder(db, (await windowsOf(db, [id])).get(id) ?? [], windowId, body.position)
    }
    await recordAudit(db, { event: 'maintenance.window_added', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: row.appId, window_id: windowId, starts_at: iso(body.starts_at), ends_at: iso(endsAt), source: body.source } })
    return c.json({ code: 201 as const, data: await windowsResponse(db, row) }, 201)
  },
)

const loadWindow = async (db: Database, maintenanceId: string, windowId: string) => {
  const [row] = await db.select().from(maintenanceWindows).where(and(eq(maintenanceWindows.id, windowId), eq(maintenanceWindows.maintenanceId, maintenanceId))).limit(1)
  if (!row) throw notFound('Window')
  return row
}

app.patch(
  '/maintenances/:maintenanceId/windows/:windowId',
  describeRoute({
    description: 'Moves a window, or reorders it: `position` puts it there and renumbers the others in their order. Only while the maintenance is editable.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The windows after the change', content: jsonContent(dataSchema(v.array(looseSchema))) }, 404: { description: 'Not found' }, 409: { description: 'Not editable, or overlapping' }, 422: { description: 'In the past or too short' }, ...panelErrors },
  }),
  validate('json', v.object({ starts_at: v.optional(windowBody.starts_at), ends_at: v.optional(windowBody.ends_at), position: v.optional(windowBody.position) })),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const windowId = assertId(c.req.param('windowId'), 'Window')
    const body = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    assertEditable(row)
    const before = await loadWindow(db, id, windowId)
    const windows = (await windowsOf(db, [id])).get(id) ?? []
    if (body.starts_at !== undefined || body.ends_at !== undefined) {
      const startsAt = body.starts_at ?? before.startsAt
      const endsAt = body.ends_at ?? (body.starts_at ? new Date(body.starts_at.getTime() + (before.endsAt.getTime() - before.startsAt.getTime())) : before.endsAt)
      checkWindow(row, windows.filter((window) => window.id !== windowId), startsAt, endsAt)
      await db.update(maintenanceWindows).set({ startsAt, endsAt }).where(eq(maintenanceWindows.id, windowId))
    }
    if (body.position !== undefined) await reorder(db, windows, windowId, body.position)
    const after = await loadWindow(db, id, windowId)
    await recordAudit(db, {
      event: 'maintenance.window_updated',
      resourceType: 'maintenance',
      resourceId: id,
      ...actor,
      metadata: { app_id: row.appId, window_id: windowId, ...diff(toWindow(before, null), toWindow(after, null)) },
    })
    return c.json({ code: 200 as const, data: await windowsResponse(db, row) })
  },
)

app.delete(
  '/maintenances/:maintenanceId/windows/:windowId',
  describeRoute({
    description: 'Removes a window from the offer. Only while the maintenance is editable.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The windows left', content: jsonContent(dataSchema(v.array(looseSchema))) }, 404: { description: 'Not found' }, 409: { description: 'Not editable' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const windowId = assertId(c.req.param('windowId'), 'Window')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    assertEditable(row)
    const before = await loadWindow(db, id, windowId)
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, windowId))
    const left = (await windowsOf(db, [id])).get(id) ?? []
    if (left[0]) await reorder(db, left, left[0].id, 0)
    await recordAudit(db, { event: 'maintenance.window_removed', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: row.appId, before: toWindow(before, null) } })
    return c.json({ code: 200 as const, data: await windowsResponse(db, row) })
  },
)

/** The heatmap of what a maintenance includes: the named installations, or the whole app. */
const heatmapFor = async (c: Context<AppEnv>, row: MaintenanceRow, now: Date) => {
  const named = parseJsonArray<string>(row.installationIds)
  return usageHeatmap(c.env.DB, row.appId, named.length > 0 ? named : null, now)
}

const suggest = async (c: Context<AppEnv>) => {
  const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
  const db = getDb(c.env)
  const row = await loadRow(db, id)
  const appRow = await loadApp(db, row.appId)
  const now = new Date()
  const [heatmap, windows] = await Promise.all([heatmapFor(c, row, now), windowsOf(db, [id])])
  const operatingHours = parseJsonObject<OperatingHours>(appRow.operatingHours)
  const existing = (windows.get(id) ?? []).map((window) => ({ start: Math.floor(window.startsAt.getTime() / 1000), end: Math.floor(window.endsAt.getTime() / 1000) }))
  const picked = suggestWindows({ heatmap: heatmap.cells, operatingHours, now: Math.floor(now.getTime() / 1000), estimatedMinutes: row.estimatedMinutes, existing })
  return c.json({
    code: 200 as const,
    data: {
      timezone: heatmap.timezone,
      estimated_minutes: row.estimatedMinutes,
      /** The hours each block is scored on: the duration rounded up to whole hours. */
      scored_hours: Math.ceil(row.estimatedMinutes / 60),
      min_lead_hours: MAINTENANCES.minLeadHours,
      days: MAINTENANCES.suggestDays,
      heatmap_days: heatmap.days,
      operating_hours_applied: operatingHours !== null,
      suggestions: picked.map((candidate, index) => ({
        rank: index + 1,
        starts_at: new Date(candidate.start * 1000).toISOString(),
        ends_at: new Date(candidate.end * 1000).toISOString(),
        /** Seconds of use an average such stretch saw over the last 30 days (the heatmap's cells, summed). Zero is unused. */
        expected_active_seconds: candidate.score,
      })),
    },
  })
}

const suggestDoc = describeRoute({
  description: `Suggests where to put the maintenance, without saving anything: the ${MAINTENANCES.suggestCount} least-used blocks of its estimated duration over the next ${MAINTENANCES.suggestDays} days, each starting at least ${MAINTENANCES.minLeadHours} hours from now, on the hour, none overlapping another or a window already offered, best first (ties to the earliest). Scored on the usage heatmap of the last 30 days — of the included installations when it names some — over the duration rounded up to whole hours. When the app declares operating hours, a block lies entirely inside them: a device may be off outside them. Save the ones you want with \`POST /windows\` and \`source: 'suggested'\`.`,
  tags: ['Maintenances'],
  security: [{ bearerAuth: [] }],
  responses: { 200: { description: 'The suggestions' }, 404: { description: 'Not found' }, ...panelErrors },
})

app.get('/maintenances/:maintenanceId/windows/suggest', suggestDoc, suggest)
app.post('/maintenances/:maintenanceId/windows/suggest', suggestDoc, suggest)

/* ── Sending, scheduling, closing ──────────────────────────────────────────── */

const assertReleaseStillUsable = async (db: Database, row: MaintenanceRow) => {
  if (row.releaseId) await assertRelease(db, row.appId, row.releaseId)
}

app.post(
  '/maintenances/:maintenanceId/send',
  describeRoute({
    description: `Emails the approval request to the client's \`maintenance_approver\` contacts (the primary contact when there is none, anyone with an address when there is no primary either), each with a link of their own to the approval page, valid until the first window starts. Every window offered must still be in the future. Moves it to \`pending_approval\`; without an answer it is sent again after ${MAINTENANCES.resendAfterHours} hours and applied ${MAINTENANCES.resendAfterHours} hours after that in the first window still ${MAINTENANCES.minLeadHours} hours away. Not for a security patch (\`/schedule\`), and paused while the app is in grace (unless its contract allows maintenances) or suspended.`,
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'Sent', content: jsonContent(dataSchema(looseSchema)) },
      404: { description: 'Not found' },
      409: { description: 'Not a normal maintenance in an editable state, or the app is paused' },
      422: { description: 'No windows, a window already started, nobody to send it to, or the release cannot be used' },
      502: { description: 'The mail could not be sent to anybody' },
      ...panelErrors,
    },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    if (row.kind === 'security') throw new HTTPException(409, { message: 'A security patch needs no approval: schedule it with /schedule' })
    assertEditable(row)
    await assertNotPaused(db, await loadApp(db, row.appId))
    await assertReleaseStillUsable(db, row)
    const now = new Date()
    const windows = (await windowsOf(db, [id])).get(id) ?? []
    if (windows.some((window) => window.startsAt <= now)) throw new HTTPException(422, { message: 'Some windows already started; move or remove them before sending' })
    const sent = await sendRequest(c.env, db, row, now)
    await recordAudit(db, { event: 'maintenance.sent', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: row.appId, send: sent.send, recipients: sent.delivered, failed: sent.failed, expires_at: iso(sent.expiresAt), windows: windows.length } })
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

app.post(
  '/maintenances/:maintenanceId/resend',
  describeRoute({
    description: 'Sends the approval request again now, with fresh links; every earlier link stops working. Counts as a send: after the second, no answer for 48 hours applies it.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Sent again', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not waiting on the client, or the app is paused' }, 422: { description: 'The first window already started' }, 502: { description: 'The mail could not be sent to anybody' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    if (row.status !== 'pending_approval') throw new HTTPException(409, { message: 'Only a request waiting on the client can be sent again' })
    await assertNotPaused(db, await loadApp(db, row.appId))
    const now = new Date()
    const windows = (await windowsOf(db, [id])).get(id) ?? []
    if (windows.length === 0 || windows.some((window) => window.startsAt <= now)) throw new HTTPException(422, { message: 'A window already started: the request cannot be answered any more' })
    const sent = await sendRequest(c.env, db, row, now)
    await recordAudit(db, { event: 'maintenance.resent', resourceType: 'maintenance', resourceId: id, ...actor, metadata: { app_id: row.appId, send: sent.send, recipients: sent.delivered, failed: sent.failed } })
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

app.post(
  '/maintenances/:maintenanceId/schedule',
  describeRoute({
    description:
      "Schedules a security patch, without approval: its window is the first block of its estimated duration, starting at least two hours from now and within the `security_patch_days` of the contract covering the app (3 without one), in which nobody used the included installations over the last 30 days — or the least used block when there is none — inside the app's operating hours when it declares them. It replaces any window offered, is saved as `suggested`, and the client is emailed the advance notice at once. Paused while the app is in grace (unless its contract allows maintenances) or suspended.",
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Scheduled', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not a security patch in an editable state, or the app is paused' }, 422: { description: 'No block fits, or the release cannot be used' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    if (row.kind !== 'security') throw new HTTPException(409, { message: 'Only a security patch is scheduled without approval; send this one to the client' })
    assertEditable(row)
    const appRow = await loadApp(db, row.appId)
    await assertNotPaused(db, appRow)
    await assertReleaseStillUsable(db, row)
    const now = new Date()
    const days = await securityPatchDaysFor(db, row.appId, todayIn(now))
    const heatmap = await heatmapFor(c, row, now)
    const chosen = securityWindow({ heatmap: heatmap.cells, operatingHours: parseJsonObject<OperatingHours>(appRow.operatingHours), now: Math.floor(now.getTime() / 1000), estimatedMinutes: row.estimatedMinutes, days })
    if (!chosen) throw new HTTPException(422, { message: `No block of ${row.estimatedMinutes} minutes fits the app's operating hours in the next ${days} days` })
    const windowId = crypto.randomUUID()
    await db.batch([
      db.delete(maintenanceWindows).where(eq(maintenanceWindows.maintenanceId, id)),
      db.insert(maintenanceWindows).values({ id: windowId, maintenanceId: id, startsAt: new Date(chosen.start * 1000), endsAt: new Date(chosen.end * 1000), source: 'suggested', position: 0 }),
    ])
    const [window] = await db.select().from(maintenanceWindows).where(eq(maintenanceWindows.id, windowId))
    const updated = await markScheduled(c.env, db, row, window!, 'security', now, { sends: 0, updatedBy: actor.actorEmail })
    if (!updated) throw new HTTPException(409, { message: 'The maintenance changed while saving; reload and try again' })
    await db.insert(auditLogs).values(
      auditRow({
        event: 'maintenance.scheduled',
        resourceType: 'maintenance',
        resourceId: id,
        ...actor,
        metadata: { app_id: row.appId, kind: 'security', security_patch_days: days, window: { id: windowId, starts_at: iso(window!.startsAt), ends_at: iso(window!.endsAt) }, expected_active_seconds: chosen.score },
      }),
    )
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

app.post(
  '/maintenances/:maintenanceId/cancel',
  describeRoute({
    description: 'Cancels a maintenance that has not started (draft, waiting on the client, scheduled, or with no answer): its links stop working and the in-app notice it posted ends. `reason`, when sent, is kept as `cancel_reason`. A maintenance in progress is closed with `/complete` or `/fail`.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Cancelled', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Already started or finished' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const { reason } = await readOptionalJson(c, v.object({ reason: optionalText(500) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    await cancelMaintenance(c.env, db, await loadRow(db, id), { reason: reason ?? null, actor }, new Date())
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

const assertInProgress = (row: MaintenanceRow) => {
  if (row.status !== 'in_progress') throw new HTTPException(409, { message: 'Only a maintenance in progress can be closed' })
}

app.post(
  '/maintenances/:maintenanceId/complete',
  describeRoute({
    description: 'Closes a maintenance in progress as completed, now rather than at its evaluation: the installations leave maintenance, the hours are logged and the client gets the closing email. `note` is kept in `result_detail`.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Completed', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not in progress' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const { note } = await readOptionalJson(c, v.object({ note: optionalText(1000) }))
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    assertInProgress(row)
    if (!(await finish(c.env, db, row, { success: true, note: note ?? null }, actor, new Date()))) throw new HTTPException(409, { message: 'The maintenance changed while saving; reload and try again' })
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

app.post(
  '/maintenances/:maintenanceId/fail',
  describeRoute({
    description: 'Closes a maintenance in progress as failed, with a `note` saying why: the installations leave maintenance, the release (if it carried one) is withdrawn so the devices go back to the version they ran, and the client is told it stayed on the previous version.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'Failed', content: jsonContent(dataSchema(looseSchema)) }, 404: { description: 'Not found' }, 409: { description: 'Not in progress' }, ...panelErrors },
  }),
  validate('json', v.object({ note: requiredText(1000) })),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const { note } = c.req.valid('json')
    const actor = getActorContext(c)
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    assertInProgress(row)
    if (!(await finish(c.env, db, row, { success: false, reason: 'manual', note }, actor, new Date()))) throw new HTTPException(409, { message: 'The maintenance changed while saving; reload and try again' })
    return c.json({ code: 200 as const, data: await view(db, id) })
  },
)

/** The installations a maintenance includes right now, for the detail view's list. */
app.get(
  '/maintenances/:maintenanceId/installations',
  describeRoute({
    description: 'The installations the maintenance includes right now — the ones named, or every active installation of the app — and, with a release, whether each is on its line.',
    tags: ['Maintenances'],
    security: [{ bearerAuth: [] }],
    responses: { 200: { description: 'The installations' }, 404: { description: 'Not found' }, ...panelErrors },
  }),
  async (c) => {
    const id = assertId(c.req.param('maintenanceId'), 'Maintenance')
    const db = getDb(c.env)
    const row = await loadRow(db, id)
    const [included, release] = await Promise.all([
      includedInstallations(db, row),
      row.releaseId ? db.select().from(releases).where(eq(releases.id, row.releaseId)).limit(1).then((rows) => rows[0] ?? null) : Promise.resolve(null),
    ])
    return c.json({
      code: 200 as const,
      data: included
        .sort((a, b) => (a.alias ?? a.hostname ?? a.deviceId).localeCompare(b.alias ?? b.hostname ?? b.deviceId))
        .map((installation) => ({
          id: installation.id,
          alias: installation.alias,
          hostname: installation.hostname,
          device_id: installation.deviceId,
          platform: installation.platform,
          arch: installation.arch,
          channel: installation.channel,
          app_version: installation.appVersion,
          state_override: installation.stateOverride,
          on_release_line: release ? onReleaseLine(release, installation) : null,
        })),
    })
  },
)

export default app
